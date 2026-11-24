// House Lights backend.
//
// - Each house's LIFX token lives only in an environment variable
//   (LIFX_TOKEN_<KEY>) and is never sent to a phone.
// - Family members sign in with a passkey (Face ID / Touch ID). Passkeys are
//   kept by the phone's keychain, so clearing website data or blocking
//   cookies never loses them.
// - Each person can only reach the houses they were invited to. The person
//   who set the app up is the admin and can reach every house.
// - The phone talks to /api/lifx/<house>/…; the server checks access, adds
//   that house's token and forwards a small allow-list of LIFX calls.
// - Schedules (fade on by sunset, fade off at night) are stored here and run by
//   a signed Upstash QStash call to /api/cron/tick every 5 minutes. The lights
//   do the fading themselves, so the timer only has to start each fade.

import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { Receiver, Client as QStash } from '@upstash/qstash';
import { dueEvents, isValidTimeZone, motionRequest } from '../public/shared/schedule-core.js';

const LIFX_API = 'https://api.lifx.com/v1/';
const COOKIE = 'hl_session';
const SESSION_TTL = 90 * 86400;        // stay signed in for 90 days of inactivity
const SESSION_REFRESH = 7 * 86400;     // extend the session at most once a week
const FLOW_TTL = 5 * 60;               // a passkey prompt must finish within 5 minutes
const INVITE_TTL = 7 * 86400;          // invites expire after a week
const SETUP_ATTEMPTS_PER_HOUR = 10;
const MAX_BODY = 256 * 1024;
const MAX_PREFS = 200 * 1024;
const ALGORITHMS = [-7, -8, -257];     // ES256 (what iPhones use), EdDSA, RS256
const TICK_CRON = '*/5 * * * *';      // 288 calls a day, well inside QStash's free plan
const TICK_SCHEDULE_ID = 'house-lights-tick';
const MAX_SCHEDULE_STATES = 800;
const LIFX_BATCH = 50;
const RP_NAME = 'House Lights';

// ---------- small helpers ----------

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => new Uint8Array(Buffer.from(s, 'base64url'));
const randomToken = (bytes = 32) => b64u(crypto.randomBytes(bytes));
const sha = s => crypto.createHash('sha256').update(s).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(sha(String(a)));
  const y = Buffer.from(sha(String(b)));
  return crypto.timingSafeEqual(x, y);
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders },
  });
}

function cookieHeader(token, maxAge, secure) {
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : null,
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

const cleanName = (s, fallback) => {
  const v = typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
  return v || fallback;
};

const titleCase = key => key.split('_').filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');

// LIFX selectors: all, id:…, group_id:…, location_id:…, with optional |zones.
const SELECTOR = /^[A-Za-z0-9_:|,.\-]{1,200}$/;

const EFFECTS = new Set(['move', 'off', 'breathe', 'pulse']);

// The only LIFX calls the app needs. Anything else is refused.
function allowedLifxCall(method, segments) {
  const [a, b, c, d, e] = segments;
  if (a !== 'lights') return false;
  if (method === 'GET') return segments.length === 2 && SELECTOR.test(b);
  if (method === 'PUT' && segments.length === 2) return b === 'states';
  if (method === 'PUT' && segments.length === 3) return SELECTOR.test(b) && c === 'state';
  if (method === 'POST' && segments.length === 4) return SELECTOR.test(b) && c === 'effects' && EFFECTS.has(d) && !e;
  return false;
}

// ---------- the app ----------

export function createApp({ store, env = process.env, fetchImpl = fetch, now = () => Date.now(), verifyCron, timer }) {
  // Checks that a /api/cron/tick request really came from our QStash schedule.
  verifyCron ??= async ({ signature, body, url }) => {
    if (!env.QSTASH_CURRENT_SIGNING_KEY || !env.QSTASH_NEXT_SIGNING_KEY) return false;
    const receiver = new Receiver({
      currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
      nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
      devMode: false,
    });
    try { return await receiver.verify({ signature, body, url }); } catch { return false; }
  };
  // Creates (or updates) the 5-minute QStash schedule that calls the tick.
  timer ??= {
    configured: () => !!env.QSTASH_TOKEN,
    install: destination => new QStash({ token: env.QSTASH_TOKEN, baseUrl: env.QSTASH_URL || undefined }).schedules.create({
      destination, cron: TICK_CRON, scheduleId: TICK_SCHEDULE_ID, method: 'POST',
      body: '{}', headers: { 'Content-Type': 'application/json' }, retries: 1,
    }),
  };

  // Houses come from LIFX_TOKEN_<KEY> environment variables.
  function configuredHouses() {
    const houses = [];
    for (const [name, value] of Object.entries(env)) {
      const m = /^LIFX_TOKEN_([A-Z0-9_]+)$/.exec(name);
      if (m && typeof value === 'string' && value.trim()) {
        houses.push({ key: m[1].toLowerCase(), token: value.trim(), defaultName: titleCase(m[1]) });
      }
    }
    return houses.sort((x, y) => x.key.localeCompare(y.key));
  }

  async function housesWithNames(keys) {
    const all = configuredHouses().filter(h => !keys || keys.includes(h.key));
    return Promise.all(all.map(async h => ({
      key: h.key,
      name: (await store.get(`house:${h.key}:name`)) || h.defaultName,
    })));
  }

  // Only answer on this app's own addresses; passkeys are tied to the domain.
  function siteFor(request) {
    const url = new URL(request.url);
    const allowed = new Set(
      [env.APP_ORIGIN && new URL(env.APP_ORIGIN).host, env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_BRANCH_URL, env.VERCEL_URL]
        .filter(Boolean).map(h => h.toLowerCase()),
    );
    const host = url.host.toLowerCase();
    const local = env.ALLOW_LOCALHOST === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (!allowed.has(host) && !local) throw new HttpError(400, 'unknown_host');
    return { origin: `${url.protocol}//${url.host}`, rpID: url.hostname, secure: url.protocol === 'https:' };
  }

  async function readBody(request) {
    if (request.method === 'GET' || request.method === 'DELETE') return null;
    const type = request.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new HttpError(415, 'json_required');
    const text = await request.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'too_large');
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'bad_json'); }
  }

  // ---- sessions ----

  async function createSession(userId, site) {
    const token = randomToken();
    const id = sha(token);
    await store.set(`session:${id}`, { userId, refreshed: now() }, { ex: SESSION_TTL });
    await store.sadd(`user:${userId}:sessions`, id);
    return { token, cookie: cookieHeader(token, SESSION_TTL, site.secure) };
  }

  async function currentUser(request) {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : readCookie(request, COOKIE);
    if (!token || token.length > 100) return null;
    const id = sha(token);
    const session = await store.get(`session:${id}`);
    if (!session) return null;
    const user = await store.get(`user:${session.userId}`);
    if (!user) { await store.del(`session:${id}`); return null; }
    if (now() - session.refreshed > SESSION_REFRESH * 1000) {
      await store.set(`session:${id}`, { ...session, refreshed: now() }, { ex: SESSION_TTL });
    }
    return { ...user, sessionId: id };
  }

  const canReach = (user, key) => user.admin || (user.houses || []).includes(key);

  function requireUser(user) {
    if (!user) throw new HttpError(401, 'signed_out');
    return user;
  }
  function requireAdmin(user) {
    requireUser(user);
    if (!user.admin) throw new HttpError(403, 'admin_only');
    return user;
  }

  // ---- passkeys ----

  async function startRegistration(site, flow) {
    const userId = flow.userId || randomToken(16);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: site.rpID,
      userName: flow.name,
      userDisplayName: flow.name,
      userID: fromB64u(userId),
      attestationType: 'none',
      supportedAlgorithmIDs: ALGORITHMS,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: FLOW_TTL * 1000,
    });
    const flowId = randomToken(16);
    await store.set(`flow:${flowId}`, { ...flow, userId, challenge: options.challenge, rpID: site.rpID }, { ex: FLOW_TTL });
    return { flowId, options };
  }

  async function saveCredential(userId, info) {
    const cred = info.credential;
    await store.set(`cred:${cred.id}`, {
      id: cred.id,
      userId,
      publicKey: b64u(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports || [],
      created: now(),
    });
    await store.sadd(`user:${userId}:creds`, cred.id);
  }

  async function deleteUser(userId) {
    for (const credId of await store.smembers(`user:${userId}:creds`)) await store.del(`cred:${credId}`);
    for (const sid of await store.smembers(`user:${userId}:sessions`)) await store.del(`session:${sid}`);
    await store.del(`user:${userId}`, `user:${userId}:creds`, `user:${userId}:sessions`, `prefs:user:${userId}`);
    await store.srem('users', userId);
  }

  async function signedIn(user, site, status = 200) {
    const session = await createSession(user.id, site);
    return json(status, { ok: true, sessionToken: session.token, user: publicUser(user) }, { 'set-cookie': session.cookie });
  }

  const publicUser = u => ({ id: u.id, name: u.name, admin: !!u.admin });

  // ---- talking to LIFX ----

  async function lifxCall(house, method, parts, body) {
    let res;
    try {
      res = await fetchImpl(LIFX_API + parts.map(encodeURIComponent).join('/'), {
        method,
        headers: { authorization: `Bearer ${house.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(9000),
      });
    } catch {
      throw new HttpError(502, 'lifx_unreachable');
    }
    // A bad house token must not look like "you are signed out".
    if (res.status === 401 || res.status === 403) throw new HttpError(424, 'house_token_invalid');
    return res;
  }

  async function lifxOk(house, method, parts, body) {
    const res = await lifxCall(house, method, parts, body);
    if (!res.ok) throw new HttpError(502, `lifx_${res.status}`);
  }

  // ---- schedules ----

  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const COLOR = /^[A-Za-z0-9:#. _-]{1,60}$/;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

  function cleanSchedule(input, id) {
    const bad = what => { throw new HttpError(400, `bad_schedule_${what}`); };
    if (!input || typeof input !== 'object') bad('body');
    const { on, off, location, pattern } = input;
    if (typeof input.groupId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.groupId)) bad('group');
    if (!on || !['sunset', 'time'].includes(on.mode) || !int(on.offsetMin, -180, 180) || !TIME.test(on.time) || !int(on.fadeMin, 0, 180)) bad('on');
    if (!off || !TIME.test(off.time) || !int(off.fadeMin, 0, 180)) bad('off');
    if (!Array.isArray(input.days) || !input.days.length || !input.days.every(d => int(d, 0, 6))) bad('days');
    if (input.season != null && !(MONTH_DAY.test(input.season.from) && MONTH_DAY.test(input.season.to))) bad('season');
    const skipDates = Array.isArray(input.skipDates) ? input.skipDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-30) : [];
    if (typeof input.level !== 'number' || input.level < 0.05 || input.level > 1) bad('level');
    if (!location || typeof location.lat !== 'number' || Math.abs(location.lat) > 90 || typeof location.lon !== 'number'
      || Math.abs(location.lon) > 180 || typeof location.tz !== 'string' || !isValidTimeZone(location.tz)) bad('location');
    if (!pattern || !Array.isArray(pattern.states) || !pattern.states.length || pattern.states.length > MAX_SCHEDULE_STATES) bad('pattern');
    const states = pattern.states.map(st => {
      if (typeof st?.selector !== 'string' || !st.selector.startsWith('id:') || !SELECTOR.test(st.selector)) bad('pattern');
      if (typeof st.color !== 'string' || !COLOR.test(st.color)) bad('pattern');
      if (typeof st.brightness !== 'number' || st.brightness < 0 || st.brightness > 1) bad('pattern');
      return { selector: st.selector, color: st.color, brightness: st.brightness };
    });
    const mo = pattern.motion || { type: 'none' };
    if (!['none', 'chase', 'breathe', 'pulse'].includes(mo.type)) bad('motion');
    const motion = mo.type === 'none' ? { type: 'none' } : {
      type: mo.type,
      dir: mo.dir === 'backward' ? 'backward' : 'forward',
      speed: typeof mo.speed === 'number' && mo.speed >= 0 && mo.speed <= 1 ? mo.speed : 0.5,
      to: typeof mo.to === 'string' && COLOR.test(mo.to) ? mo.to : 'brightness:0.05',
    };
    return {
      id,
      groupId: input.groupId,
      groupName: cleanName(input.groupName, 'Lights'),
      enabled: !!input.enabled,
      on: { mode: on.mode, offsetMin: on.offsetMin, time: on.time, fadeMin: on.fadeMin },
      off: { time: off.time, fadeMin: off.fadeMin },
      days: [...new Set(input.days)].sort(),
      season: input.season ? { from: input.season.from, to: input.season.to } : null,
      skipDates,
      level: Math.round(input.level * 100) / 100,
      // Only a town-level location is kept (about 1 km).
      location: { lat: Math.round(location.lat * 100) / 100, lon: Math.round(location.lon * 100) / 100, tz: location.tz },
      pattern: { name: cleanName(pattern.name, 'Pattern'), states, motion },
    };
  }

  const tickUrl = site => `https://${env.VERCEL_PROJECT_PRODUCTION_URL || new URL(site.origin).host}/api/cron/tick`;

  async function ensureTimer(site) {
    if (!timer.configured()) return { configured: false };
    const destination = tickUrl(site);
    if ((await store.get('timer:destination')) === destination) return { configured: true };
    try {
      await timer.install(destination);
      await store.set('timer:destination', destination);
      return { configured: true };
    } catch (e) {
      console.error('Could not install the QStash timer', e);
      return { configured: true, error: 'timer_install_failed' };
    }
  }

  async function runEvent(house, s, e) {
    const sel = `group_id:${s.groupId}`;
    const batches = list => Array.from({ length: Math.ceil(list.length / LIFX_BATCH) }, (_, i) => list.slice(i * LIFX_BATCH, (i + 1) * LIFX_BATCH));
    if (e.kind === 'fade-in') {
      await lifxOk(house, 'POST', ['lights', sel, 'effects', 'off'], {});
      // Start dark with the pattern's colours, then let the lights fade up.
      for (const b of batches(s.pattern.states)) {
        await lifxOk(house, 'PUT', ['lights', 'states'], { states: b.map(st => ({ ...st, brightness: 0 })), defaults: { power: 'on', duration: 0 } });
      }
      for (const b of batches(s.pattern.states)) {
        await lifxOk(house, 'PUT', ['lights', 'states'], {
          states: b.map(st => ({ ...st, brightness: Math.round(st.brightness * s.level * 1000) / 1000 })),
          defaults: { duration: Math.max(1, e.seconds) },
        });
      }
    } else if (e.kind === 'motion') {
      const req = motionRequest(s.pattern.motion);
      if (req) await lifxOk(house, 'POST', ['lights', sel, 'effects', req.effect], req.body);
    } else if (e.kind === 'fade-out') {
      await lifxOk(house, 'POST', ['lights', sel, 'effects', 'off'], {});
      await lifxOk(house, 'PUT', ['lights', sel, 'state'], { power: 'off', duration: Math.max(1, e.seconds) });
    }
  }

  async function tick() {
    const at = new Date(now());
    await store.set('timer:lastTick', at.getTime());
    const ran = [];
    for (const key of await store.smembers('schedule-houses')) {
      const house = configuredHouses().find(h => h.key === key);
      if (!house) continue;
      for (const s of Object.values((await store.get(`schedules:${key}`)) || {})) {
        for (const e of dueEvents(s, at)) {
          // Each event runs once, even if ticks overlap or arrive late.
          const doneKey = `done:${key}:${s.id}:${e.date}:${e.kind}`;
          if (!(await store.set(doneKey, at.getTime(), { ex: 3 * 86400, nx: true }))) continue;
          try {
            await runEvent(house, s, e);
            ran.push({ house: key, schedule: s.id, kind: e.kind, date: e.date });
          } catch (err) {
            await store.del(doneKey); // try again on the next tick while still in the window
            ran.push({ house: key, schedule: s.id, kind: e.kind, date: e.date, error: err.code || 'failed' });
          }
        }
      }
    }
    return ran;
  }

  // ---------- routes ----------

  async function route(request, path) {
    const method = request.method;
    const site = siteFor(request);

    // Timer calls come from Upstash QStash (no browser, so no Origin header);
    // they're checked by signature instead.
    if (path === 'cron/tick' && method === 'POST') {
      if (!store) throw new HttpError(503, 'storage_not_configured');
      const raw = await request.text();
      const signature = request.headers.get('upstash-signature') || '';
      if (!signature || !(await verifyCron({ signature, body: raw, url: tickUrl(site) }))) throw new HttpError(401, 'bad_signature');
      // A signature is valid for 5 minutes; refuse to run the same one twice.
      if (!(await store.set(`sig:${sha(signature)}`, 1, { ex: 600, nx: true }))) return json(200, { ok: true, replay: true });
      return json(200, { ok: true, ran: await tick() });
    }

    // CSRF protection: changes must come from this app's own pages.
    if (method !== 'GET' && method !== 'HEAD') {
      if (request.headers.get('origin') !== site.origin) throw new HttpError(403, 'bad_origin');
    }

    if (!store) {
      if (path === 'me') return json(401, { error: 'signed_out', storageConfigured: false, housesConfigured: configuredHouses().length, setupNeeded: false });
      throw new HttpError(503, 'storage_not_configured');
    }

    const body = await readBody(request);
    const user = await currentUser(request);
    const seg = path.split('/');

    // --- who am I ---
    if (path === 'me' && method === 'GET') {
      if (!user) {
        const users = await store.smembers('users');
        return json(401, {
          error: 'signed_out',
          storageConfigured: true,
          housesConfigured: configuredHouses().length,
          setupNeeded: users.length === 0,
          setupCodeConfigured: !!env.SETUP_CODE,
        });
      }
      const houses = await housesWithNames(user.admin ? null : user.houses || []);
      return json(200, { user: publicUser(user), houses });
    }

    // --- first-time setup: the first passkey becomes the admin ---
    if (path === 'auth/setup/options' && method === 'POST') {
      if (!env.SETUP_CODE) throw new HttpError(503, 'setup_code_not_configured');
      if ((await store.smembers('users')).length) throw new HttpError(409, 'already_set_up');
      const bucket = `rl:setup:${Math.floor(now() / 3600000)}`;
      const attempts = await store.incr(bucket);
      if (attempts === 1) await store.expire(bucket, 3600);
      if (attempts > SETUP_ATTEMPTS_PER_HOUR) throw new HttpError(429, 'too_many_attempts');
      if (!safeEqual(body.code || '', env.SETUP_CODE)) throw new HttpError(403, 'wrong_setup_code');
      return json(200, await startRegistration(site, { kind: 'setup', name: cleanName(body.name, 'Me') }));
    }

    // --- joining with an invite link ---
    if (path === 'auth/invite/options' && method === 'POST') {
      const inviteId = sha(String(body.invite || ''));
      const invite = await store.get(`invite:${inviteId}`);
      if (!invite) throw new HttpError(410, 'invite_invalid');
      return json(200, await startRegistration(site, { kind: 'invite', inviteId, name: cleanName(body.name, invite.label || 'Family') }));
    }

    if (path === 'auth/register/verify' && method === 'POST') {
      const flow = await store.getdel(`flow:${String(body.flowId || '')}`);
      if (!flow || (flow.kind !== 'setup' && flow.kind !== 'invite')) throw new HttpError(400, 'flow_expired');
      if (flow.rpID !== site.rpID) throw new HttpError(400, 'flow_expired');
      let result;
      try {
        result = await verifyRegistrationResponse({
          response: body.response,
          expectedChallenge: flow.challenge,
          expectedOrigin: site.origin,
          expectedRPID: site.rpID,
          requireUserVerification: true,
          supportedAlgorithmIDs: ALGORITHMS,
        });
      } catch {
        throw new HttpError(400, 'passkey_not_verified');
      }
      if (!result.verified) throw new HttpError(400, 'passkey_not_verified');
      if (await store.get(`cred:${result.registrationInfo.credential.id}`)) throw new HttpError(409, 'passkey_already_registered');

      let newUser;
      if (flow.kind === 'setup') {
        // Only one setup can ever win, even if two happen at once.
        if (!(await store.set('setup:done', now(), { nx: true }))) throw new HttpError(409, 'already_set_up');
        newUser = { id: flow.userId, name: flow.name, admin: true, houses: [], created: now() };
      } else {
        const invite = await store.getdel(`invite:${flow.inviteId}`); // single use
        await store.srem('invites', flow.inviteId);
        if (!invite) throw new HttpError(410, 'invite_invalid');
        newUser = { id: flow.userId, name: flow.name, admin: false, houses: invite.houses, created: now() };
      }
      try {
        await store.set(`user:${newUser.id}`, newUser);
        await store.sadd('users', newUser.id);
        await saveCredential(newUser.id, result.registrationInfo);
      } catch (e) {
        // Don't leave a half-made account (or a setup that can never be retried).
        await deleteUser(newUser.id).catch(() => {});
        if (flow.kind === 'setup') await store.del('setup:done').catch(() => {});
        throw e;
      }
      return signedIn(newUser, site, 201);
    }

    // --- signing in with Face ID ---
    if (path === 'auth/login/options' && method === 'POST') {
      const options = await generateAuthenticationOptions({
        rpID: site.rpID,
        userVerification: 'required',
        allowCredentials: [],
        timeout: FLOW_TTL * 1000,
      });
      const flowId = randomToken(16);
      await store.set(`flow:${flowId}`, { kind: 'login', challenge: options.challenge, rpID: site.rpID }, { ex: FLOW_TTL });
      return json(200, { flowId, options });
    }

    if (path === 'auth/login/verify' && method === 'POST') {
      const flow = await store.getdel(`flow:${String(body.flowId || '')}`);
      if (!flow || flow.kind !== 'login' || flow.rpID !== site.rpID) throw new HttpError(400, 'flow_expired');
      const credId = String(body.response?.id || '');
      const cred = credId && (await store.get(`cred:${credId}`));
      if (!cred) throw new HttpError(401, 'unknown_passkey');
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response: body.response,
          expectedChallenge: flow.challenge,
          expectedOrigin: site.origin,
          expectedRPID: site.rpID,
          credential: { id: cred.id, publicKey: fromB64u(cred.publicKey), counter: cred.counter, transports: cred.transports },
          requireUserVerification: true,
        });
      } catch {
        throw new HttpError(401, 'passkey_not_verified');
      }
      if (!result.verified) throw new HttpError(401, 'passkey_not_verified');
      const owner = await store.get(`user:${cred.userId}`);
      if (!owner) throw new HttpError(401, 'unknown_passkey');
      await store.set(`cred:${cred.id}`, { ...cred, counter: result.authenticationInfo.newCounter, lastUsed: now() });
      return signedIn(owner, site);
    }

    if (path === 'auth/logout' && method === 'POST') {
      if (user) {
        await store.del(`session:${user.sessionId}`);
        await store.srem(`user:${user.id}:sessions`, user.sessionId);
      }
      return json(200, { ok: true }, { 'set-cookie': cookieHeader('', 0, site.secure) });
    }

    // --- family management (admin) ---
    if (path === 'family' && method === 'GET') {
      requireAdmin(user);
      const users = [];
      for (const id of await store.smembers('users')) {
        const u = await store.get(`user:${id}`);
        if (u) users.push({ ...publicUser(u), houses: u.admin ? null : u.houses, passkeys: (await store.smembers(`user:${id}:creds`)).length, created: u.created });
      }
      const invites = [];
      for (const id of await store.smembers('invites')) {
        const inv = await store.get(`invite:${id}`);
        if (inv) invites.push({ id, label: inv.label, houses: inv.houses, expires: inv.expires });
        else await store.srem('invites', id);
      }
      users.sort((a, b) => a.created - b.created);
      return json(200, { users, invites, houses: await housesWithNames(null) });
    }

    if (path === 'family/invites' && method === 'POST') {
      requireAdmin(user);
      const valid = new Set(configuredHouses().map(h => h.key));
      const houses = [...new Set(Array.isArray(body.houses) ? body.houses : [])].filter(k => valid.has(k));
      if (!houses.length) throw new HttpError(400, 'choose_a_house');
      const code = randomToken(24);
      const id = sha(code);
      const invite = { label: cleanName(body.label, 'Family'), houses, created: now(), expires: now() + INVITE_TTL * 1000, by: user.id };
      await store.set(`invite:${id}`, invite, { ex: INVITE_TTL });
      await store.sadd('invites', id);
      return json(201, { code, id, ...invite });
    }

    if (seg[0] === 'family' && seg[1] === 'invites' && seg[2] && method === 'DELETE') {
      requireAdmin(user);
      await store.del(`invite:${seg[2]}`);
      await store.srem('invites', seg[2]);
      return json(200, { ok: true });
    }

    if (seg[0] === 'family' && seg[1] === 'users' && seg[2] && (method === 'PUT' || method === 'DELETE')) {
      requireAdmin(user);
      const target = await store.get(`user:${seg[2]}`);
      if (!target) throw new HttpError(404, 'not_found');
      if (method === 'DELETE') {
        if (target.id === user.id) throw new HttpError(400, 'cannot_remove_yourself');
        await deleteUser(target.id);
        return json(200, { ok: true });
      }
      const valid = new Set(configuredHouses().map(h => h.key));
      const updated = { ...target, name: cleanName(body.name, target.name) };
      if (!target.admin && Array.isArray(body.houses)) updated.houses = [...new Set(body.houses)].filter(k => valid.has(k));
      await store.set(`user:${target.id}`, updated);
      return json(200, { ok: true });
    }

    if (seg[0] === 'houses' && seg[1] && seg.length === 2 && method === 'PUT') {
      requireAdmin(user);
      if (!configuredHouses().some(h => h.key === seg[1])) throw new HttpError(404, 'not_found');
      await store.set(`house:${seg[1]}:name`, cleanName(body.name, titleCase(seg[1])));
      return json(200, { ok: true });
    }

    // --- settings that follow you between phones and launches ---
    if (seg[0] === 'prefs') {
      requireUser(user);
      let key;
      if (seg[1] === 'user' && seg.length === 2) key = `prefs:user:${user.id}`;
      else if (seg[1] === 'house' && seg[2] && seg.length === 3) {
        if (!configuredHouses().some(h => h.key === seg[2]) || !canReach(user, seg[2])) throw new HttpError(403, 'no_access');
        key = `prefs:house:${seg[2]}`;
      } else throw new HttpError(404, 'not_found');
      if (method === 'GET') return json(200, { prefs: (await store.get(key)) || {} });
      if (method === 'PUT') {
        if (!body || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) throw new HttpError(400, 'bad_prefs');
        if (JSON.stringify(body.prefs).length > MAX_PREFS) throw new HttpError(413, 'too_large');
        await store.set(key, body.prefs);
        return json(200, { ok: true });
      }
    }

    // --- schedules ---
    if (seg[0] === 'schedules' && seg[1]) {
      requireUser(user);
      const house = configuredHouses().find(h => h.key === seg[1]);
      if (!house || !canReach(user, house.key)) throw new HttpError(403, 'no_access');
      const key = `schedules:${house.key}`;
      const all = (await store.get(key)) || {};
      if (seg.length === 2 && method === 'GET') {
        return json(200, {
          schedules: Object.values(all),
          timer: { configured: timer.configured(), lastTick: (await store.get('timer:lastTick')) || null },
        });
      }
      const id = seg[2];
      if (seg.length === 3 && /^[A-Za-z0-9_-]{6,32}$/.test(id) && method === 'PUT') {
        const schedule = cleanSchedule(body?.schedule, id);
        all[id] = { ...schedule, updated: now(), by: user.id };
        await store.set(key, all);
        await store.sadd('schedule-houses', house.key);
        const timerStatus = await ensureTimer(site);
        return json(200, { schedule: all[id], timer: timerStatus });
      }
      if (seg.length === 3 && method === 'DELETE') {
        delete all[id];
        await store.set(key, all);
        return json(200, { ok: true });
      }
      throw new HttpError(404, 'not_found');
    }

    // --- LIFX proxy ---
    if (seg[0] === 'lifx' && seg[1]) {
      requireUser(user);
      const house = configuredHouses().find(h => h.key === seg[1]);
      if (!house || !canReach(user, house.key)) throw new HttpError(403, 'no_access');
      let parts;
      try { parts = seg.slice(2).map(decodeURIComponent); } catch { throw new HttpError(400, 'bad_path'); }
      if (!allowedLifxCall(method, parts)) throw new HttpError(400, 'not_allowed');
      const res = await lifxCall(house, method, parts, body);
      const text = await res.text();
      return new Response(text || 'null', {
        status: res.status === 204 ? 200 : res.status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
      });
    }

    throw new HttpError(404, 'not_found');
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const path = (url.searchParams.get('route') ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
    try {
      return await route(request, path);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.code });
      console.error('Unexpected error', e);
      return json(500, { error: 'server_error' });
    }
  };
}
