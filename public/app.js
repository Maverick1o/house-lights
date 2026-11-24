/* House Lights — LIFX controller for the family's houses.
 *
 * The app signs in with a passkey (Face ID) and talks only to its own
 * backend (/api). The backend holds each house's LIFX token, checks which
 * houses you may reach, and forwards commands to LIFX. Tokens never reach
 * the phone, and passkeys live in the phone's keychain, so nothing is lost
 * when website data is cleared or cookies are blocked.
 *
 * Lights are shown by LIFX group. A group of strips behaves like one
 * continuous string: patterns flow from the first strip into the next.
 *
 * Where colours live:
 *   - The pattern maker is the one place patterns are made and edited.
 *   - The home screen plays them now ("play now"), and shows what's showing.
 *   - A schedule only picks which pattern fades on in the evening; it points at
 *     the pattern, so editing it in the maker changes tonight's lights too.
 */
import {
  COLORS, C, cell, BUILTIN, isMultizone, stripLength, tile, cellsToStates, withDefaults, orderLights,
  normalizeMotion, patternMotion, legacyEffect, motionRequest, resolvePattern, DEFAULT_TO,
} from './shared/patterns.js?v=2026.11.24-7';
import * as P from './shared/patterns.js?v=2026.11.24-7';
import * as core from './shared/schedule-core.js?v=2026.11.24-7';

const APP_VERSION = '2026.11.24-7';
const MAX_STATES = 50; // LIFX limit per /lights/states request

// Colours used by "Identify strips": strip 1 red, 2 green, 3 blue …
const IDENT = [
  { api: 'hue:0 saturation:1', css: '#ff3b3b', name: 'red' },
  { api: 'hue:120 saturation:1', css: '#3bdc5a', name: 'green' },
  { api: 'hue:225 saturation:1', css: '#3b6bff', name: 'blue' },
  { api: 'hue:52 saturation:1', css: '#ffe03b', name: 'yellow' },
  { api: 'hue:275 saturation:1', css: '#a64bff', name: 'purple' },
  { api: 'hue:28 saturation:1', css: '#ff8a1f', name: 'orange' },
];

// ---------- State ----------

let me = null;            // { id, name, admin } once signed in
let houses = [];          // [{ key, name }] this person can reach
let house = null;         // the house being shown
let demo = false;
let sessionToken = null;  // only used when the phone blocks cookies
let lights = [];
let groupPrefs = {};      // per-group settings for the current house (synced)
let saved = [];           // this person's saved patterns (synced)
let identifySnapshot = null; // { gid, lights: [...] } to restore after Identify
let schedules = {};       // groupId -> schedule, for the current house
let timerInfo = null;     // { configured, lastTick }

const $ = sel => document.querySelector(sel);

// Best-effort local memory (e.g. last house shown). May be blocked; never required.
const local = {
  get(k) { try { return localStorage.getItem(`houselights.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`houselights.${k}`, v); } catch { /* blocked */ } },
};

// ---------- Settings sync ----------
// Strip order etc. are saved per house, patterns per person, on the server,
// so they survive app restarts, blocked cookies and new phones.

const pendingSync = new Map(); // api path -> { prefs, timer }

function syncLater(path, prefs) {
  if (demo) return;
  const p = pendingSync.get(path);
  if (p) clearTimeout(p.timer);
  pendingSync.set(path, { prefs, timer: setTimeout(() => flushSync(path), 800) });
}

function flushSync(only) {
  for (const [path, p] of pendingSync) {
    if (only && path !== only) continue;
    clearTimeout(p.timer);
    pendingSync.delete(path);
    server('PUT', path, { prefs: p.prefs }, { keepalive: true })
      .catch(e => showActivity(`Couldn’t save your settings — ${e.message}`, 'err'));
  }
}

const saveGroupPrefs = () => house && syncLater(`prefs/house/${house.key}`, { groups: structuredClone(groupPrefs) });
const savePatterns = () => syncLater('prefs/user', { patterns: structuredClone(saved) });

// ---------- Talking to the backend ----------

const ERRORS = {
  signed_out: 'You’re signed out.',
  house_token_invalid: 'This house’s LIFX token isn’t working. It needs updating in Vercel.',
  no_access: 'You don’t have access to this house.',
  lifx_unreachable: 'Couldn’t reach LIFX. Try again in a moment.',
  storage_not_configured: 'The database isn’t connected yet.',
  too_many_attempts: 'Too many tries. Wait an hour and try again.',
  wrong_setup_code: 'That setup code isn’t right.',
  invite_invalid: 'This invite link has expired or was already used. Ask for a new one.',
  flow_expired: 'That took too long. Please try again.',
  passkey_not_verified: 'Face ID sign-in couldn’t be verified. Please try again.',
  unknown_passkey: 'That passkey isn’t registered for House Lights. Ask the family admin for a new invite.',
  passkey_already_registered: 'This passkey is already set up. Use “Sign in with Face ID” instead.',
  already_set_up: 'House Lights is already set up. Sign in instead.',
  setup_code_not_configured: 'Add a SETUP_CODE in Vercel to finish setup.',
  cannot_remove_yourself: 'You can’t remove yourself.',
  choose_a_house: 'Choose at least one house.',
};

async function server(method, path, body, { keepalive = false } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      keepalive,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Couldn’t connect. Check your internet connection.'), { code: 'offline' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof data?.error === 'string' && ERRORS[data.error] ? data.error : null;
    const msg = res.status === 429 && !code ? 'Too many changes at once — wait a few seconds and try again.'
      : code ? ERRORS[code]
      : typeof data?.error === 'string' ? data.error
      : `Something went wrong (error ${res.status}).`;
    throw Object.assign(new Error(msg), { code: data?.error, status: res.status, data });
  }
  return data;
}

// LIFX calls go through the backend, which adds this house's token.
async function api(method, path, body) {
  if (demo) return mockApi(method, path, body);
  const data = await server(method, `lifx/${house.key}${path}`, body);
  // 207 Multi-Status: note lights that didn't respond.
  const results = data?.results?.flatMap(r => r.results || [r]) || [];
  for (const f of results.filter(r => r.status && r.status !== 'ok')) {
    activity.failed.add(`${f.label || 'A light'} (${f.status.replace('_', ' ')})`);
  }
  return data;
}

const enc = s => encodeURIComponent(s);
const setState = (selector, state) => api('PUT', `/lights/${enc(selector)}/state`, { duration: 0.5, ...state });
const effectsOff = selector => api('POST', `/lights/${enc(selector)}/effects/off`, {});
const chase = (selector, direction = 'forward') =>
  api('POST', `/lights/${enc(selector)}/effects/move`, { direction, period: 2, power_on: true });

// ---------- Passkeys (Face ID) ----------

const toBuf = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)).buffer;
const toB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function createPasskey(o) {
  const cred = await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: toBuf(o.challenge),
      user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: toBuf(c.id) })),
    },
  });
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      attestationObject: toB64u(cred.response.attestationObject),
      transports: cred.response.getTransports?.() || [],
    },
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
  };
}

async function getPasskey(o) {
  const cred = await navigator.credentials.get({
    publicKey: {
      ...o,
      challenge: toBuf(o.challenge),
      allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: toBuf(c.id) })),
    },
  });
  return {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      authenticatorData: toB64u(cred.response.authenticatorData),
      signature: toB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
  };
}

function passkeyMessage(e) {
  if (e?.name === 'NotAllowedError') return 'Face ID was cancelled or timed out. Tap to try again.';
  if (e?.name === 'InvalidStateError') return 'This phone already has a House Lights passkey. Use “Sign in with Face ID”.';
  return e?.message || 'Something went wrong. Please try again.';
}

// ---------- Activity bar ----------

const activity = { busy: null, failed: new Set(), hideTimer: null };

function showActivity(text, kind = 'busy') { // kind: busy | ok | err
  const bar = $('#activity');
  clearTimeout(activity.hideTimer);
  bar.className = kind;
  $('#activity-text').textContent = text;
  bar.hidden = false;
  if (kind !== 'busy') {
    activity.hideTimer = setTimeout(() => (bar.hidden = true), kind === 'err' ? 7000 : 3000);
  }
}

function step(text) {
  if (activity.busy) showActivity(`${activity.busy} — ${text}`);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Run one action at a time, with progress in the activity bar.
async function run(label, fn) {
  if (activity.busy) {
    showActivity(`Still working on “${activity.busy}” — one moment…`);
    return;
  }
  activity.busy = label;
  activity.failed.clear();
  document.body.classList.add('busy');
  const t0 = performance.now();
  step('sending to LIFX…');
  try {
    await fn();
    step('sent ✓ checking your lights…');
    await wait(demo ? 300 : 700);
    await loadLights();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (activity.failed.size) {
      showActivity(`${label} — didn’t reach: ${[...activity.failed].join(', ')}`, 'err');
    } else {
      showActivity(`✓ ${label} — done (${secs}s)`, 'ok');
    }
  } catch (e) {
    handleError(e, label);
  } finally {
    activity.busy = null;
    document.body.classList.remove('busy');
  }
}

// ---------- Groups and the continuous string ----------

const hasColor = l => l.product?.capabilities?.has_color !== false;

// A group's settings (strip order, pattern options, brightness, what was last played).
const gp = gid => (groupPrefs[gid] = withDefaults(groupPrefs[gid]));

// Groups with their lights in the saved order (new lights go at the end).
function getGroups() {
  const byId = new Map();
  for (const l of lights) {
    const id = l.group?.id || 'none';
    if (!byId.has(id)) byId.set(id, { id, name: l.group?.name || 'Lights', lights: [] });
    byId.get(id).lights.push(l);
  }
  for (const g of byId.values()) g.lights = orderLights(g.lights, gp(g.id));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const groupById = gid => getGroups().find(g => g.id === gid);

// Light positions along the string, and the cells a pattern paints on them,
// using this group's strip order and pattern options (see shared/patterns.js).
const positions = (stripLights, gid) => P.positions(stripLights, gp(gid));
const patternCells = (pattern, gid, n) => P.patternCells(pattern, gp(gid), n);

async function sendStates(states, what) {
  const parts = Math.ceil(states.length / MAX_STATES);
  for (let i = 0; i < states.length; i += MAX_STATES) {
    const part = i / MAX_STATES + 1;
    step(`${what}${parts > 1 ? ` (part ${part} of ${parts})` : ''}…`);
    await api('PUT', '/lights/states', {
      states: states.slice(i, i + MAX_STATES),
      defaults: { power: 'on', duration: 0.5 },
    });
  }
}

function startMotion(selector, mo) {
  const req = motionRequest(mo);
  return req && api('POST', `/lights/${enc(selector)}/effects/${req.effect}`, req.body);
}

// Paint cells along a set of strips, then optionally start the motion.
async function paint(selector, pos, cells, level, effect = 'none') {
  step('stopping any animation…');
  await effectsOff(selector);
  await sendStates(cellsToStates(pos, cells, level), `painting ${pos.length} lights`);
  const mo = normalizeMotion(effect);
  if (mo.type !== 'none') {
    step(`starting ${mo.type}…`);
    await startMotion(selector, mo);
  }
}

// Apply cells to a whole group and remember what's now showing. The
// brightness slider rescales it, the home screen names it, and a schedule set
// to "whatever you played last" fades it on in the evening.
async function paintGroup(g, cells, effect = 'none', what = {}) {
  const p = gp(g.id);
  await paint(`group_id:${g.id}`, positions(g.lights, g.id), cells, p.level, effect);
  p.last = { cells, effect: normalizeMotion(effect), name: what.name || 'Custom colours', id: what.id || null, at: Date.now() };
  saveGroupPrefs();
}

function applyToGroup(g, pattern) {
  const n = positions(g.lights, g.id).length;
  return paintGroup(g, patternCells(pattern, g.id, n), patternMotion(pattern), { name: pattern.name, id: pattern.id });
}

// A pattern's name as shown everywhere: saved patterns get a star.
const isSavedId = id => !!id && !id.startsWith('b-');
const patternLabel = (name, id) => (isSavedId(id) ? `⭐ ${name}` : name);

// What a group is showing right now: the schedule's pattern while its
// evening runs (unless something was played since it faded on), otherwise
// whatever was played last. Returns { name, id, cells, effect, scheduled,
// until, tz } or null when unknown.
function showing(g) {
  const p = gp(g.id);
  const last = p.last?.cells ? p.last : null;
  const s = schedules[g.id];
  if (s?.location) {
    const now = new Date();
    const plan = core.currentPlan(s, now);
    const tz = s.location.tz;
    if (!plan.skip && now >= plan.fadeInStart && now < plan.offAt) {
      if (!last || (last.at || 0) < plan.fadeInStart.getTime()) {
        const pt = scheduledPattern(g, s);
        const n = positions(g.lights, g.id).length;
        return {
          name: pt ? pt.name : s.pattern.name, id: pt?.id || null,
          cells: pt ? patternCells(pt, g.id, n) : null, effect: pt ? patternMotion(pt) : s.pattern.motion,
          scheduled: true, until: plan.fadeOutStart, tz,
        };
      }
      if (now < plan.fadeOutStart) return { ...last, until: plan.fadeOutStart, tz };
    }
  }
  return last;
}

// The pattern a schedule points at, as it is now (null if it can't be found
// on this phone, e.g. someone else's saved pattern).
function scheduledPattern(g, s) {
  return resolvePattern(s.pattern, { prefs: gp(g.id), savedPatterns: saved });
}

function scheduledName(g, s) {
  const pt = scheduledPattern(g, s);
  return pt ? patternLabel(pt.name, pt.id) : s.pattern.name;
}

function applyToStrip(g, light, pattern) {
  const pos = positions([light], g.id);
  gp(g.id).last = null; // the group is now mixed
  saveGroupPrefs();
  return paint(`id:${light.id}`, pos, patternCells(pattern, g.id, pos.length), 1, patternMotion(pattern));
}

// Identify strips: each strip a solid colour, its light #1 bright white.
async function identifyStrips(g) {
  identifySnapshot = { gid: g.id, lights: structuredClone(g.lights) };
  const pos = positions(g.lights, g.id);
  const cells = pos.map(p => {
    const k = g.lights.indexOf(p.light);
    const first = pos.find(q => q.light === p.light) === p;
    return first ? cell('kelvin:5000 saturation:0', 1) : cell(IDENT[k % IDENT.length].api, 0.5);
  });
  await paint(`group_id:${g.id}`, pos, cells, 1);
}

async function restoreSnapshot() {
  const snap = identifySnapshot;
  const states = [];
  for (const l of snap.lights) {
    const zones = l.zones?.zones;
    if (zones?.length) {
      let start = 0;
      const key = z => `${z.hue}|${z.saturation}|${z.kelvin}|${z.brightness}`;
      for (let i = 1; i <= zones.length; i++) {
        if (i === zones.length || key(zones[i]) !== key(zones[start])) {
          const z = zones[start];
          states.push({
            selector: `id:${l.id}|${start}-${i - 1}`,
            color: `hue:${z.hue} saturation:${z.saturation} kelvin:${z.kelvin}`,
            brightness: z.brightness,
          });
          start = i;
        }
      }
    } else if (l.color) {
      states.push({
        selector: `id:${l.id}`,
        color: `hue:${l.color.hue} saturation:${l.color.saturation} kelvin:${l.color.kelvin}`,
        brightness: l.brightness,
      });
    }
  }
  await effectsOff(`group_id:${snap.gid}`);
  await sendStates(states, 'restoring');
  for (const l of snap.lights.filter(l => l.power === 'off')) await setState(`id:${l.id}`, { power: 'off' });
  identifySnapshot = null;
}

// ---------- Rendering helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'text') node.textContent = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function parseColor(str) {
  if (str.startsWith('#')) {
    const r = parseInt(str.slice(1, 3), 16) / 255, g = parseInt(str.slice(3, 5), 16) / 255, b = parseInt(str.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { hue: Math.round((h * 60 + 360) % 360), saturation: max ? d / max : 0 };
  }
  const out = {};
  for (const [, k, v] of str.matchAll(/(\w+):([\d.]+)/g)) out[k] = Number(v);
  return out;
}

function hsbCss({ hue = 0, saturation = 0, kelvin = 3500 }) {
  if (saturation < 0.05) return kelvin < 3200 ? '#ffd7a0' : '#f4f6ff';
  return `hsl(${hue}, ${Math.round(saturation * 100)}%, 55%)`;
}
const cssColor = light => hsbCss(light.color || {});
const cellCss = x => hsbCss(parseColor(x.c));

function paintCellEl(node, x) {
  node.style.background = x.b > 0 ? cellCss(x) : '';
  node.style.opacity = x.b > 0 ? 0.35 + 0.65 * Math.min(1, x.b) : '';
  node.classList.toggle('off', !(x.b > 0));
}

function sw(css, label, onclick, extra = {}) {
  return el('button', { class: 'swatch-btn', title: label, 'aria-label': label, style: `background:${css}`, onclick, ...extra });
}

function chips(list) { return el('div', { class: 'chips' }, list); }

function toggleSwitch(checked, disabled, onchange) {
  return el('label', { class: 'switch' },
    el('input', { type: 'checkbox', checked, disabled, onchange }), el('span'));
}

// <details> that stays open across re-renders.
const openKeys = new Set();
function fold(key, summary, ...body) {
  const d = el('details', { 'data-key': key, open: openKeys.has(key) },
    el('summary', {}, summary), el('div', { class: 'fold-body' }, ...body));
  d.addEventListener('toggle', () => (d.open ? openKeys.add(key) : openKeys.delete(key)));
  return d;
}

// ---------- Main screen ----------

function renderMain() {
  const names = [...new Set(lights.map(l => l.location?.name).filter(Boolean))];
  $('#house-name').textContent = demo ? 'Demo House' : house?.name || names[0] || 'My House';
  $('#status').textContent = (demo ? 'Demo mode · ' : '') +
    `${lights.length} light${lights.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('#empty').hidden = lights.length > 0;
  $('#groups').replaceChildren(...getGroups().map(groupCard));
}

function groupCard(g) {
  const p = gp(g.id);
  const sel = `group_id:${g.id}`;
  const online = g.lights.filter(l => l.connected);
  const on = online.some(l => l.power === 'on');
  const n = positions(g.lights, g.id).length;
  const multi = g.lights.length > 1;
  const strips = g.lights.filter(isMultizone).length;
  const sub = [
    multi ? `${g.lights.length} ${strips === g.lights.length ? 'strips' : 'lights'}` : null,
    `${n} light${n === 1 ? '' : 's'}`,
    online.length < g.lights.length ? `${g.lights.length - online.length} offline` : null,
  ].filter(Boolean).join(' · ');

  const now = showing(g);
  const brightnessValue = now?.scheduled ? Math.round(schedules[g.id].level * 100)
    : now ? Math.round(p.level * 100)
      : Math.round(Math.max(0, ...online.map(l => l.brightness || 0)) * 100);

  const solid = (c, label) => run(`${g.name} → ${label}`, () => paintGroup(g, tile([cell(c)], n), 'none', { name: label }));
  const isShowing = pt => !!now && (now.id ? now.id === pt.id : now.name === pt.name);

  const card = el('div', { class: 'card group' },
    el('div', { class: 'light-head' },
      el('span', { class: 'dot' + (on ? '' : ' off'), style: `background:${online[0] ? cssColor(online[0]) : '#333'}` }),
      el('div', { class: 'name' }, el('strong', { text: g.name }), el('span', { class: 'muted small', text: sub })),
      toggleSwitch(on, !online.length, e =>
        run(`${g.name} ${e.target.checked ? 'on' : 'off'}`, () => setState(sel, { power: e.target.checked ? 'on' : 'off' })))),
    el('input', {
      type: 'range', min: 1, max: 100, value: brightnessValue || 1, 'aria-label': `${g.name} brightness`, disabled: !online.length,
      onchange: e => {
        const v = e.target.value / 100;
        if (now?.cells) {
          // Rescale the pattern that's showing instead of flattening it.
          p.level = v;
          saveGroupPrefs();
          run(`${g.name} brightness ${e.target.value}%`, () => paintGroup(g, now.cells, now.effect, { name: now.name, id: now.id }));
        } else {
          run(`${g.name} brightness ${e.target.value}%`, () => setState(sel, { power: 'on', brightness: v }));
        }
      },
    }));

  if (on && now) card.append(nowShowingLine(now));
  if (!online.length) return card;

  const anyColour = g.lights.some(hasColor);
  card.append(
    el('h3', { text: 'Colour' }),
    chips([
      ...(anyColour ? COLORS : COLORS.slice(0, 2)).map(c => sw(c.css, c.name, () => solid(c.api, c.name))),
      anyColour && el('input', { type: 'color', 'aria-label': 'Custom colour', value: '#ff8800', onchange: e => solid(e.target.value, 'custom colour') }),
    ]),
    el('h3', { text: 'Patterns' }),
    chips([
      ...BUILTIN.map(pt => el('button', { class: isShowing(pt) ? 'active' : '', 'aria-pressed': String(isShowing(pt)), onclick: () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)) }, pt.name)),
      ...saved.map(pt => el('button', { class: 'saved' + (isShowing(pt) ? ' active' : ''), 'aria-pressed': String(isShowing(pt)), onclick: () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)) }, `⭐ ${pt.name}`)),
    ]),
    el('button', { class: 'primary wide', style: 'margin-top:12px', onclick: () => openMaker(g.id) }, '✏️ Make or edit a pattern'),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { onclick: () => run(`Chase · ${g.name}`, async () => { await chase(sel); setLastMotion(g, normalizeMotion('chase')); }) }, '▶︎ Chase'),
      el('button', { onclick: () => run(`Stop · ${g.name}`, async () => { await effectsOff(sel); setLastMotion(g, normalizeMotion('none')); }) }, '■ Stop')),
    !demo && scheduleRow(g));

  if (multi && !p.ordered) {
    card.append(el('p', { class: 'hint' },
      'Tip: set your strip order under “Strip order” so patterns flow around the house in the right direction.'));
  }

  card.append(fold(`${g.id}:options`, 'Pattern options',
    el('p', { class: 'muted small', text: 'For the built-in patterns. Patterns you make in the pattern maker use exactly what you painted.' }),
    el('label', { class: 'inline' }, 'Lights per colour',
      el('input', {
        type: 'number', min: 1, max: 50, value: p.width, inputmode: 'numeric',
        onchange: e => { p.width = Math.max(1, parseInt(e.target.value, 10) || 1); saveGroupPrefs(); },
      })),
    el('label', { class: 'inline' }, 'Gaps between colours',
      el('select', { onchange: e => { p.gaps = e.target.value; saveGroupPrefs(); } },
        [['none', 'None'], ['off', 'Off'], ['dim', 'Barely lit']].map(([v, t]) => el('option', { value: v, selected: p.gaps === v }, t))))));

  if (multi) {
    card.append(fold(`${g.id}:strips`, `Strips (${g.lights.length})`, ...g.lights.map(l => stripCard(g, l))));
    card.append(fold(`${g.id}:order`, 'Strip order', ...orderEditor(g)));
  }
  return card;
}

// Chase / Stop change the motion of what's showing; remember it, so
// "whatever you played last" brings it back the same way.
function setLastMotion(g, mo) {
  const p = gp(g.id);
  if (!p.last?.cells) return;
  p.last = { ...p.last, effect: mo, at: Date.now() };
  saveGroupPrefs();
}

// A small strip of colour previewing cells (sampled down to fit).
function previewStrip(cells, max = 36) {
  const box = el('span', { class: 'preview-strip', 'aria-hidden': 'true' });
  if (!cells?.length) { box.classList.add('unknown'); return box; }
  const step = Math.max(1, cells.length / max);
  for (let i = 0; i < cells.length && box.childElementCount < max; i += step) {
    const x = cells[Math.floor(i)];
    box.append(el('span', { style: x.b > 0 ? `background:${cellCss(x)};opacity:${Math.max(0.35, Math.min(1, x.b * 1.5))}` : 'background:#1b1d23' }));
  }
  return box;
}

function nowShowingLine(now) {
  const t = d => fmtTime(d, now.tz);
  const detail = now.scheduled ? `From your schedule · fades off at ${t(now.until)}`
    : now.until ? `Until the ${t(now.until)} fade-off` : '';
  return el('div', { class: 'now-line' },
    previewStrip(now.cells),
    el('span', { class: 'now-text' },
      el('span', { class: 'muted small', text: 'Showing' }),
      el('strong', { text: patternLabel(now.name, now.id) }),
      detail && el('span', { class: 'muted small', text: detail })));
}

function stripCard(g, light) {
  const id = `id:${light.id}`;
  const on = light.power === 'on';
  const mixed = () => { gp(g.id).last = null; saveGroupPrefs(); };
  const box = el('div', { class: 'strip' },
    el('div', { class: 'light-head' },
      el('span', { class: 'dot' + (on && light.connected ? '' : ' off'), style: `background:${cssColor(light)}` }),
      el('div', { class: 'name' },
        el('strong', { text: light.label || 'Light' }),
        el('span', { class: 'muted small' + (light.connected ? '' : ' offline'), text: light.connected ? `${stripLength(light)} lights${on ? '' : ' · off'}` : 'Offline' })),
      toggleSwitch(on, !light.connected, e =>
        run(`${light.label} ${e.target.checked ? 'on' : 'off'}`, () => setState(id, { power: e.target.checked ? 'on' : 'off' })))));
  if (!light.connected) return box;
  box.append(
    el('input', {
      type: 'range', min: 1, max: 100, value: Math.round((light.brightness || 0) * 100), 'aria-label': `${light.label} brightness`,
      onchange: e => { mixed(); run(`${light.label} brightness ${e.target.value}%`, () => setState(id, { power: 'on', brightness: e.target.value / 100 })); },
    }),
    chips((hasColor(light) ? COLORS : COLORS.slice(0, 2)).map(c =>
      sw(c.css, c.name, () => { mixed(); run(`${light.label} → ${c.name}`, () => setState(id, { power: 'on', color: c.api })); }, { class: 'swatch-btn small' }))),
    isMultizone(light) && chips([...BUILTIN, ...saved].map(pt =>
      el('button', { class: 'small', onclick: () => run(`${pt.name} · ${light.label}`, () => applyToStrip(g, light, pt)) }, pt.name))));
  return box;
}

function orderEditor(g) {
  const p = gp(g.id);
  const move = (i, d) => {
    const ids = g.lights.map(l => l.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    p.order = ids;
    p.ordered = true;
    p.last = null;
    saveGroupPrefs();
    renderMain();
  };
  return [
    el('p', { class: 'muted small', text: 'Put the strips in the order they run around the house. “Identify strips” lights each one a different colour, with its light #1 bright white, so you can see which is which and which end it starts from.' }),
    el('ol', { class: 'order' }, g.lights.map((l, i) =>
      el('li', {},
        el('span', { class: 'dot', style: `background:${IDENT[i % IDENT.length].css}` }),
        el('span', { class: 'grow', text: `${l.label} (${stripLength(l)})` }),
        el('button', { class: 'small', disabled: i === 0, 'aria-label': 'Move up', onclick: () => move(i, -1) }, '↑'),
        el('button', { class: 'small', disabled: i === g.lights.length - 1, 'aria-label': 'Move down', onclick: () => move(i, 1) }, '↓'),
        el('label', { class: 'inline small' },
          el('input', {
            type: 'checkbox', checked: !!p.reversed[l.id],
            onchange: e => { p.reversed[l.id] = e.target.checked; p.ordered = true; p.last = null; saveGroupPrefs(); },
          }), 'Reverse')))),
    el('div', { class: 'row' },
      el('button', { onclick: () => run(`Identify strips · ${g.name}`, () => identifyStrips(g)) }, '🔦 Identify strips'),
      identifySnapshot?.gid === g.id && el('button', { onclick: () => run(`Restore · ${g.name}`, restoreSnapshot) }, '↩︎ Put lights back')),
    !p.ordered && el('button', { class: 'link', onclick: () => { p.ordered = true; saveGroupPrefs(); renderMain(); } }, 'This order is right'),
  ];
}

// ---------- Pattern maker ----------
// One source of truth: a short repeating pattern (seq) is tiled around the
// house, plus optional single-light changes (overrides). The house view always
// shows the result, so what you see is exactly what gets sent.

const BRIGHTNESS = [[1, '100%'], [0.5, '50%'], [0.15, '15%'], [0.03, '3%']];
const MAX_SEQ = 24;
const QUICK_STARTS = [
  ...BUILTIN.filter(b => !b.rainbow).map(b => ({ name: b.name, seq: b.loop })),
  { name: '🍬 Candy cane', seq: [cell(C.Red), cell(C.Red), cell(C.White), cell(C.White)] },
  { name: '🌈 Rainbow', seq: Array.from({ length: 12 }, (_, i) => cell(`hue:${i * 30} saturation:1`)) },
];
let maker = null;

const keyOf = x => `${x.c}|${x.b}`;
const clone = x => structuredClone(x);

function makerCells(m = maker) {
  const cells = tile(m.seq, m.n);
  for (const [i, x] of Object.entries(m.overrides)) if (+i < m.n) cells[+i] = { ...x };
  return cells;
}
const editState = (m = maker) => JSON.stringify({ seq: m.seq, overrides: m.overrides, motion: m.motion, name: m.name });
const sendKey = (m = maker) => JSON.stringify({ cells: makerCells(m), motion: m.motion });

// Single-light changes in a saved pattern = where it differs from the repeat.
function overridesFor(pattern, seq, n) {
  if (pattern.overrides) return Object.fromEntries(Object.entries(pattern.overrides).filter(([i]) => +i < n).map(([i, x]) => [i, { ...x }]));
  if (pattern.cells?.length !== n) return {};
  const base = tile(seq, n);
  const out = {};
  pattern.cells.forEach((x, i) => { if (keyOf(x) !== keyOf(base[i])) out[i] = { ...x }; });
  return out;
}

function openMaker(gid, pattern) {
  const g = groupById(gid);
  const n = positions(g.lights, gid).length;
  const isSaved = !!pattern && !pattern.id?.startsWith('b-');
  const seq = pattern?.loop?.map(x => ({ ...x })) || [cell(C.Red), cell(C.Green)];
  maker = {
    gid, n, seq,
    overrides: isSaved ? overridesFor(pattern, seq, n) : {},
    motion: normalizeMotion(pattern?.effect, pattern?.motion),
    name: isSaved ? pattern.name : '',
    editingId: isSaved ? pattern.id : null,
    sel: null, // { kind: 'seq' | 'house', idx: Set } — lights the sheet is editing
    history: [],
    sent: null,
  };
  maker.savedState = isSaved ? editState() : null;
  maker.startState = editState();
  closeSheet();
  show('maker');
  renderMaker();
  window.scrollTo(0, 0);
}

const isDirty = () => !!maker && editState() !== (maker.savedState ?? maker.startState);

function remember() {
  maker.history.push(JSON.stringify({ seq: maker.seq, overrides: maker.overrides, motion: maker.motion }));
  if (maker.history.length > 80) maker.history.shift();
}

function undo() {
  const last = maker?.history.pop();
  if (!last) return;
  const sel = maker.sel;
  Object.assign(maker, JSON.parse(last));
  renderMaker();
  // Keep the sheet on the same lights if they still exist.
  if (sel && [...sel.idx].every(i => i < (sel.kind === 'seq' ? maker.seq.length : maker.n))) {
    maker.sel = sel;
    markSelection();
    renderSheet();
  } else closeSheet();
}

function closeMaker(force = false) {
  if (!force && isDirty() && !confirm('Leave without saving? Your changes to this pattern will be lost.')) return;
  closeSheet();
  maker = null;
  show('main');
  renderMain();
}

function renderMaker() {
  const m = maker;
  $('#quick-starts').replaceChildren(...QUICK_STARTS.map(q => el('button', { class: 'small', onclick: () => startFrom(q) }, q.name)));
  $('#saved-row').hidden = !saved.length;
  $('#saved-patterns').replaceChildren(...saved.map(p => el('button', {
    class: 'small saved' + (p.id === m.editingId ? ' active' : ''),
    onclick: () => {
      if (p.id === m.editingId) return;
      if (isDirty() && !confirm('Switch patterns without saving your changes?')) return;
      openMaker(m.gid, p);
    },
  }, `⭐ ${p.name}`)));
  renderSeq();
  renderHouse();
  renderMotion();
  $('#maker-share').hidden = !m.editingId;
  $('#maker-delete').hidden = !m.editingId;
  renderHeader();
  renderShowButton();
}

function renderHeader() {
  const m = maker;
  const g = groupById(m.gid);
  $('#maker-title').textContent = m.name || 'New pattern';
  $('#maker-title').classList.toggle('placeholder', !m.name);
  $('#maker-sub').textContent = `${g.name} · ${m.n} lights`;
  $('#maker-undo').disabled = !m.history.length;
  const dirty = isDirty();
  $('#maker-save').textContent = m.editingId && !dirty ? 'Saved ✓' : 'Save';
  $('#maker-save').classList.toggle('primary', dirty);
}

const FADE_TO = [
  { name: 'Dim', api: DEFAULT_TO, css: '#3a3226' },
  { name: 'Off', api: 'brightness:0', css: '#0d0f13' },
  ...COLORS,
];

function renderMotion() {
  const mo = maker.motion;
  const mark = (sel, attr, value) => document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset[attr] === value));
  mark('#effect-seg button', 'kind', mo.type);
  $('#motion-options').hidden = mo.type === 'none';
  $('#dir-row').hidden = mo.type !== 'chase';
  mark('#dir-seg button', 'dir', mo.dir);
  $('#speed-slider').value = Math.round(mo.speed * 100);
  $('#to-row').hidden = mo.type === 'chase';
  $('#to-label').textContent = mo.type === 'pulse' ? 'Blinks to' : 'Fades to';
  $('#to-swatches').replaceChildren(...FADE_TO.map(c => el('button', {
    class: 'swatch-btn small' + (c.name === 'Off' ? ' off-swatch' : '') + (mo.to === c.api ? ' active' : ''),
    title: c.name, 'aria-label': `${mo.type === 'pulse' ? 'Blink' : 'Fade'} to ${c.name}`,
    style: c.name === 'Off' ? '' : `background:${c.css}`,
    onclick: () => setMotion({ to: c.api }),
  }, c.name === 'Dim' ? 'Dim' : c.name === 'Off' ? 'Off' : null)));
  $('#motion-note').textContent = {
    none: '',
    chase: 'Your pattern travels along the lights.',
    breathe: 'Try it: on some strips the whole strip fades to one colour while breathing, then your pattern returns when you stop it.',
    pulse: 'Try it: on some strips the whole strip blinks to one colour, then your pattern returns when you stop it.',
  }[mo.type];
}

function setMotion(change) {
  const next = { ...maker.motion, ...change };
  if (JSON.stringify(next) === JSON.stringify(maker.motion)) return;
  remember();
  maker.motion = next;
  renderMotion();
  renderHeader();
  renderShowButton();
}

function renderSeq() {
  const m = maker;
  $('#seq-grid').replaceChildren(
    ...m.seq.map((x, i) => cellEl('seq', i, x, i + 1)),
    m.seq.length < MAX_SEQ ? el('button', { class: 'add-cell', 'aria-label': 'Add a light to the pattern', title: 'Add a light', onclick: addSeqLight }, '+') : null);
  $('#seq-count').textContent = `Repeats every ${m.seq.length} light${m.seq.length === 1 ? '' : 's'}`;
  $('#seq-remove').hidden = m.seq.length <= 1;
}

function renderHouse() {
  const m = maker;
  const g = groupById(m.gid);
  const cells = makerCells();
  const pos = positions(g.lights, g.id);
  const rows = [];
  let i = 0;
  for (const l of g.lights) {
    const len = pos.filter(p => p.light === l).length;
    const row = [];
    for (let k = 0; k < len; k++, i++) {
      const node = cellEl('house', i, cells[i], k + 1);
      if (m.overrides[i]) node.classList.add('changed');
      row.push(node);
    }
    rows.push(el('div', { class: 'strip-row' },
      el('div', { class: 'muted small', text: `${l.label} · ${len} light${len === 1 ? '' : 's'}` }),
      el('div', { class: 'grid house' }, row)));
  }
  $('#house-grid').replaceChildren(...rows);
  const changed = Object.keys(m.overrides).length;
  $('#overrides-note').hidden = !changed;
  $('#overrides-count').textContent = `${changed} light${changed === 1 ? '' : 's'} changed by hand (dotted)`;
}

function renderShowButton() {
  const upToDate = maker.sent === sendKey();
  const btn = $('#maker-preview');
  btn.textContent = upToDate ? '✓ On house' : '💡 Show on house';
  btn.classList.toggle('primary', !upToDate);
  btn.classList.toggle('done', upToDate);
}

function cellEl(kind, i, x, label) {
  const node = el('div', { class: 'cell', 'data-kind': kind, 'data-i': i, role: 'button', 'aria-label': `Light ${label}` });
  paintCellEl(node, x);
  return node;
}

function afterEdit() {
  renderHouse();
  renderHeader();
  renderShowButton();
  if (maker.sel) { renderSheet(); markSelection(); }
}

function addSeqLight() {
  remember();
  const last = maker.seq[maker.seq.length - 1];
  maker.seq.push({ ...last });
  renderSeq();
  afterEdit();
  select('seq', [maker.seq.length - 1]);
}

function startFrom(q) {
  closeSheet();
  remember();
  maker.seq = clone(q.seq || q.pattern.loop);
  maker.overrides = q.pattern ? overridesFor(q.pattern, maker.seq, maker.n) : {};
  if (q.pattern) maker.motion = normalizeMotion(q.pattern.effect, q.pattern.motion);
  renderMaker();
  showActivity(`Started from ${q.name} — tap ↶ to undo`, 'ok');
}

// ---------- The light sheet ----------
// Tap a light (or drag across lights in the repeating pattern) to select it.
// The sheet slides up and edits exactly those lights.

function selectedCells() {
  const s = maker?.sel;
  if (!s) return [];
  const cells = s.kind === 'seq' ? maker.seq : makerCells();
  return [...s.idx].map(i => cells[i]).filter(Boolean);
}

function markSelection() {
  document.querySelectorAll('#maker .cell.selected').forEach(n => n.classList.remove('selected'));
  const s = maker?.sel;
  if (!s) return;
  const grid = s.kind === 'seq' ? '#seq-grid' : '#house-grid';
  for (const i of s.idx) document.querySelector(`${grid} .cell[data-i="${i}"]`)?.classList.add('selected');
}

function select(kind, indices) {
  maker.sel = { kind, idx: new Set(indices) };
  markSelection();
  openSheet();
}

function openSheet() {
  const sheet = $('#light-sheet');
  renderSheet();
  sheet.style.transform = '';
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-open');
  // Keep the selected light visible above the sheet.
  requestAnimationFrame(() => {
    const first = document.querySelector('#maker .cell.selected');
    if (!first) return;
    const r = first.getBoundingClientRect();
    const sheetTop = window.innerHeight - sheet.offsetHeight;
    if (r.bottom > sheetTop - 12) window.scrollBy({ top: r.bottom - sheetTop + 24, behavior: 'smooth' });
  });
}

function closeSheet() {
  const sheet = $('#light-sheet');
  if (maker) maker.sel = null;
  markSelection();
  sheet.classList.remove('open');
  sheet.style.transform = '';
  sheet.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('sheet-open');
}

function houseLightName(i) {
  const g = groupById(maker.gid);
  let start = 0;
  for (const l of g.lights) {
    const len = positions([l], g.id).length;
    if (i < start + len) return `${l.label} · light ${i - start + 1}`;
    start += len;
  }
  return `Light ${i + 1}`;
}

function renderSheet() {
  const m = maker;
  const cells = selectedCells();
  if (!cells.length) return;
  const one = cells.length === 1 ? [...m.sel.idx][0] : null;
  $('#sheet-title').textContent = one == null ? `${cells.length} lights selected`
    : m.sel.kind === 'seq' ? `Pattern light ${one + 1}` : houseLightName(one);
  $('#sheet-sub').textContent = m.sel.kind === 'seq'
    ? 'Repeats all the way around your house'
    : 'Changes just this light on your house';
  const same = f => cells.every(x => f(x) === f(cells[0]));
  const allOff = cells.every(x => !(x.b > 0));
  const colour = !allOff && same(x => x.c) ? cells[0].c : null;
  const level = same(x => x.b) ? cells[0].b : null;

  $('#sheet-colors').replaceChildren(
    ...COLORS.map(c => sw(c.css, c.name, () => applyToSelection({ c: c.api }), { class: 'swatch-btn' + (colour === c.api ? ' active' : '') })),
    el('input', {
      type: 'color', class: 'custom-swatch' + (colour?.startsWith('#') ? ' active' : ''),
      title: 'Any colour', 'aria-label': 'Pick any colour',
      value: colour?.startsWith('#') ? colour : '#ff8800',
      onchange: e => applyToSelection({ c: e.target.value }),
    }),
    el('button', {
      class: 'swatch-btn off-swatch' + (allOff ? ' active' : ''), title: 'Off', 'aria-label': 'Turn off',
      onclick: () => applyToSelection({ b: 0 }),
    }, 'Off'));
  $('#sheet-levels').replaceChildren(...BRIGHTNESS.map(([v, t]) => el('button', {
    class: level === v ? 'active' : '',
    'aria-label': `Brightness ${t}`,
    onclick: () => applyToSelection({ b: v }),
  }, t)));
}

// Picking a colour keeps each light's brightness (or turns an off light on);
// picking a brightness keeps each light's colour.
const withChange = (x, ch) => (ch.c !== undefined ? { c: ch.c, b: x.b > 0 ? x.b : 1 } : { c: x.c, b: ch.b });

function applyToSelection(change) {
  const m = maker;
  const s = m.sel;
  if (!s) return;
  const base = tile(m.seq, m.n);
  const updates = [...s.idx].map(i => {
    const current = s.kind === 'seq' ? m.seq[i] : m.overrides[i] || base[i];
    return [i, withChange(current, change), current];
  }).filter(([, next, current]) => keyOf(next) !== keyOf(current));
  if (!updates.length) return;
  remember();
  for (const [i, next] of updates) {
    if (s.kind === 'seq') m.seq[i] = next;
    else if (keyOf(next) === keyOf(base[i])) delete m.overrides[i]; // back to the pattern
    else m.overrides[i] = next;
  }
  if (s.kind === 'seq') renderSeq();
  afterEdit();
}

// Repeating pattern: tap a light, or drag sideways to select several.
let gesture = null; // { start, prev }
document.addEventListener('pointerdown', e => {
  const node = e.target.closest?.('#seq-grid .cell[data-kind="seq"]');
  if (!node || !maker) return;
  gesture = { start: +node.dataset.i, prev: maker.sel };
  maker.sel = { kind: 'seq', idx: new Set([gesture.start]) };
  markSelection();
});
document.addEventListener('pointermove', e => {
  if (!gesture) return;
  const node = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#seq-grid .cell[data-kind="seq"]');
  if (!node) return;
  const i = +node.dataset.i;
  const [a, b] = [Math.min(gesture.start, i), Math.max(gesture.start, i)];
  maker.sel = { kind: 'seq', idx: new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)) };
  markSelection();
});
document.addEventListener('pointerup', () => {
  if (!gesture) return;
  gesture = null;
  openSheet();
});
document.addEventListener('pointercancel', () => {
  if (!gesture) return; // the page started scrolling instead: leave things as they were
  maker.sel = gesture.prev;
  gesture = null;
  markSelection();
});

// Swipe the sheet down (or tap ✕, an empty area, or Escape) to close it.
(() => {
  const sheet = $('#light-sheet');
  let drag = null;
  sheet.addEventListener('pointerdown', e => {
    if (!e.target.closest('.sheet-grab, .sheet-head') || e.target.closest('button')) return;
    drag = { y: e.clientY, dy: 0 };
    sheet.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  });
  sheet.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    sheet.style.transform = `translateY(${drag.dy}px)`;
  });
  const end = () => {
    if (!drag) return;
    sheet.classList.remove('dragging');
    if (drag.dy > 60) closeSheet(); else sheet.style.transform = '';
    drag = null;
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
})();

function makerPattern() {
  return {
    id: maker.editingId || `p-${Date.now().toString(36)}`,
    name: (maker.name || 'My pattern').slice(0, 40),
    loop: clone(maker.seq),
    overrides: clone(maker.overrides),
    cells: makerCells(),
    effect: legacyEffect(maker.motion),
    motion: clone(maker.motion),
  };
}

// ---------- Schedules ----------
// Fade on so the lights are fully on at sunset (or a set time), then start
// fading off at a set time. The server runs it; the app shows the evening as a
// timeline so you can see exactly what will happen tonight.

const scheduleId = gid => `s-${gid}`.slice(0, 32);

function fmtTime(d, tz) {
  return d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz }) : '—';
}
function fmtDur(min) {
  if (!min) return 'instantly';
  const h = Math.floor(min / 60), m = min % 60;
  return [h && `${h} hr`, m && `${m} min`].filter(Boolean).join(' ');
}
const SKIP_TEXT = { paused: 'Paused', day: 'Not scheduled tonight', season: 'Outside the season', skipped: 'Skipped tonight', 'no-sunset': 'No sunset here today' };

function eveningSummary(s) {
  if (!core || !s?.location) return '';
  const tz = s.location.tz;
  const now = new Date();
  const plan = core.currentPlan(s, now);
  if (plan.skip) {
    const next = core.nextRun(s, now);
    const when = next ? new Date(next.fullOn).toLocaleDateString([], { weekday: 'short', timeZone: tz }) : null;
    return `${SKIP_TEXT[plan.skip] || 'Off tonight'}${next ? ` · next ${when}` : ''}`;
  }
  const t = d => fmtTime(d, tz);
  return `Tonight · on ${t(plan.fadeInStart)} → ${t(plan.fullOn)} · off ${t(plan.fadeOutStart)} → ${t(plan.offAt)}`;
}

// The schedule line on a group card: what tonight brings, at a glance.
function tonightText(g, s) {
  const name = scheduledName(g, s);
  if (!s.enabled) return { title: 'Schedule paused', detail: `${name} · fades on at sunset when switched on` };
  if (!s.location) return { title: 'Schedule', detail: 'Needs the house location' };
  const tz = s.location.tz;
  const t = d => fmtTime(d, tz);
  const now = new Date();
  const current = core.currentPlan(s, now);
  const next = core.nextRun(s, now);
  if (current.skip) {
    const when = next && new Date(next.fullOn).toLocaleDateString([], { weekday: 'long', timeZone: tz });
    return { title: SKIP_TEXT[current.skip] || 'Off tonight', detail: next ? `Next: ${when} · ${name}` : name };
  }
  if (!next) return { title: 'Schedule', detail: name };
  // Something was played after tonight's fade-on started: that stays until the fade-off.
  const playedAt = gp(g.id).last?.at || 0;
  if (now >= next.fadeInStart && now < next.fadeOutStart && playedAt > next.fadeInStart.getTime()) {
    return { title: `Fades off at ${t(next.fadeOutStart)}`, detail: `Showing what you picked instead of ${name} · off by ${t(next.offAt)}` };
  }
  if (now >= next.fadeOutStart) return { title: `Fading off · ${name}`, detail: `Off by ${t(next.offAt)}` };
  if (now >= next.fullOn) return { title: `On now · ${name}`, detail: `Fades off ${t(next.fadeOutStart)} → ${t(next.offAt)}` };
  if (now >= next.fadeInStart) return { title: `Fading on · ${name}`, detail: `Fully on ${t(next.fullOn)} · fades off ${t(next.fadeOutStart)}` };
  const day = next.date === current.date ? 'Tonight'
    : next.date === core.ymd(core.addDays(core.zonedParts(now, tz), 1)) ? 'Tomorrow'
      : new Date(next.fullOn).toLocaleDateString([], { weekday: 'long', timeZone: tz });
  return {
    title: `${day} · ${name}`,
    detail: `Fades on ${t(next.fadeInStart)} → ${t(next.fullOn)} · off ${t(next.fadeOutStart)} → ${t(next.offAt)}`,
  };
}

function scheduleRow(g) {
  const s = schedules[g.id];
  if (!s) {
    return el('button', { class: 'schedule-row empty', onclick: () => openSchedule(g) },
      el('span', { class: 'sched-icon', text: '🌙' }),
      el('span', { class: 'grow' }, el('strong', { text: 'Add a schedule' }), el('span', { class: 'muted small', text: 'Fade on at sunset, fade off at bedtime' })),
      el('span', { class: 'chev', text: '›' }));
  }
  const { title, detail } = tonightText(g, s);
  return el('div', { class: 'schedule-row' + (s.enabled ? '' : ' paused') },
    el('button', { class: 'sched-open', 'aria-label': `Schedule: ${title}. ${detail}`, onclick: () => openSchedule(g) },
      el('span', { class: 'sched-icon', text: '🌙' }),
      el('span', { class: 'grow' }, el('strong', { text: title }), el('span', { class: 'muted small', text: detail }))),
    toggleSwitch(s.enabled, false, async e => {
      const enabled = e.target.checked;
      try {
        const res = await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: { ...s, enabled } });
        schedules[g.id] = res.schedule;
        showActivity(enabled ? '✓ Schedule on' : 'Schedule paused', 'ok');
      } catch (err) { showActivity(err.message, 'err'); }
      renderMain();
    }));
}

let sched = null; // the schedule being edited: { g, s, dirty }

async function openSchedule(g) {
  const existing = schedules[g.id];
  const s = existing ? clone(existing) : {
    ...clone(core.DEFAULT_SCHEDULE),
    id: scheduleId(g.id),
    groupId: g.id,
    groupName: g.name,
    location: Object.values(schedules).find(x => x.location)?.location || null,
    // New schedules fade on whatever was played last, so they never surprise you.
    pattern: { source: 'last', name: 'Last played' },
  };
  // Schedules from before patterns were linked kept only a name: link them up.
  if (!s.pattern.source) {
    const b = BUILTIN.find(x => x.name === s.pattern.name);
    const mine = saved.find(x => x.name === s.pattern.name);
    if (b) s.pattern = { ...s.pattern, source: 'builtin', id: b.id };
    else if (mine) s.pattern = { ...s.pattern, source: 'saved', id: mine.id };
  }
  sched = { g, s, isNew: !existing, start: JSON.stringify(s), picking: false };
  show('sched');
  window.scrollTo(0, 0);
  renderSchedule();
}

function closeSchedule(force = false) {
  if (!force && sched && JSON.stringify(sched.s) !== sched.start && !confirm('Leave without saving your schedule changes?')) return;
  sched = null;
  show('main');
  renderMain();
}

// ----- The schedule's pattern picker -----
// A schedule only chooses a pattern; patterns are made in the pattern maker.

const sameRef = (a, b) => a.source === b.source && (a.source === 'last' || (a.source ? a.id === b.id : a.name === b.name));

// Everything the schedule can show, as picker options.
function patternOptions(g) {
  const p = gp(g.id);
  const n = positions(g.lights, g.id).length;
  const ref = sched.s.pattern;
  const last = p.last?.cells ? p.last : null;
  const opts = [{
    ref: { source: 'last', name: 'Last played' },
    label: '↺ Last played',
    sub: last ? `Right now: ${patternLabel(last.name, last.id)} · follows what you play` : 'Nothing played yet, so ✨ Warm bulbs until you do',
    cells: last ? last.cells : patternCells(BUILTIN[0], g.id, n),
    group: null,
  }];
  // A saved pattern this phone can't see (someone else's, or deleted).
  if ((ref.source === 'saved' && !saved.some(x => x.id === ref.id)) || !ref.source) {
    opts.push({
      ref, label: `⭐ ${ref.name}`, cells: null, group: null,
      sub: ref.owner && ref.owner !== me?.id ? 'Chosen by someone else in the family' : 'Deleted · uses the colours it had when you chose it',
    });
  }
  for (const pt of saved) {
    opts.push({ ref: { source: 'saved', id: pt.id, name: pt.name }, label: `⭐ ${pt.name}`, cells: patternCells(pt, g.id, n), group: 'Your patterns', motion: patternMotion(pt) });
  }
  for (const pt of BUILTIN) {
    opts.push({ ref: { source: 'builtin', id: pt.id, name: pt.name }, label: pt.name, cells: patternCells(pt, g.id, n), group: 'Built in' });
  }
  return opts;
}

const MOTION_TEXT = { chase: 'Chases', breathe: 'Breathes', pulse: 'Pulses' };

function renderPatternPicker() {
  const { g, s } = sched;
  const opts = patternOptions(g);
  const chosen = opts.find(o => sameRef(o.ref, s.pattern)) || opts[0];
  const btn = $('#sched-pattern');
  btn.setAttribute('aria-expanded', String(sched.picking));
  btn.replaceChildren(
    previewStrip(chosen.cells),
    el('span', { class: 'grow' }, el('strong', { text: chosen.label }), el('span', { class: 'muted small', text: chosen.sub || (chosen.group === 'Your patterns' ? 'Your pattern' : chosen.group) || '' })),
    el('span', { class: 'chev', text: '›' }));
  const list = $('#sched-pattern-list');
  list.hidden = !sched.picking;
  if (!sched.picking) { list.replaceChildren(); return; }
  const rows = [];
  let group;
  for (const o of opts) {
    if (o.group && o.group !== group) rows.push(el('div', { class: 'pick-group', text: o.group }));
    group = o.group || group;
    const active = o === chosen;
    rows.push(el('button', {
      class: 'pick-option' + (active ? ' active' : ''), role: 'radio', 'aria-checked': String(active),
      onclick: () => {
        sched.picking = false;
        setSched({ pattern: { ...o.ref } });
        $('#sched-pattern').focus();
      },
    },
    previewStrip(o.cells),
    el('span', { class: 'grow' },
      el('strong', { text: o.label }),
      (o.sub || MOTION_TEXT[o.motion?.type]) && el('span', { class: 'muted small', text: o.sub || MOTION_TEXT[o.motion.type] })),
    el('span', { class: 'check', text: active ? '✓' : '' })));
  }
  list.replaceChildren(...rows);
}

function renderSchedule() {
  const { g, s } = sched;
  $('#sched-sub').textContent = `${g.name} · ${house.name}`;
  $('#sched-save').textContent = sched.isNew ? 'Save' : JSON.stringify(s) === sched.start ? 'Saved ✓' : 'Save';
  $('#sched-save').classList.toggle('primary', JSON.stringify(s) !== sched.start || sched.isNew);

  // Lights on
  document.querySelectorAll('#on-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.on.mode));
  $('#on-sunset-row').hidden = s.on.mode !== 'sunset';
  $('#on-time-row').hidden = s.on.mode !== 'time';
  $('#on-offset').value = s.on.offsetMin;
  const off = s.on.offsetMin;
  $('#on-offset-label').textContent = off === 0 ? 'Right at sunset' : `${Math.abs(off)} min ${off < 0 ? 'before' : 'after'} sunset`;
  $('#on-time').value = s.on.time;
  $('#on-fade').value = s.on.fadeMin;
  $('#on-fade-label').textContent = s.on.fadeMin ? `Fade in over ${fmtDur(s.on.fadeMin)}` : 'Turn on instantly';

  // Lights off
  $('#off-time').value = s.off.time;
  $('#off-fade').value = s.off.fadeMin;
  $('#off-fade-label').textContent = s.off.fadeMin ? `Fade out over ${fmtDur(s.off.fadeMin)}` : 'Turn off instantly';

  // Pattern
  renderPatternPicker();
  $('#sched-level').value = Math.round(s.level * 100);
  $('#sched-level-label').textContent = `${Math.round(s.level * 100)}%`;

  // Days
  document.querySelectorAll('#sched-days button').forEach(b => b.classList.toggle('active', s.days.includes(+b.dataset.day)));
  $('#season-on').checked = !!s.season;
  $('#season-fields').hidden = !s.season;
  if (s.season) {
    const yr = new Date().getFullYear();
    $('#season-from').value = `${yr}-${s.season.from}`;
    $('#season-to').value = `${s.season.from <= s.season.to ? yr : yr + 1}-${s.season.to}`;
  }

  // Location
  $('#loc-text').textContent = s.location
    ? `Sunset times for ${s.location.lat.toFixed(2)}, ${s.location.lon.toFixed(2)} (${s.location.tz.replace(/_/g, ' ')})`
    : 'Needed once, to work out sunset at this house.';
  $('#loc-btn').textContent = s.location ? 'Update' : '📍 Use my location';
  $('#loc-btn').classList.toggle('primary', !s.location);

  // Tonight
  const today = s.location ? core.ymd(core.zonedParts(new Date(), s.location.tz)) : null;
  $('#skip-btn').hidden = sched.isNew || !s.location;
  $('#skip-btn').textContent = s.skipDates.includes(today) ? '↩︎ Run tonight after all' : '⏭ Skip tonight';
  $('#sched-delete').hidden = sched.isNew;
  $('#sched-enabled').checked = s.enabled;

  // Timer health (only once something is saved)
  const stale = !timerInfo?.lastTick || Date.now() - timerInfo.lastTick > 20 * 60000;
  $('#timer-warning').hidden = sched.isNew || !timerInfo || (timerInfo.configured && !stale);
  $('#timer-warning').textContent = !timerInfo?.configured
    ? '⚠️ The schedule timer isn’t set up on the server yet, so this won’t run.'
    : '⏳ Waiting for the schedule timer to check in (it runs every 5 minutes).';

  renderTimeline();
}

// The evening as a picture: dark sky after sunset, a warm glow that ramps up,
// holds, and ramps down.
function renderTimeline() {
  const { s } = sched;
  const box = $('#timeline');
  if (!s.location) {
    box.replaceChildren(el('div', { class: 'timeline-empty muted small', text: 'Add your location below to see tonight’s timeline.' }));
    $('#timeline-caption').textContent = '';
    return;
  }
  const tz = s.location.tz;
  const now = new Date();
  const todayParts = core.zonedParts(now, tz);
  const today = { y: todayParts.y, m: todayParts.m, d: todayParts.d };
  // Preview tonight even if it is skipped or paused, so the shape is always visible.
  const preview = core.planFor({ ...s, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], season: null, skipDates: [] }, today);
  const real = core.planFor(s, today);
  if (!preview.fullOn) {
    box.replaceChildren(el('div', { class: 'timeline-empty muted small', text: 'No sunset at this location today.' }));
    return;
  }
  const t0 = Math.min(preview.fadeInStart, preview.sunset ?? Infinity) - 60 * 60000;
  const t1 = preview.offAt.getTime() + 45 * 60000;
  const W = 340, H = 150, top = 24, base = 112;
  const x = t => 8 + ((t - t0) / (t1 - t0)) * (W - 16);
  const y = level => base - level * (base - top);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const add = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    svg.append(n);
    return n;
  };
  const sunsetX = preview.sunset ? x(preview.sunset) : x(preview.fullOn);
  const defs = add('defs', {});
  defs.innerHTML = `
    <linearGradient id="sky" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#2a3550"/>
      <stop offset="${Math.max(0, (sunsetX - 30) / W)}" stop-color="#3a3350"/>
      <stop offset="${Math.min(1, (sunsetX + 10) / W)}" stop-color="#1a1d2e"/>
      <stop offset="1" stop-color="#0d0f18"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#ffcf7a" stop-opacity=".95"/>
      <stop offset="1" stop-color="#ff9f43" stop-opacity=".15"/>
    </linearGradient>`;
  add('rect', { x: 0, y: 0, width: W, height: base + 4, rx: 12, fill: 'url(#sky)' });

  // Hour ticks
  const startHour = new Date(t0);
  startHour.setMinutes(0, 0, 0);
  for (let t = startHour.getTime() + 3600000; t < t1; t += 3600000) {
    const label = new Date(t).toLocaleTimeString([], { hour: 'numeric', timeZone: tz });
    if (core.zonedParts(new Date(t), tz).hh % 2) continue;
    add('line', { x1: x(t), x2: x(t), y1: base, y2: base + 5, stroke: '#4a505c' });
    add('text', { x: x(t), y: base + 16, 'text-anchor': 'middle', class: 'tl-hour' }, label.replace(/\s?[AP]M$/, '').trim() + (label.includes('PM') ? 'p' : 'a'));
  }

  // Glow shape
  const lvl = s.level;
  const pts = [[x(preview.fadeInStart), y(0)], [x(preview.fullOn), y(lvl)], [x(preview.fadeOutStart), y(lvl)], [x(preview.offAt), y(0)]];
  add('polygon', { points: [...pts, [pts[3][0], base], [pts[0][0], base]].map(p => p.join(',')).join(' '), fill: 'url(#glow)', opacity: real.skip ? 0.25 : 1 });
  add('polyline', { points: pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: '#ffb547', 'stroke-width': 2.5, 'stroke-linejoin': 'round', opacity: real.skip ? 0.4 : 1 });

  // Sunset marker
  if (preview.sunset) {
    add('line', { x1: sunsetX, x2: sunsetX, y1: 8, y2: base, stroke: '#ff8a5c', 'stroke-dasharray': '3 3' });
    add('text', { x: sunsetX, y: 18, 'text-anchor': 'middle', class: 'tl-sun' }, `☀︎ ${fmtTime(preview.sunset, tz)}`);
  }
  // Now marker
  if (now >= t0 && now <= t1) {
    add('line', { x1: x(now), x2: x(now), y1: top - 6, y2: base, stroke: '#ffffff', 'stroke-opacity': 0.5 });
    add('text', { x: x(now), y: base - 4, 'text-anchor': 'middle', class: 'tl-now' }, 'now');
  }
  // Key times under the curve
  const marks = [[preview.fadeInStart, 'start'], [preview.fullOn, 'end'], [preview.fadeOutStart, 'start'], [preview.offAt, 'end']];
  marks.forEach(([t, anchor], i) => add('text', {
    x: x(t), y: base + 30, 'text-anchor': i % 2 ? 'start' : 'end', class: 'tl-time', dx: i % 2 ? 3 : -3,
  }, fmtTime(t, tz)));
  marks.forEach(([t]) => add('circle', { cx: x(t), cy: base, r: 3, fill: '#ffb547' }));
  box.replaceChildren(svg);

  const t = d => fmtTime(d, tz);
  $('#timeline-caption').textContent = real.skip
    ? `${SKIP_TEXT[real.skip] || 'Not running tonight'}. Shown as it would look.`
    : `Fading on ${t(preview.fadeInStart)} → fully on ${t(preview.fullOn)}${preview.sunset && s.on.mode === 'sunset' && !s.on.offsetMin ? ' (sunset)' : ''}. Fading off ${t(preview.fadeOutStart)} → off by ${t(preview.offAt)}.`;
}

function setSched(change) {
  Object.assign(sched.s, change);
  renderSchedule();
}

// The server works out the pattern's colours when it fades the lights on, so
// edits in the pattern maker are picked up. It also keeps these colours, used
// only if the pattern can't be found then (e.g. it was deleted).
function scheduleSnapshot(g, ref) {
  const pt = resolvePattern(ref, { prefs: gp(g.id), savedPatterns: saved });
  if (!pt && ref.states?.length) return { name: ref.name, states: ref.states, motion: ref.motion }; // someone else's: keep it
  const use = pt || BUILTIN[0];
  const pos = positions(g.lights, g.id);
  return {
    name: ref.source === 'last' ? (pt ? pt.name : 'Last played') : use.name,
    states: cellsToStates(pos, patternCells(use, g.id, pos.length), 1),
    motion: patternMotion(use),
  };
}

// After a saved pattern changes, refresh the stand-in colours of this house's
// schedules that use it (the schedule itself already follows the pattern).
async function refreshSchedulesUsing(patternId) {
  for (const [gid, s] of Object.entries(schedules)) {
    const g = groupById(gid);
    if (!g || s.pattern.source !== 'saved' || s.pattern.id !== patternId) continue;
    try {
      const res = await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: { ...s, pattern: { ...s.pattern, ...scheduleSnapshot(g, s.pattern) } } });
      schedules[gid] = res.schedule;
    } catch { /* the schedule still follows the pattern; only the stand-in is older */ }
  }
}
const schedulesUsing = patternId => Object.values(schedules).filter(s => s.pattern.source === 'saved' && s.pattern.id === patternId);

async function saveSchedule() {
  const { g, s } = sched;
  if (!s.location) { alert('Add the house location first, so the app knows when sunset is.'); return; }
  const body = { ...s, pattern: { ...s.pattern, ...scheduleSnapshot(g, s.pattern) } };
  const btn = $('#sched-save');
  btn.disabled = true;
  try {
    const res = await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: body });
    schedules[g.id] = res.schedule;
    if (res.timer) timerInfo = { ...timerInfo, ...res.timer };
    if (res.timer?.error) showActivity('Saved, but the schedule timer couldn’t be switched on. Try saving again in a minute.', 'err');
    else showActivity(`✓ Schedule saved · ${eveningSummary(res.schedule)}`, 'ok');
    sched.s = clone(res.schedule);
    sched.isNew = false;
    sched.start = JSON.stringify(sched.s);
    renderSchedule();
  } catch (e) {
    showActivity(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Sharing patterns ----------
// A share link carries the pattern in the URL (#p=…). No token, no server.

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)));
}

async function sharePattern(pt) {
  // Leave out the full list when it's just the loop repeated (much shorter link).
  const plain = JSON.stringify(tile(pt.loop, pt.cells.length)) === JSON.stringify(pt.cells);
  const data = { n: pt.name, l: pt.loop, ...(plain ? {} : { c: pt.cells }), e: pt.effect, m: pt.motion };
  const url = `${location.origin}${location.pathname}#p=${b64urlEncode(JSON.stringify(data))}`;
  try {
    if (navigator.share) await navigator.share({ title: `House Lights pattern: ${pt.name}`, url });
    else { await navigator.clipboard.writeText(url); showActivity('✓ Share link copied', 'ok'); }
  } catch (e) {
    if (e.name !== 'AbortError') showActivity('Could not share this pattern.', 'err');
  }
}

function importFromHash() {
  const m = location.hash.match(/^#p=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  try {
    const d = JSON.parse(b64urlDecode(m[1]));
    const valid = x => x && typeof x.c === 'string' && x.c.length < 60 && typeof x.b === 'number';
    if (typeof d.n !== 'string' || !Array.isArray(d.l) || !d.l.length || !d.l.every(valid) || (d.c && !d.c.every(valid))) throw 0;
    if (!confirm(`Add the shared pattern “${d.n}” to your patterns?`)) return;
    saved.push({ id: `p-${Date.now().toString(36)}`, name: d.n.slice(0, 40), loop: d.l, cells: d.c, effect: legacyEffect(normalizeMotion(d.e, d.m || {})), motion: normalizeMotion(d.e, d.m || {}) });
    savePatterns();
    showActivity(`✓ Added “${d.n}” to your patterns`, 'ok');
  } catch {
    showActivity('That pattern link looks broken.', 'err');
  }
}

// ---------- Screens and loading ----------

function show(screen) {
  for (const s of ['auth', 'main', 'maker', 'sched']) $(`#${s}`).hidden = screen !== s;
}

async function loadLights() {
  lights = await api('GET', '/lights/all');
  if (!maker) renderMain();
}

async function refresh(label = 'Refreshing lights') {
  if (activity.busy) return;
  activity.busy = label;
  step('asking LIFX…');
  try {
    await loadLights();
    showActivity(`✓ ${lights.length} light${lights.length === 1 ? '' : 's'} up to date`, 'ok');
  } catch (e) {
    handleError(e, label);
  } finally {
    activity.busy = null;
  }
}

function handleError(e, label) {
  if (e.code === 'signed_out' && !demo) {
    $('#activity').hidden = true;
    signedOut();
    return;
  }
  showActivity(`${label ? `${label} — ` : ''}${e.message}`, 'err');
}

// ---------- Signing in ----------

const inviteFromLink = () => (location.hash.match(/^#invite=([\w-]{20,64})$/) || [])[1] || null;
let prepared = null; // { kind, flowId, options, at } — fetched before the tap so Face ID opens instantly
let refreshLoginTimer = null;

function showAuth(panel, text = '') {
  clearInterval(refreshLoginTimer);
  show('auth');
  for (const p of ['signin', 'setup', 'join', 'notready']) $(`#auth-${p}`).hidden = p !== panel;
  $('#notready-text').textContent = text;
  authError('');
  $('#auth-version').textContent = `App version ${APP_VERSION}`;
  if (panel === 'signin') {
    prepareLogin();
    refreshLoginTimer = setInterval(prepareLogin, 4 * 60 * 1000); // options expire after 5 minutes
  }
  if (panel === 'setup' || panel === 'join') {
    prepared = null;
    $(`#${panel}-continue`).hidden = false;
    $(`#${panel}-create`).hidden = true;
  }
}

function authError(msg) {
  $('#auth-error').textContent = msg;
  $('#auth-error').hidden = !msg;
}

async function prepareLogin() {
  try {
    const o = await server('POST', 'auth/login/options', {});
    prepared = { kind: 'login', ...o, at: Date.now() };
  } catch (e) {
    prepared = null;
    authError(e.message);
  }
}

async function signedOut(info = null) {
  sessionToken = null;
  me = null;
  if (!info) {
    try { await server('GET', 'me'); } catch (e) { info = e.status === 401 ? e.data : null; }
  }
  if (!info) return showAuth('notready', 'Couldn’t reach House Lights. Check your connection and try again.');
  if (!window.PublicKeyCredential) return showAuth('notready', 'This browser doesn’t support passkeys. Please update your iPhone or open the app in Safari.');
  if (info.storageConfigured === false) return showAuth('notready', 'Almost ready: the database (Upstash Redis) isn’t connected to this Vercel project yet.');
  if (!info.housesConfigured) return showAuth('notready', 'Almost ready: no houses yet. Add a LIFX_TOKEN_… environment variable in Vercel, then redeploy.');
  if (inviteFromLink()) return showAuth('join');
  if (info.setupNeeded) {
    return info.setupCodeConfigured ? showAuth('setup')
      : showAuth('notready', 'Almost ready: add a SETUP_CODE environment variable in Vercel, then redeploy.');
  }
  showAuth('signin');
}

async function afterSignIn(result) {
  sessionToken = result.sessionToken;
  if (inviteFromLink()) history.replaceState(null, '', location.pathname);
  await boot();
}

$('#signin-btn').addEventListener('click', async () => {
  const btn = $('#signin-btn');
  authError('');
  if (!prepared || prepared.kind !== 'login' || Date.now() - prepared.at > 4.5 * 60 * 1000) await prepareLogin();
  if (!prepared) return;
  const { flowId, options } = prepared;
  prepared = null;
  btn.disabled = true;
  try {
    const response = await getPasskey(options);
    await afterSignIn(await server('POST', 'auth/login/verify', { flowId, response }));
  } catch (e) {
    authError(e.status ? e.message : passkeyMessage(e));
    prepareLogin();
  } finally {
    btn.disabled = false;
  }
});

// Setup and joining are two taps: "Continue" checks details with the server,
// then "Create passkey" opens Face ID straight away (iPhones require that the
// passkey prompt comes directly from a tap).
async function continueRegistration(kind) {
  authError('');
  const name = $(`#${kind}-name`).value.trim();
  if (!name) { authError('Please enter your name.'); return; }
  const btn = $(`#${kind}-continue`);
  btn.disabled = true;
  try {
    const o = kind === 'setup'
      ? await server('POST', 'auth/setup/options', { name, code: $('#setup-code').value })
      : await server('POST', 'auth/invite/options', { name, invite: inviteFromLink() });
    prepared = { kind, ...o, at: Date.now() };
    btn.hidden = true;
    $(`#${kind}-create`).hidden = false;
  } catch (e) {
    authError(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function createRegistration(kind) {
  if (!prepared || prepared.kind !== kind) return showAuth(kind);
  const { flowId, options } = prepared;
  prepared = null;
  const btn = $(`#${kind}-create`);
  btn.disabled = true;
  try {
    const response = await createPasskey(options);
    await afterSignIn(await server('POST', 'auth/register/verify', { flowId, response }));
  } catch (e) {
    authError(e.status ? e.message : passkeyMessage(e));
    $(`#${kind}-continue`).hidden = false;
    btn.hidden = true;
  } finally {
    btn.disabled = false;
  }
}

$('#setup-continue').addEventListener('click', () => continueRegistration('setup'));
$('#join-continue').addEventListener('click', () => continueRegistration('join'));
$('#setup-create').addEventListener('click', () => createRegistration('setup'));
$('#join-create').addEventListener('click', () => createRegistration('join'));
$('#notready-retry').addEventListener('click', () => boot());

// ---------- Houses ----------

async function boot() {
  demo = false;
  let data;
  try {
    data = await server('GET', 'me');
  } catch (e) {
    if (e.status === 401) return signedOut(e.data);
    return showAuth('notready', `Couldn’t reach House Lights. ${e.message}`);
  }
  me = data.user;
  houses = data.houses;
  try {
    const p = await server('GET', 'prefs/user');
    saved = Array.isArray(p.prefs.patterns) ? p.prefs.patterns : [];
  } catch { saved = []; }
  if (!houses.length) {
    return showAuth('notready', me.admin
      ? 'No houses are set up yet. Add a LIFX_TOKEN_… environment variable in Vercel, then redeploy.'
      : 'You don’t have access to any houses yet. Ask the family admin.');
  }
  const last = local.get('active');
  await setActive(houses.find(h => h.key === last) || houses[0]);
  importFromHash();
}

async function setActive(h) {
  flushSync();
  house = h;
  demo = false;
  local.set('active', h.key);
  lights = [];
  maker = null;
  identifySnapshot = null;
  openKeys.clear();
  groupPrefs = {};
  show('main');
  $('#status').textContent = '';
  $('#house-name').textContent = h.name;
  $('#groups').replaceChildren();
  schedules = {};
  try {
    const [p, sc] = await Promise.all([
      server('GET', `prefs/house/${h.key}`),
      server('GET', `schedules/${h.key}`),
    ]);
    if (house !== h) return; // switched again meanwhile
    groupPrefs = p.prefs.groups || {};
    schedules = Object.fromEntries(sc.schedules.map(x => [x.groupId, x]));
    timerInfo = sc.timer;
  } catch (e) {
    if (e.code === 'signed_out') return signedOut();
  }
  await refresh('Loading your lights');
}

$('#demo-btn').addEventListener('click', () => {
  clearInterval(refreshLoginTimer);
  demo = true;
  house = null;
  groupPrefs = {};
  saved = [];
  show('main');
  refresh('Loading demo lights');
});

document.querySelectorAll('[data-all]').forEach(b =>
  b.addEventListener('click', () => run(`Everything ${b.dataset.all}`, () => setState('all', { power: b.dataset.all }))));

// ---------- Houses & family sheet ----------

function openHouses() {
  $('#house-list').replaceChildren(...(demo ? [] : houses).map(h =>
    el('div', { class: 'house-row' },
      el('button', {
        class: 'house-item' + (h.key === house?.key ? ' current' : ''),
        onclick: () => {
          if (activity.busy) { showActivity(`Still working on “${activity.busy}” — switch houses when it’s done`); return; }
          $('#settings').close();
          if (h.key !== house?.key) setActive(h);
        },
      }, el('span', { text: h.name }), h.key === house?.key ? el('span', { class: 'muted small', text: '✓ showing' }) : null),
      me?.admin && el('button', { class: 'small', 'aria-label': `Rename ${h.name}`, onclick: () => renameHouse(h) }, 'Rename'))));
  $('#settings-info').textContent = demo
    ? 'You are in demo mode. No real lights are being changed.'
    : `Signed in as ${me?.name}${me?.admin ? ' (family admin)' : ''}.`;
  $('#leave-demo').hidden = !demo;
  $('#signout-btn').hidden = demo;
  $('#refresh-btn').hidden = false;
  $('#family-section').hidden = demo || !me?.admin;
  $('#invite-form').hidden = true;
  $('#invite-result').hidden = true;
  $('#app-version').textContent = `App version ${APP_VERSION}`;
  $('#settings').showModal();
  if (!demo && me?.admin) loadFamily();
}

async function renameHouse(h) {
  const name = prompt('House name', h.name)?.trim();
  if (!name || name === h.name) return;
  try {
    await server('PUT', `houses/${h.key}`, { name });
    h.name = name.slice(0, 40);
    if (house?.key === h.key) $('#house-name').textContent = h.name;
    openHouses();
  } catch (e) { alert(e.message); }
}

async function loadFamily() {
  const list = $('#family-list');
  list.replaceChildren(el('p', { class: 'muted small', text: 'Loading…' }));
  try {
    const f = await server('GET', 'family');
    const names = Object.fromEntries(f.houses.map(h => [h.key, h.name]));
    const which = keys => (keys ? keys.map(k => names[k] || k).join(', ') : 'all houses');
    list.replaceChildren(
      ...f.users.map(u => el('div', { class: 'person' },
        el('div', { class: 'grow' },
          el('strong', { text: u.id === me.id ? `${u.name} (you)` : u.name }),
          el('div', { class: 'muted small', text: `${u.admin ? 'Admin · ' : ''}${which(u.houses)}` })),
        u.id !== me.id && el('button', { class: 'small danger', onclick: () => removePerson(u) }, 'Remove'))),
      ...f.invites.map(i => el('div', { class: 'person' },
        el('div', { class: 'grow' },
          el('strong', { text: `Invite: ${i.label}` }),
          el('div', { class: 'muted small', text: `${which(i.houses)} · not used yet · expires ${new Date(i.expires).toLocaleDateString()}` })),
        el('button', { class: 'small', onclick: () => cancelInvite(i) }, 'Cancel'))));
    $('#invite-houses').replaceChildren(...f.houses.map(h =>
      el('label', { class: 'inline' }, el('input', { type: 'checkbox', value: h.key }), h.name)));
  } catch (e) {
    list.replaceChildren(el('p', { class: 'error small', text: e.message }));
  }
}

async function removePerson(u) {
  if (!confirm(`Remove ${u.name}? They’ll be signed out and their passkey will stop working.`)) return;
  try { await server('DELETE', `family/users/${u.id}`); loadFamily(); } catch (e) { alert(e.message); }
}

async function cancelInvite(i) {
  try { await server('DELETE', `family/invites/${i.id}`); loadFamily(); } catch (e) { alert(e.message); }
}

$('#invite-btn').addEventListener('click', () => {
  $('#invite-form').hidden = false;
  $('#invite-result').hidden = true;
  $('#invite-name').value = '';
  $('#invite-houses').querySelectorAll('input').forEach(i => (i.checked = false));
});

$('#invite-create').addEventListener('click', async () => {
  const label = $('#invite-name').value.trim();
  const chosen = [...$('#invite-houses').querySelectorAll('input:checked')].map(i => i.value);
  if (!label) return alert('Who is this invite for?');
  if (!chosen.length) return alert(ERRORS.choose_a_house);
  try {
    const inv = await server('POST', 'family/invites', { label, houses: chosen });
    $('#invite-link').value = `${location.origin}/#invite=${inv.code}`;
    $('#invite-form').hidden = true;
    $('#invite-result').hidden = false;
    loadFamily();
  } catch (e) { alert(e.message); }
});

$('#invite-share').addEventListener('click', async () => {
  const url = $('#invite-link').value;
  try {
    if (navigator.share) await navigator.share({ title: 'Join House Lights', text: 'Tap to set up House Lights with Face ID:', url });
    else { await navigator.clipboard.writeText(url); showActivity('✓ Invite link copied', 'ok'); }
  } catch (e) {
    if (e.name !== 'AbortError') { $('#invite-link').select(); }
  }
});

$('#settings-btn').addEventListener('click', openHouses);
$('#house-switch').addEventListener('click', openHouses);
$('#close-settings').addEventListener('click', () => $('#settings').close());
$('#refresh-btn').addEventListener('click', () => { $('#settings').close(); refresh(); });
$('#leave-demo').addEventListener('click', () => { $('#settings').close(); boot(); });
$('#signout-btn').addEventListener('click', async () => {
  if (!confirm('Sign out of House Lights on this phone?')) return;
  flushSync();
  $('#settings').close();
  try { await server('POST', 'auth/logout', {}); } catch { /* signing out anyway */ }
  signedOut();
});

// Pattern maker controls
$('#maker-back').addEventListener('click', () => closeMaker());
$('#maker-undo').addEventListener('click', undo);
$('#maker-rename').addEventListener('click', () => {
  const name = prompt('Name this pattern', maker.name || '')?.trim();
  if (name == null || name === '') return;
  maker.name = name.slice(0, 40);
  renderHeader();
});
$('#seq-remove').addEventListener('click', () => {
  if (maker.seq.length <= 1) return;
  remember();
  maker.seq.pop();
  if (maker.sel?.kind === 'seq') {
    maker.sel.idx.delete(maker.seq.length);
    if (!maker.sel.idx.size) closeSheet();
  }
  renderSeq();
  afterEdit();
});
$('#house-grid').addEventListener('click', e => {
  const node = e.target.closest('.cell[data-kind="house"]');
  if (node) select('house', [+node.dataset.i]);
});
$('#sheet-close').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && maker?.sel) closeSheet(); });
// Tapping an empty part of the page closes the sheet.
$('#maker').addEventListener('click', e => {
  if (!maker?.sel || gesture) return;
  if (e.target.closest('#light-sheet, .cell, .add-cell, button, input, select, a, label')) return;
  closeSheet();
});
$('#overrides-reset').addEventListener('click', () => {
  remember();
  maker.overrides = {};
  afterEdit();
});
document.querySelectorAll('#effect-seg button').forEach(b => b.addEventListener('click', () => setMotion({ type: b.dataset.kind })));
document.querySelectorAll('#dir-seg button').forEach(b => b.addEventListener('click', () => setMotion({ dir: b.dataset.dir })));
// Dragging the speed slider is one undo step, saved when you let go.
let speedDragStart = null;
$('#speed-slider').addEventListener('input', e => {
  if (!speedDragStart) speedDragStart = JSON.stringify({ seq: maker.seq, overrides: maker.overrides, motion: maker.motion });
  maker.motion = { ...maker.motion, speed: e.target.value / 100 };
  renderHeader();
  renderShowButton();
});
$('#speed-slider').addEventListener('change', () => {
  if (speedDragStart) {
    maker.history.push(speedDragStart);
    speedDragStart = null;
    renderHeader();
  }
});
$('#maker-preview').addEventListener('click', () => {
  const m = maker;
  const g = groupById(m.gid);
  const cells = makerCells(m);
  const key = sendKey(m);
  run(`Show on house · ${g.name}`, async () => {
    const unchanged = m.editingId && !isDirty();
    await paintGroup(g, cells, m.motion, unchanged ? { name: m.name, id: m.editingId } : { name: m.name ? `${m.name} (edited)` : 'New pattern' });
    m.sent = key;
  }).then(() => { if (maker === m) renderShowButton(); });
});
$('#maker-save').addEventListener('click', () => {
  if (!maker.name) {
    const name = prompt('Name this pattern', '')?.trim();
    if (!name) return;
    maker.name = name.slice(0, 40);
  }
  const pt = makerPattern();
  const i = saved.findIndex(p => p.id === pt.id);
  if (i >= 0) saved[i] = pt; else saved.push(pt);
  savePatterns();
  maker.editingId = pt.id;
  maker.savedState = editState();
  renderMaker();
  const using = schedulesUsing(pt.id);
  showActivity(using.length
    ? `✓ Saved “${pt.name}” · your ${using.map(s => s.groupName).join(' & ')} schedule uses the new version`
    : `✓ Saved “${pt.name}” — it’s in your Patterns`, 'ok');
  if (using.length) { flushSync('prefs/user'); refreshSchedulesUsing(pt.id); }
});
$('#maker-share').addEventListener('click', () => sharePattern(makerPattern()));
$('#maker-delete').addEventListener('click', () => {
  const pt = saved.find(p => p.id === maker.editingId);
  const using = schedulesUsing(pt?.id);
  const warning = using.length
    ? `\n\nYour ${using.map(s => s.groupName).join(' & ')} schedule uses it. It will keep using the colours it has now until you pick another pattern for it.`
    : '';
  if (!pt || !confirm(`Delete the pattern “${pt.name}”?${warning}`)) return;
  saved = saved.filter(p => p.id !== pt.id);
  savePatterns();
  showActivity(`Deleted “${pt.name}”`, 'ok');
  closeMaker(true);
});

// Schedule controls
$('#sched-back').addEventListener('click', () => closeSchedule());
$('#sched-pattern').addEventListener('click', () => { sched.picking = !sched.picking; renderPatternPicker(); });
$('#sched-save').addEventListener('click', saveSchedule);
document.querySelectorAll('#on-mode button').forEach(b => b.addEventListener('click', () => setSched({ on: { ...sched.s.on, mode: b.dataset.mode } })));
$('#on-offset').addEventListener('input', e => setSched({ on: { ...sched.s.on, offsetMin: +e.target.value } }));
$('#on-time').addEventListener('change', e => e.target.value && setSched({ on: { ...sched.s.on, time: e.target.value } }));
$('#on-fade').addEventListener('input', e => setSched({ on: { ...sched.s.on, fadeMin: +e.target.value } }));
$('#off-time').addEventListener('change', e => e.target.value && setSched({ off: { ...sched.s.off, time: e.target.value } }));
$('#off-fade').addEventListener('input', e => setSched({ off: { ...sched.s.off, fadeMin: +e.target.value } }));
$('#sched-level').addEventListener('input', e => setSched({ level: +e.target.value / 100 }));
$('#sched-enabled').addEventListener('change', e => setSched({ enabled: e.target.checked }));
document.querySelectorAll('#sched-days button').forEach(b => b.addEventListener('click', () => {
  const d = +b.dataset.day;
  const days = sched.s.days.includes(d) ? sched.s.days.filter(x => x !== d) : [...sched.s.days, d].sort();
  if (!days.length) return showActivity('Pick at least one day.', 'err');
  setSched({ days });
}));
$('#season-on').addEventListener('change', e => {
  // Default season: from today until just after New Year.
  const t = new Date();
  const from = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  setSched({ season: e.target.checked ? { from, to: '01-06' } : null });
});
['#season-from', '#season-to'].forEach(id => $(id).addEventListener('change', () => {
  const md = v => v && v.slice(5);
  if (md($('#season-from').value) && md($('#season-to').value)) setSched({ season: { from: md($('#season-from').value), to: md($('#season-to').value) } });
}));
$('#loc-btn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('This browser can’t share its location.');
  $('#loc-btn').disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    $('#loc-btn').disabled = false;
    setSched({ location: {
      lat: Math.round(pos.coords.latitude * 100) / 100,
      lon: Math.round(pos.coords.longitude * 100) / 100,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } });
  }, err => {
    $('#loc-btn').disabled = false;
    alert(err.code === 1
      ? 'Location is turned off for this app. Allow it in Settings › Privacy & Security › Location Services › Safari Websites, then try again.'
      : 'Couldn’t get your location. Please try again.');
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
});
$('#skip-btn').addEventListener('click', async () => {
  const s = sched.s;
  const today = core.ymd(core.zonedParts(new Date(), s.location.tz));
  s.skipDates = s.skipDates.includes(today) ? s.skipDates.filter(d => d !== today) : [...s.skipDates, today];
  await saveSchedule();
});
$('#sched-delete').addEventListener('click', async () => {
  if (!confirm('Delete this schedule? Your lights won’t change on their own any more.')) return;
  try {
    await server('DELETE', `schedules/${house.key}/${sched.s.id}`);
    delete schedules[sched.g.id];
    showActivity('Schedule deleted', 'ok');
    closeSchedule(true);
  } catch (e) { showActivity(e.message, 'err'); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushSync(); return; }
  if ((house || demo) && !$('#main').hidden) refresh('Checking for changes');
});
window.addEventListener('pagehide', () => flushSync());

// ---------- Demo mode (fake lights, no network) ----------

function demoStrip(id, label, count, group, hue) {
  return {
    id, label, power: 'on', brightness: 0.8, connected: true,
    color: { hue, saturation: 1, kelvin: 3500 },
    zones: { count, zones: Array.from({ length: count }, (_, zone) => ({ zone, hue, saturation: 1, kelvin: 3500, brightness: 0.8 })) },
    group, location: { name: 'Demo House' },
    product: { name: 'LIFX Permanent Outdoor', capabilities: { has_color: true, has_multizone: true } },
  };
}
const DEMO_HOLIDAY = { id: 'demo-holiday', name: 'Holiday' };
const demoLights = [
  demoStrip('demo-front', 'Front Porch', 10, DEMO_HOLIDAY, 0),
  demoStrip('demo-garage', 'Garage', 20, DEMO_HOLIDAY, 120),
  demoStrip('demo-side', 'Side Yard', 30, DEMO_HOLIDAY, 225),
  { id: 'demo-lamp', label: 'Porch Lamp', power: 'off', brightness: 0.6, connected: true,
    color: { hue: 0, saturation: 0, kelvin: 2700 }, group: { id: 'demo-porch', name: 'Porch' }, location: { name: 'Demo House' },
    product: { name: 'LIFX Bulb', capabilities: { has_color: true, has_multizone: false } } },
];

function mockTargets(selector) {
  const [base, range] = selector.split('|');
  const [kind, value] = base.split(':');
  const ls = demoLights.filter(l => l.connected && (kind === 'all' || (kind === 'group_id' && l.group.id === value) || (kind === 'id' && l.id === value)));
  return ls.map(l => {
    if (!l.zones) return { l, zones: null };
    const [a, b] = range ? range.split('-').map(Number) : [0, l.zones.count - 1];
    return { l, zones: l.zones.zones.slice(a, (b ?? a) + 1) };
  });
}

function mockApply(selector, state) {
  for (const { l, zones } of mockTargets(selector)) {
    if (state.power) l.power = state.power;
    const targets = zones || [l];
    for (const z of targets) {
      const tgt = zones ? z : l.color;
      if (state.color) Object.assign(tgt, parseColor(state.color));
      if (state.brightness != null) (zones ? (z.brightness = state.brightness) : (l.brightness = state.brightness));
    }
    if (l.zones) {
      l.color = { ...l.zones.zones[0] };
      l.brightness = Math.max(...l.zones.zones.map(z => z.brightness));
    }
  }
}

async function mockApi(method, path, body) {
  await wait(150);
  if (method === 'GET') return structuredClone(demoLights);
  const m = path.match(/^\/lights\/([^/]+)\/state$/);
  if (m) mockApply(decodeURIComponent(m[1]), body);
  if (path === '/lights/states') body.states.forEach(s => mockApply(s.selector, { ...body.defaults, ...s }));
  return { results: [] };
}

// ---------- Boot ----------

boot();
