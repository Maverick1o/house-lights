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
 * Where colors live:
 *   - The pattern maker is the one place patterns are made and edited.
 *   - The home screen plays them now ("play now"), and shows what's showing.
 *   - A schedule only picks which pattern fades on in the evening; it points at
 *     the pattern, so editing it in the maker changes tonight's lights too.
 */
import {
  COLORS, C, cell, BUILTIN, isMultizone, stripLength, tile, cellsToStates, withDefaults, orderLights,
  normalizeMotion, patternMotion, legacyEffect, motionRequest, resolvePattern, DEFAULT_TO,
  builtinById, inSeason, CATEGORIES, layoutCells, spacingOf,
} from './shared/patterns.js?v=2026.11.24-13';
import * as P from './shared/patterns.js?v=2026.11.24-13';
import * as core from './shared/schedule-core.js?v=2026.11.24-13';

const APP_VERSION = '2026.11.24-13';
const MAX_STATES = 50; // LIFX limit per /lights/states request

// Colors used by "Identify strips": strip 1 red, 2 green, 3 blue …
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
let favColors = [];       // this person's quick-pick colors (synced)
let collapsedGroups = {}; // houseKey -> [groupId…] this person keeps collapsed (synced)
let houseLocation = null; // { lat, lon, tz } of the current house, rounded to ~1 km (synced)
let identifySnapshot = null; // { gid, lights: [...] } to restore after Identify
let schedules = {};       // groupId -> [schedule…], for the current house
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

// House settings: each group's settings, plus where the house is (for sunset).
const saveGroupPrefs = () => house && syncLater(`prefs/house/${house.key}`, { groups: structuredClone(groupPrefs), location: houseLocation });
const saveUserPrefs = () => syncLater('prefs/user', { patterns: structuredClone(saved), colors: structuredClone(favColors), collapsed: structuredClone(collapsedGroups) });

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
//   what: { name, id, kind: 'color' | 'pattern' }
async function paintGroup(g, cells, effect = 'none', what = {}) {
  const p = gp(g.id);
  await paint(`group_id:${g.id}`, positions(g.lights, g.id), cells, p.level, effect);
  p.last = {
    cells, effect: normalizeMotion(effect), name: what.name || 'Custom colors', id: what.id || null,
    kind: what.kind || 'pattern', at: Date.now(),
  };
  if (what.id) p.recent = [what.id, ...(p.recent || []).filter(x => x !== what.id)].slice(0, 6);
  saveGroupPrefs();
}

function applyToGroup(g, pattern) {
  const n = positions(g.lights, g.id).length;
  return paintGroup(g, patternCells(pattern, g.id, n), patternMotion(pattern), { name: pattern.name, id: pattern.id, kind: 'pattern' });
}

function playColor(g, c, name) {
  const n = positions(g.lights, g.id).length;
  return run(`${g.name} → ${name}`, () => paintGroup(g, tile([cell(c)], n), 'none', { name, kind: 'color' }));
}

// A pattern's name as shown everywhere: saved patterns get a star.
const isSavedId = id => !!id && !id.startsWith('b-');
const patternLabel = (name, id) => (isSavedId(id) ? `⭐ ${name}` : name);
const isSolid = now => !!now?.cells?.length && (now.kind === 'color' || now.cells.every(x => x.c === now.cells[0].c && x.b === now.cells[0].b));

// The schedules for a group.
const groupSchedules = gid => [...(schedules[gid] || [])];
const allSchedules = () => Object.values(schedules).flat();

// What a group is showing right now: a schedule's pattern while its evening
// runs (unless something was played since it faded on), otherwise whatever
// was played last. Returns { name, id, cells, effect, kind, scheduled, until,
// tz } or null when unknown.
function showing(g) {
  const p = gp(g.id);
  // Older saves have no name for what was played.
  const last = p.last?.cells ? { ...p.last, name: p.last.name || 'Your last colors' } : null;
  const now = new Date();
  for (const s of groupSchedules(g.id)) {
    if (!s.location || !s.enabled) continue;
    const plan = core.currentPlan(s, now);
    const tz = s.location.tz;
    if (plan.skip || now < plan.fadeInStart || now >= plan.offAt) continue;
    if (!last || (last.at || 0) < plan.fadeInStart.getTime()) {
      const pt = scheduledPattern(g, s);
      const n = positions(g.lights, g.id).length;
      return {
        name: pt ? pt.name : s.pattern.name, id: pt?.id || null, kind: 'pattern',
        cells: pt ? patternCells(pt, g.id, n) : null, effect: pt ? patternMotion(pt) : normalizeMotion(s.pattern.motion),
        scheduled: true, until: plan.fadeOutStart, tz, level: s.level,
      };
    }
    if (now < plan.fadeOutStart) return { ...last, until: plan.fadeOutStart, tz };
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

// The next evening any of a group's schedules will run: { s, plan } or null.
function nextScheduled(g) {
  const now = new Date();
  let best = null;
  for (const s of groupSchedules(g.id)) {
    if (!s.enabled || !s.location) continue;
    const plan = core.nextRun(s, now);
    if (plan && (!best || plan.fadeInStart < best.plan.fadeInStart)) best = { s, plan };
  }
  return best;
}

function applyToStrip(g, light, pattern) {
  const pos = positions([light], g.id);
  gp(g.id).last = null; // the group is now mixed
  saveGroupPrefs();
  return paint(`id:${light.id}`, pos, patternCells(pattern, g.id, pos.length), 1, patternMotion(pattern));
}

// Identify strips: each strip a solid color, its light #1 bright white.
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


function toggleSwitch(checked, disabled, onchange) {
  return el('label', { class: 'switch' },
    el('input', { type: 'checkbox', checked, disabled, onchange }), el('span'));
}


// ---------- Colors ----------
// Your favorite colors (synced to your account) are the quick picks
// everywhere; the color sheet picks any color or white.

const defaultFavorites = () => COLORS.map(c => ({ c: c.api, name: c.name }));

// What a white looks like on screen, from warm (1500K) to cool (9000K).
const KELVIN_STOPS = [[1500, [255, 154, 60]], [2700, [255, 210, 160]], [4000, [255, 241, 224]], [6500, [245, 248, 255]], [9000, [214, 228, 255]]];
function kelvinCss(k) {
  const i = Math.max(1, KELVIN_STOPS.findIndex(([x]) => x >= k));
  const [k0, a] = KELVIN_STOPS[Math.min(i, KELVIN_STOPS.length - 1) - 1], [k1, b] = KELVIN_STOPS[Math.min(i, KELVIN_STOPS.length - 1)];
  const f = Math.max(0, Math.min(1, (k - k0) / (k1 - k0)));
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`;
}

function hsbCss({ hue = 0, saturation = 0, kelvin = 3500 }) {
  if (saturation < 0.05) return kelvinCss(kelvin);
  return `hsl(${hue}, ${Math.round(saturation * 100)}%, ${Math.round(50 + (1 - saturation) * 38)}%)`;
}
const colorCss = c => hsbCss(parseColor(c));

const HUE_NAMES = [[15, 'Red'], [40, 'Orange'], [65, 'Yellow'], [95, 'Lime'], [150, 'Green'], [185, 'Teal'], [200, 'Sky blue'], [250, 'Blue'], [290, 'Purple'], [320, 'Magenta'], [345, 'Pink'], [361, 'Red']];
function colorName(c) {
  const known = COLORS.find(x => x.api === c);
  if (known) return known.name;
  const p = parseColor(c);
  if ((p.saturation ?? 0) < 0.05) {
    const k = p.kelvin ?? 3500;
    return `${k < 3000 ? 'Warm white' : k < 5000 ? 'White' : 'Cool white'} ${Math.round(k / 100) * 100}K`;
  }
  const name = HUE_NAMES.find(([max]) => (p.hue ?? 0) < max)[1];
  return p.saturation < 0.5 ? `Soft ${name.toLowerCase()}` : name;
}

let colorSheet = null; // { opts, mode: 'color' | 'white', h, s, k }

/**
 * Pick any color. opts: { title, initial, whiteOnly, useLabel, offerFavorite, onPick(c) }
 */
function openColorSheet(opts) {
  const p = parseColor(opts.initial || 'hue:210 saturation:1');
  const white = !!opts.whiteOnly || (p.saturation ?? 0) < 0.05;
  colorSheet = { opts, mode: white ? 'white' : 'color', h: Math.round(p.hue ?? 210), s: (p.saturation ?? 0) >= 0.05 ? p.saturation : 1, k: p.kelvin ?? 2700 };
  renderColorSheet();
  const sheet = $('#color-sheet');
  sheet.style.transform = '';
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('#sheet-scrim').hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => $('#cs-use').focus({ preventScroll: true }), 50);
}

function closeColorSheet() {
  const sheet = $('#color-sheet');
  sheet.classList.remove('open');
  sheet.style.transform = '';
  sheet.setAttribute('aria-hidden', 'true');
  $('#sheet-scrim').hidden = true;
  document.body.classList.remove('modal-open');
  colorSheet = null;
}

const csValue = () => (colorSheet.mode === 'white'
  ? `kelvin:${Math.round(colorSheet.k / 50) * 50} saturation:0`
  : `hue:${Math.round(colorSheet.h)} saturation:${Math.round(colorSheet.s * 100) / 100}`);

function renderColorSheet() {
  const cs = colorSheet;
  if (!cs) return;
  const v = csValue();
  $('#cs-title').textContent = cs.opts.title || 'Pick a color';
  $('#cs-swatch').style.background = colorCss(v);
  $('#cs-name').textContent = colorName(v);
  $('#cs-mode').hidden = !!cs.opts.whiteOnly;
  document.querySelectorAll('#cs-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === cs.mode));
  $('#cs-color-fields').hidden = cs.mode !== 'color';
  $('#cs-white-fields').hidden = cs.mode !== 'white';
  $('#cs-hue').value = cs.h;
  $('#cs-sat').value = Math.round(cs.s * 100);
  $('#cs-sat').style.setProperty('--hue', cs.h);
  $('#cs-kelvin').value = cs.k;
  $('#cs-use').textContent = cs.opts.useLabel || 'Use this color';
  const fav = cs.opts.offerFavorite && !favColors.some(f => f.c === v);
  $('#cs-fav').hidden = !fav;
}

// ----- Bottom sheets: swipe down (or ✕, the dimmed page, or Escape) to close -----
function makeSwipeable(sheet, close) {
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
    if (drag.dy > 60) close(); else sheet.style.transform = '';
    drag = null;
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

// ---------- Main screen ----------
// Each group card answers, top to bottom:
//   What's on now (or what's next)?  →  Show a solid color OR a pattern
//   →  How it moves  →  Schedules.  Strip details live in the group's settings.

const ui = { tab: {}, editColors: null }; // per-card view state that survives re-renders

function renderMain() {
  const names = [...new Set(lights.map(l => l.location?.name).filter(Boolean))];
  $('#house-name').textContent = demo ? 'Demo House' : house?.name || names[0] || 'My House';
  $('#status').textContent = (demo ? 'Demo mode · ' : '') +
    `${lights.length} light${lights.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('#empty').hidden = lights.length > 0;
  const groups = getGroups();
  const allCollapsed = groups.every(g => isCollapsed(g.id));
  $('#collapse-all').hidden = groups.length < 2;
  $('#collapse-all').textContent = allCollapsed ? 'Expand all' : 'Collapse all';
  $('#groups').replaceChildren(...groups.map(groupCard));
}

// Collapsed groups show only the essentials. Kept per person and per house.
const houseCollapseKey = () => (demo ? 'demo' : house?.key || '');
const isCollapsed = gid => (collapsedGroups[houseCollapseKey()] || []).includes(gid);
function setCollapsed(gids, collapsed) {
  const key = houseCollapseKey();
  const set = new Set(collapsedGroups[key] || []);
  for (const gid of gids) collapsed ? set.add(gid) : set.delete(gid);
  collapsedGroups = { ...collapsedGroups, [key]: [...set] };
  if (!demo) saveUserPrefs();
  renderMain();
}

// Re-draw whichever screen is showing (after lights or settings change).
function rerender() {
  if (!$('#main').hidden) renderMain();
  else if (!$('#library').hidden && library) renderLibrary();
  else if (!$('#group').hidden && groupScreen) renderGroupScreen();
  else renderMain();
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
  const brightnessValue = now?.scheduled ? Math.round(now.level * 100)
    : now ? Math.round(p.level * 100)
      : Math.round(Math.max(0, ...online.map(l => l.brightness || 0)) * 100);

  const collapsed = isCollapsed(g.id);
  const card = el('div', { class: 'card group' + (collapsed ? ' collapsed' : '') },
    el('div', { class: 'light-head' },
      el('button', {
        class: 'group-toggle', 'aria-expanded': String(!collapsed), 'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${g.name}`,
        onclick: () => setCollapsed([g.id], !collapsed),
      },
      el('span', { class: 'dot' + (on ? '' : ' off'), style: `background:${online[0] ? cssColor(online[0]) : '#333'}` }),
      el('span', { class: 'name' }, el('strong', { text: g.name }), el('span', { class: 'muted small', text: sub })),
      el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
      !collapsed && el('button', { class: 'icon-btn ghost', 'aria-label': `${g.name} settings`, title: 'Group settings', onclick: () => openGroupScreen(g) }, '⋯'),
      toggleSwitch(on, !online.length, e =>
        run(`${g.name} ${e.target.checked ? 'on' : 'off'}`, () => setState(sel, { power: e.target.checked ? 'on' : 'off' })))),
    // Brightness only when expanded; collapsed cards keep just the essentials.
    !collapsed && el('input', {
      type: 'range', min: 1, max: 100, value: brightnessValue || 1, 'aria-label': `${g.name} brightness`, disabled: !online.length,
      onchange: e => {
        const v = e.target.value / 100;
        if (now?.cells) {
          // Rescale what's showing instead of flattening it.
          p.level = v;
          saveGroupPrefs();
          run(`${g.name} brightness ${e.target.value}%`, () => paintGroup(g, now.cells, now.effect, { name: now.name, id: now.id, kind: now.kind }));
        } else {
          run(`${g.name} brightness ${e.target.value}%`, () => setState(sel, { power: 'on', brightness: v }));
        }
      },
    }),
    nowLine(g, now, on, online.length > 0));

  if (!online.length || collapsed) return card;

  // One thing shows at a time: a solid color or a pattern.
  const tab = ui.tab[g.id] || (isSolid(now) ? 'color' : 'pattern');
  card.append(
    el('div', { class: 'show-head' },
      el('h3', { text: 'Show' }),
      el('div', { class: 'segmented two compact', role: 'tablist', 'aria-label': 'Show a solid color or a pattern' },
        ...[['color', 'Solid color'], ['pattern', 'Pattern']].map(([k, label]) => el('button', {
          role: 'tab', class: tab === k ? 'active' : '', 'aria-selected': String(tab === k),
          onclick: () => { ui.tab[g.id] = k; ui.editColors = null; renderMain(); },
        }, label)))),
    tab === 'color' ? colorsPanel(g, now) : patternsPanel(g, now),
    motionRow(g, now),
    !demo && schedulesSection(g));

  if (multi && !p.ordered) {
    card.append(el('button', { class: 'hint hint-btn', onclick: () => openGroupScreen(g) },
      'Tip: set your strip order so patterns flow around the house the right way ›'));
  }
  return card;
}

// What's on right now, or (when off) what's next.
function nowLine(g, now, on, online) {
  if (!online) return el('div', { class: 'now-line muted small' }, 'Offline');
  if (!on) {
    const next = !demo && nextScheduled(g);
    const tz = next?.s.location.tz;
    const when = next && `${dayWord(next.plan, tz)} ${fmtTime(next.plan.fadeInStart, tz)}`;
    return el('div', { class: 'now-line' },
      el('span', { class: 'preview-strip off', 'aria-hidden': 'true' }),
      el('span', { class: 'now-text' },
        el('strong', { text: 'Off' }),
        next && el('span', { class: 'muted small', text: `Next: ${when} · ${scheduledName(g, next.s)}` })));
  }
  if (!now) {
    return el('div', { class: 'now-line' }, el('span', { class: 'preview-strip unknown', 'aria-hidden': 'true' }),
      el('span', { class: 'now-text' }, el('strong', { text: 'On' }), el('span', { class: 'muted small', text: 'Colors set outside this app' })));
  }
  const t = d => fmtTime(d, now.tz);
  const moving = now.effect?.type && now.effect.type !== 'none' ? ` · ${MOTION_NAME[now.effect.type]}` : '';
  const detail = now.scheduled ? `From your schedule · fades off at ${t(now.until)}`
    : now.until ? `Until the ${t(now.until)} fade-off` : '';
  return el('div', { class: 'now-line' },
    previewStrip(now.cells),
    el('span', { class: 'now-text' },
      el('span', { class: 'muted small', text: 'Showing' }),
      el('strong', { text: patternLabel(now.name, now.id) + moving }),
      detail && el('span', { class: 'muted small', text: detail })));
}

const MOTION_NAME = { none: 'Steady', chase: 'Chase', breathe: 'Breathe', pulse: 'Pulse' };

// ----- Solid colors: your favorites, plus any color -----

const isWhite = c => (parseColor(c).saturation ?? 0) < 0.05;

function colorsPanel(g, now) {
  const anyColor = g.lights.some(hasColor);
  const favs = favColors.filter(f => anyColor || isWhite(f.c));
  const current = isSolid(now) ? now.cells[0].c : null;
  const editing = ui.editColors === g.id;
  const swatches = favs.map(f => {
    const label = f.name || colorName(f.c);
    if (editing) {
      return el('button', {
        class: 'swatch-btn removable', style: `background:${colorCss(f.c)}`, 'aria-label': `Remove ${label}`, title: `Remove ${label}`,
        onclick: () => { favColors = favColors.filter(x => x !== f); saveUserPrefs(); renderMain(); },
      }, el('span', { class: 'remove-badge', 'aria-hidden': 'true' }, '✕'));
    }
    return sw(colorCss(f.c), label, () => playColor(g, f.c, label), {
      class: 'swatch-btn' + (current === f.c ? ' active' : ''), 'aria-pressed': String(current === f.c),
    });
  });
  const more = el('button', {
    class: 'swatch-btn more-colors', title: editing ? 'Add a color' : 'Any color', 'aria-label': editing ? 'Add a color to your favorites' : 'Pick any color',
    onclick: () => openColorSheet({
      title: editing ? 'Add a favorite color' : `Any color · ${g.name}`,
      initial: current || 'hue:210 saturation:1',
      whiteOnly: !anyColor,
      useLabel: editing ? 'Add to my colors' : 'Show this color',
      offerFavorite: !editing,
      onPick: c => {
        if (editing) { addFavorite(c); renderMain(); } else playColor(g, c, colorName(c));
      },
    }),
  }, el('span', { 'aria-hidden': 'true' }, '+'));
  return el('div', { class: 'show-panel' },
    el('div', { class: 'chips' }, ...swatches, more),
    el('div', { class: 'panel-foot' },
      editing
        ? [el('button', { class: 'link small', onclick: () => { favColors = defaultFavorites(); saveUserPrefs(); renderMain(); } }, 'Reset to defaults'),
          el('button', { class: 'link small strong', onclick: () => { ui.editColors = null; renderMain(); } }, 'Done')]
        : [el('span', { class: 'muted small', text: 'Shows on every light' }),
          el('button', { class: 'link small', onclick: () => { ui.editColors = g.id; renderMain(); } }, 'Edit colors')]));
}

function addFavorite(c) {
  if (favColors.some(f => f.c === c)) return showActivity('Already in your colors', 'ok');
  favColors = [...favColors, { c, name: colorName(c) }].slice(0, 24);
  saveUserPrefs();
  showActivity('✓ Added to your colors', 'ok');
}

// ----- Patterns: what's relevant now, plus the full library -----

// In-season holidays, then what you've played lately, then your own patterns.
function topPatterns(g, now) {
  const today = new Date();
  const out = [];
  const add = pt => { if (pt && !out.some(x => x.id === pt.id)) out.push(pt); };
  const find = id => builtinById(id) || saved.find(x => x.id === id);
  BUILTIN.filter(b => b.category === 'holidays' && inSeason(b, today)).forEach(add);
  for (const id of gp(g.id).recent || []) add(find(id));
  saved.slice(-4).reverse().forEach(add);
  if (out.length < 4) add(builtinById('b-warm'));
  const top = out.slice(0, 8);
  // Whatever is showing is always there to see (without reshuffling the rest).
  const showingNow = now?.id && !isSolid(now) && find(now.id);
  if (showingNow && !top.includes(showingNow)) top.splice(Math.min(top.length, 7), 1, showingNow);
  return top;
}

function patternChip(g, pt, now) {
  const n = positions(g.lights, g.id).length;
  const active = !!now && !isSolid(now) && (now.id ? now.id === pt.id : now.name === pt.name);
  return el('button', {
    class: 'pattern-chip' + (active ? ' active' : '') + (isSavedId(pt.id) ? ' saved' : ''), 'aria-pressed': String(active),
    onclick: () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)),
  }, previewStrip(patternCells(pt, g.id, Math.min(n, 48)), 16), el('span', { class: 'chip-name', text: patternLabel(pt.name, pt.id) }));
}

function patternsPanel(g, now) {
  return el('div', { class: 'show-panel' },
    el('div', { class: 'pattern-grid' }, ...topPatterns(g, now).map(pt => patternChip(g, pt, now))),
    el('div', { class: 'panel-foot' },
      el('span', { class: 'muted small', text: 'In season and recent' }),
      el('button', { class: 'link small strong', onclick: () => openLibrary(g) }, 'All patterns ›')));
}

// ----- Motion: how what's showing moves, changed on the spot -----

function motionRow(g, now) {
  const sel = `group_id:${g.id}`;
  const mo = normalizeMotion(now?.effect);
  const apply = (next, label) => run(`${label} · ${g.name}`, async () => {
    await effectsOff(sel);
    if (next.type !== 'none') await startMotion(sel, next);
    setLastMotion(g, next, now);
  });
  return el('div', { class: 'motion-row' },
    el('h3', { text: 'Motion' }),
    el('div', { class: 'segmented four compact', role: 'group', 'aria-label': 'Motion' },
      ...['none', 'chase', 'breathe', 'pulse'].map(type => el('button', {
        class: mo.type === type ? 'active' : '', 'aria-pressed': String(mo.type === type),
        onclick: () => apply({ ...mo, type }, MOTION_NAME[type]),
      }, MOTION_NAME[type]))),
    mo.type !== 'none' && el('div', { class: 'motion-extra' },
      mo.type === 'chase' && el('button', {
        class: 'small', 'aria-label': 'Change direction',
        onclick: () => apply({ ...mo, dir: mo.dir === 'backward' ? 'forward' : 'backward' }, 'Change direction'),
      }, mo.dir === 'backward' ? '← Backward' : 'Forward →'),
      el('div', { class: 'speed-control grow' },
        el('span', { class: 'muted small', text: 'Slow' }),
        el('input', {
          type: 'range', min: 0, max: 100, value: Math.round(mo.speed * 100), 'aria-label': 'Speed, slow to fast',
          onchange: e => apply({ ...mo, speed: e.target.value / 100 }, 'Speed'),
        }),
        el('span', { class: 'muted small', text: 'Fast' }))));
}

// Remember a motion change on what's showing, so "last played" (and the
// brightness slider) bring it back the same way.
function setLastMotion(g, mo, now) {
  const p = gp(g.id);
  const base = now?.cells ? now : p.last;
  if (!base?.cells) return;
  p.last = { cells: base.cells, name: base.name, id: base.id || null, kind: base.kind || 'pattern', effect: mo, at: Date.now() };
  saveGroupPrefs();
}

// ----- Schedules on the card -----

function schedulesSection(g) {
  const list = groupSchedules(g.id);
  if (!list.length) {
    return el('button', { class: 'schedule-row empty', onclick: () => openSchedule(g, null) },
      el('span', { class: 'sched-icon', text: '🌙' }),
      el('span', { class: 'grow' }, el('strong', { text: 'Add a schedule' }), el('span', { class: 'muted small', text: 'Fade on at sunset, fade off at bedtime' })),
      el('span', { class: 'chev', text: '›' }));
  }
  const stale = timerInfo?.configured && (!timerInfo.lastTick || Date.now() - timerInfo.lastTick > 20 * 60000) && !timerInfo.repaired;
  return el('div', { class: 'sched-section' },
    el('div', { class: 'section-head' },
      el('h3', { text: list.length === 1 ? 'Schedule' : 'Schedules' }),
      el('button', { class: 'link small strong', onclick: () => openSchedule(g, null) }, '+ Add')),
    ...list.map(s => scheduleRow(g, s)),
    stale && list.some(s => s.enabled) && el('p', { class: 'hint small', text: '⚠️ The schedule timer hasn’t checked in lately, so schedules may not run. It’s being restarted; check again in a few minutes.' }));
}

// A small strip of color previewing cells (sampled down to fit).
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

// ---------- Group settings: the strips in a group, and their order ----------

let groupScreen = null; // { gid }

function openGroupScreen(g) {
  groupScreen = { gid: g.id };
  show('group');
  window.scrollTo(0, 0);
  renderGroupScreen();
}

function renderGroupScreen() {
  const g = groupById(groupScreen.gid);
  if (!g) { show('main'); renderMain(); return; }
  const multi = g.lights.length > 1;
  $('#group-title').textContent = g.name;
  $('#group-sub').textContent = `${g.lights.length} ${g.lights.length === 1 ? 'light' : 'strips'} · ${positions(g.lights, g.id).length} lights`;
  $('#group-body').replaceChildren(...[
    el('div', { class: 'card' },
      el('h3', { class: 'first', text: multi ? 'Strips in this group' : 'Light' }),
      el('p', { class: 'muted small', text: 'Control a single strip on its own. Changing one strip makes the group “mixed” until you show something on the whole group again.' }),
      ...g.lights.map(l => stripCard(g, l))),
    multi && el('div', { class: 'card' }, el('h3', { class: 'first', text: 'Strip order' }), ...orderEditor(g)),
  ].filter(Boolean));
}

function stripCard(g, light) {
  const id = `id:${light.id}`;
  const on = light.power === 'on';
  const mixed = () => { gp(g.id).last = null; saveGroupPrefs(); };
  const favs = favColors.filter(f => hasColor(light) || isWhite(f.c));
  const box = el('div', { class: 'strip' },
    el('div', { class: 'light-head' },
      el('span', { class: 'dot' + (on && light.connected ? '' : ' off'), style: `background:${cssColor(light)}` }),
      el('div', { class: 'name' },
        el('strong', { text: light.label || 'Light' }),
        el('span', { class: 'muted small' + (light.connected ? '' : ' offline'), text: light.connected ? `${stripLength(light)} lights${on ? '' : ' · off'}` : 'Offline' })),
      toggleSwitch(on, !light.connected, e =>
        run(`${light.label} ${e.target.checked ? 'on' : 'off'}`, () => setState(id, { power: e.target.checked ? 'on' : 'off' })))));
  if (!light.connected) return box;
  const solid = (c, label) => { mixed(); run(`${light.label} → ${label}`, () => setState(id, { power: 'on', color: c })); };
  box.append(
    el('input', {
      type: 'range', min: 1, max: 100, value: Math.round((light.brightness || 0) * 100), 'aria-label': `${light.label} brightness`,
      onchange: e => { mixed(); run(`${light.label} brightness ${e.target.value}%`, () => setState(id, { power: 'on', brightness: e.target.value / 100 })); },
    }),
    el('div', { class: 'chips' },
      ...favs.map(f => sw(colorCss(f.c), f.name || colorName(f.c), () => solid(f.c, f.name || colorName(f.c)), { class: 'swatch-btn small' })),
      el('button', {
        class: 'swatch-btn small more-colors', 'aria-label': 'Pick any color',
        onclick: () => openColorSheet({ title: `Any color · ${light.label}`, initial: 'hue:210 saturation:1', whiteOnly: !hasColor(light), useLabel: 'Show this color', offerFavorite: true, onPick: c => solid(c, colorName(c)) }),
      }, el('span', { 'aria-hidden': 'true' }, '+'))),
    isMultizone(light) && el('label', { class: 'inline small' }, 'Pattern on just this strip',
      el('select', {
        onchange: e => {
          const pt = [...saved, ...BUILTIN].find(x => x.id === e.target.value);
          e.target.value = '';
          if (pt) run(`${pt.name} · ${light.label}`, () => applyToStrip(g, light, pt));
        },
      }, el('option', { value: '' }, 'Choose…'), ...[...saved, ...BUILTIN].map(pt => el('option', { value: pt.id }, patternLabel(pt.name, pt.id))))));
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
    rerender();
  };
  return [
    el('p', { class: 'muted small', text: 'Put the strips in the order they run around the house, so patterns flow the right way. “Identify strips” lights each one a different color, with its light #1 bright white, so you can see which is which and which end it starts from.' }),
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
      el('button', { onclick: () => run(`Identify strips · ${g.name}`, () => identifyStrips(g)).then(rerender) }, '🔦 Identify strips'),
      identifySnapshot?.gid === g.id && el('button', { onclick: () => run(`Restore · ${g.name}`, restoreSnapshot).then(rerender) }, '↩︎ Put lights back')),
    !p.ordered && el('button', { class: 'link', onclick: () => { p.ordered = true; saveGroupPrefs(); rerender(); } }, 'This order is right'),
  ];
}

// ---------- Pattern library ----------
// Every pattern in one place: yours first, then what's in season, holidays,
// moods and basics. Tap to show it; ✎ to edit yours or make your own version
// of a built-in.

let library = null; // { gid }

function openLibrary(g) {
  library = { gid: g.id };
  show('library');
  window.scrollTo(0, 0);
  renderLibrary();
}

const SEASON_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const seasonText = pt => pt.seasons?.length
  ? pt.seasons.map(([f, t]) => { const a = SEASON_MONTHS[+f.slice(0, 2) - 1], b = SEASON_MONTHS[+t.slice(0, 2) - 1]; return a === b ? a : `${a}–${b}`; }).join(', ')
  : '';
const canCustomize = pt => !isSavedId(pt.id) && pt.layout !== 'blend';

function renderLibrary() {
  const g = groupById(library.gid);
  if (!g) { show('main'); renderMain(); return; }
  const now = showing(g);
  const n = positions(g.lights, g.id).length;
  $('#library-sub').textContent = g.name;
  const row = (pt, sub) => {
    const active = !!now && !isSolid(now) && (now.id ? now.id === pt.id : now.name === pt.name);
    const mo = patternMotion(pt);
    const details = [sub, mo.type !== 'none' && MOTION_NAME[mo.type]].filter(Boolean).join(' · ');
    return el('div', { class: 'lib-row' + (active ? ' active' : '') },
      el('button', {
        class: 'lib-play', 'aria-pressed': String(active),
        onclick: () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)).then(() => { if (library) renderLibrary(); }),
      },
      previewStrip(patternCells(pt, g.id, Math.min(n, 60)), 30),
      el('span', { class: 'grow' }, el('strong', { text: patternLabel(pt.name, pt.id) }), details && el('span', { class: 'muted small', text: details })),
      active && el('span', { class: 'check', text: '✓' })),
      isSavedId(pt.id)
        ? el('button', { class: 'icon-btn ghost', 'aria-label': `Edit ${pt.name}`, title: 'Edit', onclick: () => openMaker(g.id, pt, { from: 'library' }) }, '✎')
        : canCustomize(pt) && el('button', { class: 'icon-btn ghost', 'aria-label': `Make your own version of ${pt.name}`, title: 'Make your own version', onclick: () => openMaker(g.id, pt, { from: 'library', copy: true }) }, '✎'));
  };
  const today = new Date();
  const sections = [
    el('button', { class: 'lib-new', onclick: () => openMaker(g.id, null, { from: 'library' }) },
      el('span', { class: 'lib-new-icon', 'aria-hidden': 'true' }, '+'),
      el('span', { class: 'grow' }, el('strong', { text: 'Create a new pattern' }), el('span', { class: 'muted small', text: 'Paint your own colors, spacing and motion' }))),
  ];
  const section = (title, items) => items.length && sections.push(el('h3', { text: title }), el('div', { class: 'lib-list' }, ...items));
  section('Your patterns', [...saved].reverse().map(pt => row(pt, 'Yours')));
  section('In season now', BUILTIN.filter(b => inSeason(b, today)).map(pt => row(pt, seasonText(pt))));
  for (const c of CATEGORIES) {
    section(c.name, BUILTIN.filter(b => b.category === c.id && !(c.id === 'holidays' && inSeason(b, today))).map(pt => row(pt, c.id === 'holidays' ? seasonText(pt) : '')));
  }
  sections.push(el('p', { class: 'muted small center', text: 'Moods use the colors of the LIFX app’s Moods, blended smoothly along your lights.' }));
  $('#library-body').replaceChildren(...sections);
}

// ---------- Pattern maker ----------
// One source of truth: a short repeating pattern (seq) is tiled around the
// house, plus optional single-light changes (overrides). The house view always
// shows the result, so what you see is exactly what gets sent.

const BRIGHTNESS = [[1, '100%'], [0.5, '50%'], [0.15, '15%'], [0.03, '3%']];
const MAX_SEQ = 24;
// Built-ins whose colors simply repeat can be starting points (moods blend, so they can't).
const QUICK_STARTS = [
  ...BUILTIN.filter(b => b.category === 'holidays' || b.id === 'b-warm').map(b => ({ name: b.name, seq: b.loop })),
  { name: '🌈 Rainbow', seq: Array.from({ length: 12 }, (_, i) => cell(`hue:${i * 30} saturation:1`)) },
];
let maker = null;

const keyOf = x => `${x.c}|${x.b}`;
const clone = x => structuredClone(x);

// The repeating pattern laid along the house with its spacing (no single-light changes).
const makerBase = (m = maker) => layoutCells({ loop: m.seq, width: m.width, gaps: m.gaps }, m.n);

function makerCells(m = maker) {
  const cells = makerBase(m);
  for (const [i, x] of Object.entries(m.overrides)) if (+i < m.n) cells[+i] = { ...x };
  return cells;
}
const editState = (m = maker) => JSON.stringify({ seq: m.seq, width: m.width, gaps: m.gaps, overrides: m.overrides, motion: m.motion, name: m.name });
const sendKey = (m = maker) => JSON.stringify({ cells: makerCells(m), motion: m.motion });

// Single-light changes in a saved pattern = where it differs from the repeat.
function overridesFor(pattern, seq, n) {
  if (pattern.overrides) return Object.fromEntries(Object.entries(pattern.overrides).filter(([i]) => +i < n).map(([i, x]) => [i, { ...x }]));
  if (pattern.cells?.length !== n) return {};
  const base = layoutCells({ loop: seq, ...spacingOf(pattern) }, n);
  const out = {};
  pattern.cells.forEach((x, i) => { if (keyOf(x) !== keyOf(base[i])) out[i] = { ...x }; });
  return out;
}

// opts.from: 'library' to go back there; opts.copy: start your own version of a built-in.
function openMaker(gid, pattern, opts = {}) {
  const g = groupById(gid);
  const n = positions(g.lights, gid).length;
  const isSaved = !!pattern && isSavedId(pattern.id) && !opts.copy;
  const seq = pattern?.rainbow ? QUICK_STARTS.at(-1).seq.map(x => ({ ...x }))
    : pattern?.loop?.map(x => ({ c: x.c, b: x.b ?? 1 })) || [cell(C.Red), cell(C.Green)];
  const spacing = spacingOf(pattern);
  maker = {
    gid, n, seq, ...spacing,
    overrides: isSaved ? overridesFor(pattern, seq, n) : {},
    motion: patternMotion(pattern),
    name: isSaved ? pattern.name : opts.copy ? `${pattern.name.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')} (mine)`.slice(0, 40) : '',
    editingId: isSaved ? pattern.id : null,
    from: opts.from || maker?.from || null,
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
  maker.history.push(JSON.stringify({ seq: maker.seq, width: maker.width, gaps: maker.gaps, overrides: maker.overrides, motion: maker.motion }));
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
  const back = maker.from === 'library' && library ? 'library' : 'main';
  maker = null;
  show(back);
  rerender();
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
  renderSpacing();
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

// Spacing: how many lights each color covers, and what goes between colors.
function renderSpacing() {
  const m = maker;
  $('#width-val').textContent = m.width;
  $('#width-minus').disabled = m.width <= 1;
  $('#width-plus').disabled = m.width >= 50;
  document.querySelectorAll('#gaps-seg button').forEach(b => b.classList.toggle('active', b.dataset.gaps === m.gaps));
}

function setSpacing(change) {
  const next = { width: maker.width, gaps: maker.gaps, ...change };
  if (next.width === maker.width && next.gaps === maker.gaps) return;
  remember();
  Object.assign(maker, next);
  renderSeq();
  renderSpacing();
  afterEdit();
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
    breathe: 'Try it: on some strips the whole strip fades to one color while breathing, then your pattern returns when you stop it.',
    pulse: 'Try it: on some strips the whole strip blinks to one color, then your pattern returns when you stop it.',
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
  const every = m.seq.length * m.width * (m.gaps === 'none' ? 1 : 2);
  $('#seq-count').textContent = `Repeats every ${every} light${every === 1 ? '' : 's'}`;
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
  if (q.pattern) Object.assign(maker, spacingOf(q.pattern));
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
  const color = !allOff && same(x => x.c) ? cells[0].c : null;
  const level = same(x => x.b) ? cells[0].b : null;

  const custom = color && !favColors.some(f => f.c === color);
  $('#sheet-colors').replaceChildren(...[
    ...favColors.map(f => sw(colorCss(f.c), f.name || colorName(f.c), () => applyToSelection({ c: f.c }), { class: 'swatch-btn' + (color === f.c ? ' active' : '') })),
    custom && sw(colorCss(color), colorName(color), () => {}, { class: 'swatch-btn active' }),
    el('button', {
      class: 'swatch-btn more-colors', title: 'Any color', 'aria-label': 'Pick any color',
      onclick: () => openColorSheet({ title: 'Any color', initial: color || 'hue:210 saturation:1', useLabel: 'Use this color', offerFavorite: true, onPick: c => applyToSelection({ c }) }),
    }, el('span', { 'aria-hidden': 'true' }, '+')),
    el('button', {
      class: 'swatch-btn off-swatch' + (allOff ? ' active' : ''), title: 'Off', 'aria-label': 'Turn off',
      onclick: () => applyToSelection({ b: 0 }),
    }, 'Off'),
  ].filter(Boolean));
  $('#sheet-levels').replaceChildren(...BRIGHTNESS.map(([v, t]) => el('button', {
    class: level === v ? 'active' : '',
    'aria-label': `Brightness ${t}`,
    onclick: () => applyToSelection({ b: v }),
  }, t)));
}

// Picking a color keeps each light's brightness (or turns an off light on);
// picking a brightness keeps each light's color.
const withChange = (x, ch) => (ch.c !== undefined ? { c: ch.c, b: x.b > 0 ? x.b : 1 } : { c: x.c, b: ch.b });

function applyToSelection(change) {
  const m = maker;
  const s = m.sel;
  if (!s) return;
  const base = makerBase(m);
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

makeSwipeable($('#light-sheet'), closeSheet);
makeSwipeable($('#color-sheet'), closeColorSheet);

function makerPattern() {
  return {
    id: maker.editingId || `p-${Date.now().toString(36)}`,
    name: (maker.name || 'My pattern').slice(0, 40),
    loop: clone(maker.seq),
    width: maker.width,
    gaps: maker.gaps,
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

// A group can have several schedules (e.g. weeknights and weekends, or one
// per season). Ids are random; older ones were "s-<group id>".
const newScheduleId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function upsertSchedule(s) {
  const list = (schedules[s.groupId] || []).filter(x => x.id !== s.id);
  schedules[s.groupId] = [...list, s];
}
function removeSchedule(s) {
  schedules[s.groupId] = (schedules[s.groupId] || []).filter(x => x.id !== s.id);
}

// "Tonight", "Tomorrow" or the weekday of a plan, in the house's time zone.
function dayWord(plan, tz) {
  const today = core.zonedParts(new Date(), tz);
  if (plan.date === core.ymd(today)) return 'Tonight';
  if (plan.date === core.ymd(core.addDays(today, 1))) return 'Tomorrow';
  return new Date(plan.fullOn).toLocaleDateString([], { weekday: 'long', timeZone: tz });
}

// Days in the coming year when two schedules would both run.
function overlapDays(a, b) {
  if (!a.enabled || !b.enabled) return 0;
  const md = d => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const inSeasonMd = (season, x) => !season || (season.from <= season.to ? x >= season.from && x <= season.to : x >= season.from || x <= season.to);
  let n = 0;
  const d = new Date();
  for (let i = 0; i < 366; i++, d.setDate(d.getDate() + 1)) {
    const x = md(d);
    if (a.days.includes(d.getDay()) && b.days.includes(d.getDay()) && inSeasonMd(a.season, x) && inSeasonMd(b.season, x)) n++;
  }
  return n;
}

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
  const day = dayWord(next, tz);
  // Something was played after tonight's fade-on started: that stays until the fade-off.
  const playedAt = gp(g.id).last?.at || 0;
  if (now >= next.fadeInStart && now < next.fadeOutStart && playedAt > next.fadeInStart.getTime()) {
    return { title: `Fades off at ${t(next.fadeOutStart)}`, detail: `Showing what you picked instead of ${name} · off by ${t(next.offAt)}` };
  }
  if (now >= next.fadeOutStart) return { title: `Fading off · ${name}`, detail: `Off by ${t(next.offAt)}` };
  if (now >= next.fullOn) return { title: `On now · ${name}`, detail: `Fades off ${t(next.fadeOutStart)} → ${t(next.offAt)}` };
  if (now >= next.fadeInStart) return { title: `Fading on · ${name}`, detail: `Fully on ${t(next.fullOn)} · fades off ${t(next.fadeOutStart)}` };
  return {
    title: `${day} · ${name}`,
    detail: `Fades on ${t(next.fadeInStart)} → ${t(next.fullOn)} · off ${t(next.fadeOutStart)} → ${t(next.offAt)}`,
  };
}

function scheduleRow(g, s) {
  const { title, detail } = tonightText(g, s);
  return el('div', { class: 'schedule-row' + (s.enabled ? '' : ' paused') },
    el('button', { class: 'sched-open', 'aria-label': `Schedule: ${title}. ${detail}`, onclick: () => openSchedule(g, s) },
      el('span', { class: 'sched-icon', text: '🌙' }),
      el('span', { class: 'grow' }, el('strong', { text: title }), el('span', { class: 'muted small', text: detail }))),
    toggleSwitch(s.enabled, false, async e => {
      const enabled = e.target.checked;
      try {
        const res = await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: { ...s, enabled } });
        upsertSchedule(res.schedule);
        showActivity(enabled ? '✓ Schedule on' : 'Schedule paused', 'ok');
      } catch (err) { showActivity(err.message, 'err'); }
      renderMain();
    }));
}

let sched = null; // the schedule being edited: { g, s, dirty }

async function openSchedule(g, existing) {
  const s = existing ? clone(existing) : {
    ...clone(core.DEFAULT_SCHEDULE),
    id: newScheduleId(),
    groupId: g.id,
    groupName: g.name,
    location: houseLocation || allSchedules().find(x => x.location)?.location || null,
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
  const last = p.last?.cells ? { ...p.last, name: p.last.name || 'Your last colors' } : null;
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
      sub: ref.owner && ref.owner !== me?.id ? 'Chosen by someone else in the family' : 'Deleted · uses the colors it had when you chose it',
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
  // Two schedules on the same evenings would fight over the lights.
  const clash = groupSchedules(sched.g.id).filter(x => x.id !== s.id).map(x => [x, overlapDays(s, x)]).find(([, n]) => n > 0);
  $('#sched-overlap').hidden = !clash;
  if (clash) {
    $('#sched-overlap').textContent = `⚠️ Runs on the same evenings as your “${scheduledName(sched.g, clash[0])}” schedule (${clash[1]} days in the next year). Both would change the lights. Pick different days or seasons, or pause one.`;
  }
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

// The server works out the pattern's colors when it fades the lights on, so
// edits in the pattern maker are picked up. It also keeps these colors, used
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

// After a saved pattern changes, refresh the stand-in colors of this house's
// schedules that use it (the schedule itself already follows the pattern).
async function refreshSchedulesUsing(patternId) {
  for (const s of allSchedules()) {
    const g = groupById(s.groupId);
    if (!g || s.pattern.source !== 'saved' || s.pattern.id !== patternId) continue;
    try {
      const res = await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: { ...s, pattern: { ...s.pattern, ...scheduleSnapshot(g, s.pattern) } } });
      upsertSchedule(res.schedule);
    } catch { /* the schedule still follows the pattern; only the stand-in is older */ }
  }
}
const schedulesUsing = patternId => allSchedules().filter(s => s.pattern.source === 'saved' && s.pattern.id === patternId);

async function saveSchedule() {
  const { g, s } = sched;
  if (!s.location) { alert('Add the house location first, so the app knows when sunset is.'); return; }
  const body = { ...s, pattern: { ...s.pattern, ...scheduleSnapshot(g, s.pattern) } };
  const btn = $('#sched-save');
  btn.disabled = true;
  try {
    const res = await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: body });
    upsertSchedule(res.schedule);
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
    saveUserPrefs();
    showActivity(`✓ Added “${d.n}” to your patterns`, 'ok');
  } catch {
    showActivity('That pattern link looks broken.', 'err');
  }
}

// ---------- Screens and loading ----------

function show(screen) {
  for (const s of ['auth', 'main', 'library', 'group', 'maker', 'sched']) $(`#${s}`).hidden = screen !== s;
}

async function loadLights() {
  lights = await api('GET', '/lights/all');
  if (!maker && !sched) rerender();
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
    favColors = Array.isArray(p.prefs.colors) ? p.prefs.colors : defaultFavorites();
    collapsedGroups = p.prefs.collapsed && typeof p.prefs.collapsed === 'object' ? p.prefs.collapsed : {};
  } catch { saved = []; favColors = defaultFavorites(); }
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
  ui.tab = {};
  ui.editColors = null;
  library = null;
  groupScreen = null;
  groupPrefs = {};
  houseLocation = null;
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
    houseLocation = p.prefs.location || null;
    schedules = {};
    for (const x of sc.schedules) upsertSchedule(x);
    // Houses set up before the location was kept with the house: take it from a schedule.
    if (!houseLocation && sc.schedules.some(x => x.location)) {
      houseLocation = sc.schedules.find(x => x.location).location;
      saveGroupPrefs();
    }
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
  favColors = defaultFavorites();
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
  $('#timer-status').hidden = true;
  if (!demo && me?.admin) { loadFamily(); loadTimerStatus(); }
}

// Admin only: is the server's schedule timer checking in?
async function loadTimerStatus() {
  const box = $('#timer-status');
  try {
    const t = await server('GET', 'timer');
    const ago = t.lastTick ? Math.round((Date.now() - t.lastTick) / 60000) : null;
    const total = Object.values(t.schedules || {}).reduce((a, b) => a + b, 0);
    const healthy = ago != null && ago <= 15;
    const lines = [
      !t.configured ? '⚠️ Schedule timer isn’t set up on the server.'
        : healthy ? `✓ Schedule timer checked in ${ago < 1 ? 'just now' : `${ago} min ago`}.`
          : `⚠️ Schedule timer last checked in ${ago == null ? 'never' : ago < 120 ? `${ago} min ago` : `${Math.round(ago / 60)} hr ago`}.${t.repairing ? ' Restarting it now.' : ''}`,
      `${total} schedule${total === 1 ? '' : 's'} saved${Object.keys(t.schedules || {}).length > 1 ? ` (${Object.entries(t.schedules).map(([k, n]) => `${houses.find(h => h.key === k)?.name || k}: ${n}`).join(', ')})` : ''}.`,
      t.qstash?.error ? `Timer service: ${t.qstash.error}` : t.qstash && (t.qstash.paused ? 'Timer service: paused' : t.qstash.destination !== t.expected ? 'Timer service points at an old address; it will be reset.' : ''),
    ].filter(Boolean);
    box.textContent = lines.join(' ');
    box.classList.toggle('warn', !healthy);
    box.hidden = false;
  } catch { box.hidden = true; }
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
$('#width-minus').addEventListener('click', () => setSpacing({ width: Math.max(1, maker.width - 1) }));
$('#width-plus').addEventListener('click', () => setSpacing({ width: Math.min(50, maker.width + 1) }));
document.querySelectorAll('#gaps-seg button').forEach(b => b.addEventListener('click', () => setSpacing({ gaps: b.dataset.gaps })));
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
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (colorSheet) closeColorSheet();
  else if (maker?.sel) closeSheet();
});

// Color sheet controls
document.querySelectorAll('#cs-mode button').forEach(b => b.addEventListener('click', () => { colorSheet.mode = b.dataset.mode; renderColorSheet(); }));
$('#cs-hue').addEventListener('input', e => { colorSheet.h = +e.target.value; renderColorSheet(); });
$('#cs-sat').addEventListener('input', e => { colorSheet.s = Math.max(0.05, e.target.value / 100); renderColorSheet(); });
$('#cs-kelvin').addEventListener('input', e => { colorSheet.k = +e.target.value; renderColorSheet(); });
$('#cs-use').addEventListener('click', () => {
  const v = csValue();
  const pick = colorSheet.opts.onPick;
  closeColorSheet();
  pick(v);
});
$('#cs-fav').addEventListener('click', () => { addFavorite(csValue()); renderColorSheet(); });
$('#cs-close').addEventListener('click', closeColorSheet);
$('#sheet-scrim').addEventListener('click', closeColorSheet);

// Library and group settings
$('#library-back').addEventListener('click', () => { library = null; show('main'); renderMain(); });
$('#collapse-all').addEventListener('click', () => {
  const gids = getGroups().map(g => g.id);
  setCollapsed(gids, !gids.every(isCollapsed));
});
$('#group-back').addEventListener('click', () => { groupScreen = null; show('main'); renderMain(); });
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
  saveUserPrefs();
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
    ? `\n\nYour ${using.map(s => s.groupName).join(' & ')} schedule uses it. It will keep using the colors it has now until you pick another pattern for it.`
    : '';
  if (!pt || !confirm(`Delete the pattern “${pt.name}”?${warning}`)) return;
  saved = saved.filter(p => p.id !== pt.id);
  saveUserPrefs();
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
    const location = {
      lat: Math.round(pos.coords.latitude * 100) / 100,
      lon: Math.round(pos.coords.longitude * 100) / 100,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    // Kept with the house, so no schedule here has to ask again.
    houseLocation = location;
    saveGroupPrefs();
    setSched({ location });
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
    removeSchedule(sched.s);
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
