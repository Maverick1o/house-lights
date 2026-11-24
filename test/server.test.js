// End-to-end tests for the House Lights backend.
//
// A simulated passkey authenticator (like Face ID) generates a real P-256 key
// and signs genuine WebAuthn responses, so sign-in is tested with real
// cryptography — nothing about passkey verification is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../lib/server.js';
import { createMemoryStore } from '../lib/store.js';

const ORIGIN = 'http://localhost:3000';
const ENV = {
  LIFX_TOKEN_HOME: 'tok-home',
  LIFX_TOKEN_MOM_AND_DAD: 'tok-parents',
  SETUP_CODE: 'open sesame',
  ALLOW_LOCALHOST: '1',
};

// ---------- minimal CBOR encoder (enough for WebAuthn) ----------

function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([cborHead(3, b.length), b]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('unsupported');
}

const sha256 = d => crypto.createHash('sha256').update(d).digest();
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

class FakeAuthenticator {
  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    this.privateKey = privateKey;
    this.x = Buffer.from(jwk.x, 'base64url');
    this.y = Buffer.from(jwk.y, 'base64url');
    this.credId = crypto.randomBytes(16);
  }

  register(options, { origin = ORIGIN, userVerified = true } = {}) {
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]));
    const flags = 0x01 | (userVerified ? 0x04 : 0) | 0x40;
    const authData = Buffer.concat([sha256(options.rp.id), Buffer.from([flags]), u32(0), Buffer.alloc(16), u16(this.credId.length), this.credId, cose]);
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.credId.toString('base64url'),
      rawId: this.credId.toString('base64url'),
      type: 'public-key',
      response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal', 'hybrid'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  login(options, { origin = ORIGIN, userVerified = true, tamper = false } = {}) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([0x01 | (userVerified ? 0x04 : 0)]), u32(0)]);
    let signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    if (tamper) signature = crypto.sign('sha256', Buffer.from('something else'), this.privateKey);
    return {
      id: this.credId.toString('base64url'),
      rawId: this.credId.toString('base64url'),
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

// ---------- harness ----------

function setup({ env = ENV, withStore = true } = {}) {
  let clock = Date.parse('2026-11-23T12:00:00Z');
  const now = () => clock;
  const store = withStore ? createMemoryStore(now) : null;
  const lifxCalls = [];
  const fetchImpl = async (url, init) => {
    lifxCalls.push({ url, method: init.method, token: init.headers.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (init.headers.authorization === 'Bearer tok-bad') return new Response('{"error":"Bad token"}', { status: 401 });
    if (init.method === 'GET') return new Response(JSON.stringify([{ id: 'd073', label: 'Roofline' }]), { status: 200 });
    return new Response('{"results":[{"id":"d073","status":"ok"}]}', { status: 207 });
  };
  const app = createApp({ store, env, fetchImpl, now });
  return { app, store, lifxCalls, advance: ms => (clock += ms) };
}

function client(app, origin = ORIGIN) {
  let cookie = null;
  const c = {
    bearer: null,
    async call(method, path, body, { headerOrigin = origin, useCookie = true, host = origin } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET' && headerOrigin) headers.origin = headerOrigin;
      if (cookie && useCookie) headers.cookie = cookie;
      if (c.bearer) headers.authorization = `Bearer ${c.bearer}`;
      const res = await app(new Request(`${host}/api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? null : set.split(';')[0];
      return { status: res.status, body: await res.json(), setCookie: set };
    },
    hasCookie: () => !!cookie,
    dropCookie: () => { cookie = null; },
  };
  return c;
}

async function setUpAdmin(app) {
  const admin = client(app);
  const auth = new FakeAuthenticator();
  const opts = await admin.call('POST', 'auth/setup/options', { code: 'open sesame', name: 'Kevin' });
  assert.equal(opts.status, 200);
  const done = await admin.call('POST', 'auth/register/verify', { flowId: opts.body.flowId, response: auth.register(opts.body.options) });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  return { admin, auth };
}

async function invitePerson(app, admin, houses, name = 'Mom') {
  const inv = await admin.call('POST', 'family/invites', { houses, label: name });
  assert.equal(inv.status, 201);
  const person = client(app);
  const auth = new FakeAuthenticator();
  const opts = await person.call('POST', 'auth/invite/options', { invite: inv.body.code, name });
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const done = await person.call('POST', 'auth/register/verify', { flowId: opts.body.flowId, response: auth.register(opts.body.options) });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  return { person, auth, code: inv.body.code };
}

async function login(app, auth, opts = {}) {
  const c = client(app);
  const o = await c.call('POST', 'auth/login/options', {});
  const res = await c.call('POST', 'auth/login/verify', { flowId: o.body.flowId, response: auth.login(o.body.options, opts) });
  return { c, res };
}

// ---------- tests ----------

test('first launch asks for setup; wrong setup code is refused', async () => {
  const { app } = setup();
  const c = client(app);
  const me = await c.call('GET', 'me');
  assert.equal(me.status, 401);
  assert.equal(me.body.setupNeeded, true);
  assert.equal(me.body.housesConfigured, 2);
  const bad = await c.call('POST', 'auth/setup/options', { code: 'nope', name: 'X' });
  assert.equal(bad.status, 403);
  assert.equal(bad.body.error, 'wrong_setup_code');
});

test('setup code guessing is rate limited', async () => {
  const { app } = setup();
  const c = client(app);
  for (let i = 0; i < 10; i++) assert.equal((await c.call('POST', 'auth/setup/options', { code: 'x' })).status, 403);
  assert.equal((await c.call('POST', 'auth/setup/options', { code: 'open sesame' })).status, 429);
});

test('admin sets up with a passkey, sees every house, and setup cannot run twice', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  assert.ok(admin.hasCookie());
  const me = await admin.call('GET', 'me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.user.admin, true);
  assert.deepEqual(me.body.houses.map(h => h.name), ['Home', 'Mom And Dad']);
  const again = await client(app).call('POST', 'auth/setup/options', { code: 'open sesame' });
  assert.equal(again.status, 409);
});

test('session cookie is HttpOnly, SameSite=Strict and Secure on https', async () => {
  const env = { ...ENV, APP_ORIGIN: 'https://lights.example.com' };
  const { app } = setup({ env });
  const c = client(app, 'https://lights.example.com');
  const auth = new FakeAuthenticator();
  const o = await c.call('POST', 'auth/setup/options', { code: 'open sesame', name: 'K' });
  const done = await c.call('POST', 'auth/register/verify', { flowId: o.body.flowId, response: auth.register(o.body.options, { origin: 'https://lights.example.com' }) });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.match(done.setCookie, /HttpOnly/);
  assert.match(done.setCookie, /SameSite=Strict/);
  assert.match(done.setCookie, /Secure/);
});

test('a passkey without Face ID / passcode verification is refused', async () => {
  const { app } = setup();
  const c = client(app);
  const o = await c.call('POST', 'auth/setup/options', { code: 'open sesame', name: 'K' });
  const res = await c.call('POST', 'auth/register/verify', { flowId: o.body.flowId, response: new FakeAuthenticator().register(o.body.options, { userVerified: false }) });
  assert.equal(res.status, 400);
  // and setup is still possible afterwards
  const again = await c.call('POST', 'auth/setup/options', { code: 'open sesame', name: 'K' });
  assert.equal(again.status, 200);
});

test('invited family member only reaches their own house; invite is single use', async () => {
  const { app, lifxCalls } = setup();
  const { admin } = await setUpAdmin(app);
  const { person, code } = await invitePerson(app, admin, ['mom_and_dad']);

  const me = await person.call('GET', 'me');
  assert.equal(me.body.user.admin, false);
  assert.deepEqual(me.body.houses.map(h => h.key), ['mom_and_dad']);

  assert.equal((await person.call('GET', 'lifx/home/lights/all')).status, 403);
  const ok = await person.call('GET', 'lifx/mom_and_dad/lights/all');
  assert.equal(ok.status, 200);
  assert.equal(lifxCalls.at(-1).token, 'Bearer tok-parents');
  assert.equal(lifxCalls.at(-1).url, 'https://api.lifx.com/v1/lights/all');

  const reuse = await client(app).call('POST', 'auth/invite/options', { invite: code, name: 'Sneaky' });
  assert.equal(reuse.status, 410);
});

test('invites expire after a week', async () => {
  const { app, advance } = setup();
  const { admin } = await setUpAdmin(app);
  const inv = await admin.call('POST', 'family/invites', { houses: ['home'], label: 'Bob' });
  advance(8 * 86400 * 1000);
  const res = await client(app).call('POST', 'auth/invite/options', { invite: inv.body.code, name: 'Bob' });
  assert.equal(res.status, 410);
});

test('non-admins cannot manage the family or invite people', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  const { person } = await invitePerson(app, admin, ['mom_and_dad']);
  assert.equal((await person.call('GET', 'family')).status, 403);
  assert.equal((await person.call('POST', 'family/invites', { houses: ['home'] })).status, 403);
  assert.equal((await person.call('PUT', 'houses/home', { name: 'Mine now' })).status, 403);
});

test('signing in again with Face ID works without any saved cookie, and by bearer token', async () => {
  const { app } = setup();
  const { auth } = await setUpAdmin(app);
  const { c, res } = await login(app, auth);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await c.call('GET', 'me')).status, 200);

  // Cookies blocked: the app keeps the session token in memory instead.
  c.dropCookie();
  assert.equal((await c.call('GET', 'me')).status, 401);
  c.bearer = res.body.sessionToken;
  assert.equal((await c.call('GET', 'me')).status, 200);
});

test('tampered signatures, wrong origins, missing verification and replays are refused', async () => {
  const { app } = setup();
  const { auth } = await setUpAdmin(app);
  assert.equal((await login(app, auth, { tamper: true })).res.status, 401);
  assert.equal((await login(app, auth, { origin: 'https://evil.example' })).res.status, 401);
  assert.equal((await login(app, auth, { userVerified: false })).res.status, 401);
  assert.equal((await login(app, new FakeAuthenticator())).res.status, 401); // unknown passkey

  // A captured response can't be replayed: the challenge is single use.
  const c = client(app);
  const o = await c.call('POST', 'auth/login/options', {});
  const response = auth.login(o.body.options);
  assert.equal((await c.call('POST', 'auth/login/verify', { flowId: o.body.flowId, response })).status, 200);
  assert.equal((await c.call('POST', 'auth/login/verify', { flowId: o.body.flowId, response })).status, 400);
});

test('a passkey prompt left open more than 5 minutes expires', async () => {
  const { app, advance } = setup();
  const { auth } = await setUpAdmin(app);
  const c = client(app);
  const o = await c.call('POST', 'auth/login/options', {});
  advance(6 * 60 * 1000);
  const res = await c.call('POST', 'auth/login/verify', { flowId: o.body.flowId, response: auth.login(o.body.options) });
  assert.equal(res.status, 400);
});

test('sessions last 90 days of inactivity and are extended when used', async () => {
  const { app, advance } = setup();
  const { admin } = await setUpAdmin(app);
  advance(60 * 86400 * 1000);
  assert.equal((await admin.call('GET', 'me')).status, 200); // used at day 60 → extended
  advance(60 * 86400 * 1000);
  assert.equal((await admin.call('GET', 'me')).status, 200); // day 120, still fine
  advance(91 * 86400 * 1000);
  assert.equal((await admin.call('GET', 'me')).status, 401); // 91 days unused
});

test('requests from other sites or hosts are refused', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  assert.equal((await admin.call('PUT', 'lifx/home/lights/all/state', { power: 'off' }, { headerOrigin: 'https://evil.example' })).status, 403);
  assert.equal((await admin.call('PUT', 'lifx/home/lights/all/state', { power: 'off' }, { headerOrigin: null })).status, 403);
  const strangeHost = await admin.call('GET', 'me', undefined, { host: 'https://evil.example' });
  assert.equal(strangeHost.status, 400);
});

test('only the LIFX calls the app needs are forwarded, with selectors intact', async () => {
  const { app, lifxCalls } = setup();
  const { admin } = await setUpAdmin(app);
  const sel = encodeURIComponent('group_id:abc123');
  const zone = encodeURIComponent('id:d073d5|0-14');

  assert.equal((await admin.call('PUT', `lifx/home/lights/${sel}/state`, { power: 'on' })).status, 207);
  assert.equal(lifxCalls.at(-1).url, 'https://api.lifx.com/v1/lights/group_id%3Aabc123/state');
  assert.deepEqual(lifxCalls.at(-1).body, { power: 'on' });
  assert.equal(lifxCalls.at(-1).token, 'Bearer tok-home');

  assert.equal((await admin.call('PUT', 'lifx/home/lights/states', { states: [{ selector: 'id:d073d5|0-14', color: 'red' }] })).status, 207);
  assert.equal((await admin.call('POST', `lifx/home/lights/${sel}/effects/move`, { period: 2 })).status, 207);
  assert.equal((await admin.call('POST', `lifx/home/lights/${zone}/effects/off`, {})).status, 207);
  assert.equal((await admin.call('POST', `lifx/home/lights/${sel}/effects/breathe`, { color: 'brightness:0.05', period: 3 })).status, 207);
  assert.equal((await admin.call('POST', `lifx/home/lights/${sel}/effects/pulse`, { color: 'red', period: 1 })).status, 207);

  const before = lifxCalls.length;
  for (const [method, path] of [
    ['GET', 'lifx/home/scenes'],
    ['DELETE', 'lifx/home/lights/all'],
    ['POST', 'lifx/home/lights/all/effects/flame'],
    ['PUT', 'lifx/home/lights/all%2F..%2Fscenes/state'],
    ['GET', 'lifx/nowhere/lights/all'],
  ]) {
    const res = await admin.call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
    assert.ok(res.status >= 400, `${method} ${path} should be refused, got ${res.status}`);
  }
  assert.equal(lifxCalls.length, before, 'refused calls never reach LIFX');
});

test('a broken house token is reported without signing anyone out', async () => {
  const { app } = setup({ env: { ...ENV, LIFX_TOKEN_HOME: 'tok-bad' } });
  const { admin } = await setUpAdmin(app);
  const res = await admin.call('GET', 'lifx/home/lights/all');
  assert.equal(res.status, 424);
  assert.equal(res.body.error, 'house_token_invalid');
  assert.equal((await admin.call('GET', 'me')).status, 200);
});

test('settings sync: per-person patterns and per-house strip order, with access control', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  const { person } = await invitePerson(app, admin, ['mom_and_dad']);

  assert.equal((await admin.call('PUT', 'prefs/user', { prefs: { patterns: [{ name: 'Candy' }] } })).status, 200);
  assert.deepEqual((await admin.call('GET', 'prefs/user')).body.prefs, { patterns: [{ name: 'Candy' }] });
  assert.deepEqual((await person.call('GET', 'prefs/user')).body.prefs, {}); // patterns are per person

  // Strip order is per house and shared by everyone who can reach it.
  assert.equal((await admin.call('PUT', 'prefs/house/mom_and_dad', { prefs: { groups: { g1: { order: ['a', 'b'] } } } })).status, 200);
  assert.deepEqual((await person.call('GET', 'prefs/house/mom_and_dad')).body.prefs.groups.g1.order, ['a', 'b']);
  assert.equal((await person.call('GET', 'prefs/house/home')).status, 403);
  assert.equal((await person.call('PUT', 'prefs/house/home', { prefs: {} })).status, 403);

  const huge = { blob: 'x'.repeat(210 * 1024) };
  assert.equal((await admin.call('PUT', 'prefs/user', { prefs: huge })).status, 413);
});

test('admin can rename houses, change access, and remove people (which signs them out everywhere)', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  const { person, auth } = await invitePerson(app, admin, ['mom_and_dad']);

  assert.equal((await admin.call('PUT', 'houses/mom_and_dad', { name: "Mom & Dad's" })).status, 200);
  assert.deepEqual((await person.call('GET', 'me')).body.houses.map(h => h.name), ["Mom & Dad's"]);

  const fam = await admin.call('GET', 'family');
  const mom = fam.body.users.find(u => !u.admin);
  assert.equal(mom.passkeys, 1);
  assert.equal((await admin.call('PUT', `family/users/${mom.id}`, { houses: ['home', 'mom_and_dad'] })).status, 200);
  assert.equal((await person.call('GET', 'me')).body.houses.length, 2);

  const self = fam.body.users.find(u => u.admin);
  assert.equal((await admin.call('DELETE', `family/users/${self.id}`)).status, 400); // can't lock yourself out

  assert.equal((await admin.call('DELETE', `family/users/${mom.id}`)).status, 200);
  assert.equal((await person.call('GET', 'me')).status, 401);
  assert.equal((await login(app, auth)).res.status, 401); // her passkey no longer works
});

test('admin can cancel an unused invite', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  const inv = await admin.call('POST', 'family/invites', { houses: ['home'], label: 'Bob' });
  assert.equal((await admin.call('GET', 'family')).body.invites.length, 1);
  assert.equal((await admin.call('DELETE', `family/invites/${inv.body.id}`)).status, 200);
  assert.equal((await admin.call('GET', 'family')).body.invites.length, 0);
  assert.equal((await client(app).call('POST', 'auth/invite/options', { invite: inv.body.code })).status, 410);
});

test('invites can only include houses that exist', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  assert.equal((await admin.call('POST', 'family/invites', { houses: ['narnia'] })).status, 400);
});

test('logout ends the session', async () => {
  const { app } = setup();
  const { admin } = await setUpAdmin(app);
  assert.equal((await admin.call('POST', 'auth/logout', {})).status, 200);
  assert.equal((await admin.call('GET', 'me')).status, 401);
});

test('without storage configured, the app explains instead of crashing', async () => {
  const { app } = setup({ withStore: false });
  const c = client(app);
  const me = await c.call('GET', 'me');
  assert.equal(me.status, 401);
  assert.equal(me.body.storageConfigured, false);
  assert.equal((await c.call('POST', 'auth/login/options', {})).status, 503);
});

test('requests routed through the Vercel rewrite (?route=) work the same', async () => {
  const { app } = setup();
  const res = await app(new Request(`${ORIGIN}/api/handler?route=me`));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).setupNeeded, true);
});
