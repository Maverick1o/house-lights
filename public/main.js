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
} from './shared/patterns.js?v=2026.11.24-17';
import * as P from './shared/patterns.js?v=2026.11.24-17';
import * as core from './shared/schedule-core.js?v=2026.11.24-17';

const APP_VERSION = '2026.11.24-17';
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
// The house library: shared by everyone with access to the current house.
let saved = [];           // the house's own patterns (synced)
let favColors = [];       // the house's quick-pick colors (synced)
let timings = {};         // id -> library schedule (when it runs), for the current house
let hiddenIds = new Set(); // built-in patterns this house has hidden (synced with the library)
let inbox = [];           // patterns other houses sent here, waiting to be added or declined
let allHouses = [];       // every house's name, to send patterns to
let personal = {};        // this person's own settings ({ patterns, colors } from before the library, collapsed, migrated)
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
const saveUserPrefs = () => syncLater('prefs/user', { ...structuredClone(personal), collapsed: structuredClone(collapsedGroups) });
const saveLibrary = () => house && syncLater(`prefs/library/${house.key}`, { patterns: structuredClone(saved), colors: structuredClone(favColors), hidden: [...hiddenIds] });
const isHidden = pt => !!pt && !isSavedId(pt.id) && hiddenIds.has(pt.id);

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
  ui.lastGid = g.id;
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
  return `rgb(${P.hsvToRgb(hue, saturation, 1).map(v => Math.round(v * 255)).join(',')})`;
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
  $('#groups').replaceChildren(...[!demo && inbox.length ? inboxBanner() : null, ...groups.map(groupCard)].filter(Boolean));
}

// Collapsed groups show only the essentials. Kept per person and per house.
const houseCollapseKey = () => (demo ? 'demo' : house?.key || '');
// Until you choose, the first group starts open and the rest closed.
const collapsedList = () => collapsedGroups[houseCollapseKey()] ?? getGroups().slice(1).map(g => g.id);
const isCollapsed = gid => collapsedList().includes(gid);
function setCollapsed(gids, collapsed) {
  const key = houseCollapseKey();
  const set = new Set(collapsedList());
  for (const gid of gids) collapsed ? set.add(gid) : set.delete(gid);
  collapsedGroups = { ...collapsedGroups, [key]: [...set] };
  if (!demo) saveUserPrefs();
  renderMain();
}

// Re-draw whichever screen is showing (after lights or settings change).
function rerender() {
  if (!$('#main').hidden) renderMain();
  else if (!$('#library').hidden && libView) renderLibrary();
  else if (!$('#group').hidden && groupScreen) renderGroupScreen();
  else renderMain();
}

// A group is one card in two parts:
//   now     the lights themselves: what's showing, power, brightness
//           (all you see when the card is collapsed)
//   adjust  three ways to change what's showing: Color · Motion · Schedule
// Colors, patterns and schedules are made in the Library; here you only pick.

const ICON = {
  color: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c3.2 4.1 6 7.2 6 10.6a6 6 0 0 1-12 0c0-3.4 2.8-6.5 6-10.6z"/></svg>',
  motion: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12c2.4-5 4.7-5 7 0s4.7 5 7 0 3.3-4.2 5-2.5"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z"/></svg>',
};
const icon = name => { const s = el('span', { class: 'ico', 'aria-hidden': 'true' }); s.innerHTML = ICON[name]; return s; };

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
  const collapsed = isCollapsed(g.id);
  const status = groupStatus(g, now, on, online);
  const lit = on && status.colors.length > 0;
  const toggle = () => setCollapsed([g.id], !collapsed);

  const hero = el('div', {
    class: 'now' + (lit ? ' lit' : ''),
    style: lit ? glowStyle(status.colors) : '',
    // Tapping this part (anywhere but its controls) opens or closes the card.
    onclick: e => { if (!e.target.closest('button, input, label, .switch')) toggle(); },
  },
  el('div', { class: 'now-top' },
    el('button', {
      class: 'group-toggle', 'aria-expanded': String(!collapsed), 'aria-label': `${g.name}, ${collapsed ? 'show controls' : 'hide controls'}`, onclick: toggle,
    },
    el('span', { class: 'group-name' }, g.name, el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
    el('span', { class: 'group-sub', text: sub })),
    el('button', { class: 'icon-btn ghost', 'aria-label': `${g.name}: strips and order`, title: 'Strips and order', onclick: () => openGroupScreen(g) }, '⋯'),
    toggleSwitch(on, !online.length, e =>
      run(`${g.name} ${e.target.checked ? 'on' : 'off'}`, () => setState(sel, { power: e.target.checked ? 'on' : 'off' })))),
  el('div', { class: 'now-status' },
    el('div', { class: 'now-label', text: on ? 'Now showing' : online.length ? 'Lights off' : 'Not reachable' }),
    el('div', { class: 'now-title', text: status.title }),
    status.detail && el('div', { class: 'now-detail', text: status.detail })),
  lightString(status, on),
  !collapsed && online.length > 0 && brightnessRow(g, now, p, online));

  const card = el('section', { class: 'group-card' + (collapsed ? ' collapsed' : ''), 'aria-label': g.name }, hero);
  if (!online.length || collapsed) return card;

  const tab = ui.tab[g.id] || 'color';
  const tabs = [['color', 'Color'], ['motion', 'Motion'], ['schedule', 'Schedule']];
  card.append(el('div', { class: 'adjust' },
    el('div', { class: 'adjust-tabs', role: 'tablist', 'aria-label': `Change what ${g.name} shows` },
      ...tabs.map(([k, label]) => el('button', {
        role: 'tab', class: 'adjust-tab' + (tab === k ? ' active' : ''), 'aria-selected': String(tab === k),
        onclick: () => { ui.tab[g.id] = k; renderMain(); },
      }, icon(k), el('span', { text: label }), k === 'motion' && now?.effect?.type && now.effect.type !== 'none' ? el('span', { class: 'tab-dot', 'aria-label': '(moving)' }) : null))),
    el('div', { class: 'adjust-panel', role: 'tabpanel' },
      tab === 'color' ? colorTab(g, now) : tab === 'motion' ? motionTab(g, now) : demo ? el('p', { class: 'muted small', text: 'Schedules aren’t available in demo mode.' }) : scheduleTab(g))),
  multi && !p.ordered && el('button', { class: 'card-tip', onclick: () => openGroupScreen(g) },
    el('span', { class: 'grow' }, el('strong', { text: 'Set your strip order' }), el('span', { class: 'muted small', text: 'So patterns flow around the house the right way' })),
    el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
  return card;
}

// What the top of the card says: what's on now, or (when off) what's next.
function groupStatus(g, now, on, online) {
  const lightColors = () => online.filter(l => l.power === 'on').map(cssColor);
  if (!online.length) return { title: 'Offline', detail: 'Check the lights’ power and Wi-Fi', colors: [] };
  if (!on) {
    const next = !demo && nextScheduled(g);
    if (!next) return { title: 'Off', detail: 'No schedule', colors: [] };
    const tz = next.s.location.tz;
    return { title: `Fades on ${dayWord(next.plan, tz).toLowerCase()} at ${fmtTime(next.plan.fadeInStart, tz)}`, detail: scheduledName(g, next.s), colors: [] };
  }
  if (!now) return { title: 'Colors set elsewhere', detail: 'Pick something below to take over', colors: lightColors() };
  const t = d => fmtTime(d, now.tz);
  const moving = now.effect?.type && now.effect.type !== 'none' ? ` · ${MOTION_NAME[now.effect.type]}` : '';
  return {
    title: patternLabel(now.name, now.id) + moving,
    detail: now.scheduled ? `From your schedule · fades off at ${t(now.until)}` : now.until ? `Until the ${t(now.until)} fade-off` : '',
    cells: now.cells,
    // Unknown cells (e.g. someone else's pattern): use the lights' own colors.
    colors: now.cells ? now.cells.filter(x => x.b > 0).map(cellCss) : lightColors(),
  };
}

// The lights as a string of glowing bulbs, in their current colors.
function lightString(status, on, count = 30) {
  const box = el('div', { class: 'light-string' + (on ? '' : ' dark'), 'aria-hidden': 'true' });
  const cells = status.cells;
  for (let i = 0; i < count; i++) {
    let css = null, b = 1;
    if (on && cells?.length) {
      const x = cells[Math.floor((i * cells.length) / count)];
      if (x.b > 0) { css = cellCss(x); b = x.b; }
    } else if (on && status.colors.length) {
      css = status.colors[Math.floor((i * status.colors.length) / count)];
    }
    box.append(el('span', { style: css ? `--c:${css};opacity:${Math.max(0.45, Math.min(1, b * 1.5))}` : '' }));
  }
  return box;
}

// A soft wash of the lights' colors behind the top of the card.
function glowStyle(colors) {
  const at = f => colors[Math.min(colors.length - 1, Math.floor(f * colors.length))];
  const mix = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  return `background:
    radial-gradient(120% 100% at 0% 0%, ${mix(at(0.1), 30)}, transparent 65%),
    radial-gradient(120% 100% at 100% 100%, ${mix(at(0.9), 24)}, transparent 65%),
    radial-gradient(90% 80% at 70% 0%, ${mix(at(0.5), 16)}, transparent 70%);`;
}

function brightnessRow(g, now, p, online) {
  const sel = `group_id:${g.id}`;
  const value = now?.scheduled ? Math.round(now.level * 100)
    : now ? Math.round(p.level * 100)
      : Math.round(Math.max(0, ...online.map(l => l.brightness || 0)) * 100);
  return el('div', { class: 'bright-row' },
    el('span', { class: 'sun dim', 'aria-hidden': 'true' }, '☀︎'),
    el('input', {
      type: 'range', min: 1, max: 100, value: value || 1, 'aria-label': `${g.name} brightness`,
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
    el('span', { class: 'sun', 'aria-hidden': 'true' }, '☀︎'));
}

const MOTION_NAME = { none: 'Steady', chase: 'Chase', breathe: 'Breathe', pulse: 'Pulse' };
const isWhite = c => (parseColor(c).saturation ?? 0) < 0.05;

// ----- Color: patterns that fit right now, the house's colors, the library -----

function colorTab(g, now) {
  const anyColor = g.lights.some(hasColor);
  const favs = favColors.filter(f => anyColor || isWhite(f.c));
  const current = isSolid(now) ? now.cells[0].c : null;
  return el('div', { class: 'panel-stack' },
    el('div', { class: 'panel-label' }, el('span', { text: 'Patterns' }), el('span', { class: 'muted small', text: 'In season and recent' })),
    el('div', { class: 'pattern-grid' }, ...topPatterns(g, now).map(pt => patternChip(g, pt, now))),
    el('div', { class: 'panel-label' }, el('span', { text: 'Solid colors' }),
      el('button', { class: 'link small', onclick: () => openLibraryTab('colors') }, 'Edit')),
    el('div', { class: 'swatch-row' },
      ...favs.map(f => {
        const label = f.name || colorName(f.c);
        return sw(colorCss(f.c), label, () => playColor(g, f.c, label), {
          class: 'swatch-btn' + (current === f.c ? ' active' : ''), 'aria-pressed': String(current === f.c),
        });
      }),
      el('button', {
        class: 'swatch-btn more-colors', title: 'Any color', 'aria-label': 'Pick any color',
        onclick: () => openColorSheet({
          title: `Any color · ${g.name}`, initial: current || 'hue:210 saturation:1', whiteOnly: !anyColor,
          useLabel: 'Show this color', offerFavorite: true, onPick: c => playColor(g, c, colorName(c)),
        }),
      }, el('span', { 'aria-hidden': 'true' }, '+'))),
    el('button', { class: 'all-row', onclick: () => openLibrary(g) },
      el('span', { class: 'grow' }, 'Browse the library'),
      el('span', { class: 'muted small', text: `${BUILTIN.length + saved.length} patterns` }),
      el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
}

function addFavorite(c) {
  if (favColors.some(f => f.c === c)) return showActivity('Already in your colors', 'ok');
  favColors = [...favColors, { c, name: colorName(c) }].slice(0, 24);
  saveLibrary();
  showActivity('✓ Added to the house colors', 'ok');
}

// In-season holidays, then what's been played lately, then the house's own patterns.
function topPatterns(g, now) {
  const today = new Date();
  const out = [];
  const add = pt => { if (pt && !out.some(x => x.id === pt.id)) out.push(pt); };
  const find = id => builtinById(id) || saved.find(x => x.id === id);
  BUILTIN.filter(b => b.category === 'holidays' && inSeason(b, today) && !isHidden(b)).forEach(add);
  for (const id of gp(g.id).recent || []) add(find(id));
  saved.slice(-4).reverse().forEach(add);
  if (out.length < 4) add(builtinById('b-warm'));
  const top = out.slice(0, 6);
  // Whatever is showing is always there to see (without reshuffling the rest).
  const showingNow = now?.id && !isSolid(now) && find(now.id);
  if (showingNow && !top.includes(showingNow)) top.splice(Math.min(top.length, 5), 1, showingNow);
  return top;
}

function patternChip(g, pt, now) {
  const n = positions(g.lights, g.id).length;
  const active = !!now && !isSolid(now) && (now.id ? now.id === pt.id : now.name === pt.name);
  return el('button', {
    class: 'pattern-chip' + (active ? ' active' : ''), 'aria-pressed': String(active),
    onclick: () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)),
  }, previewStrip(patternCells(pt, g.id, Math.min(n, 48)), 16, isSmooth(pt)), el('span', { class: 'chip-name', text: patternLabel(pt.name, pt.id) }));
}

// ----- Motion: how what's showing moves, changed on the spot -----

const MOTION_HELP = {
  none: 'The colors stay still.',
  chase: 'The colors travel along the lights.',
  breathe: 'The lights fade gently down and back up.',
  pulse: 'The lights blink in a steady beat.',
};

function motionTab(g, now) {
  const sel = `group_id:${g.id}`;
  const mo = normalizeMotion(now?.effect);
  const apply = (next, label) => run(`${label} · ${g.name}`, async () => {
    await effectsOff(sel);
    if (next.type !== 'none') await startMotion(sel, next);
    setLastMotion(g, next, now);
  });
  return el('div', { class: 'panel-stack' },
    el('div', { class: 'segmented four', role: 'group', 'aria-label': 'Motion' },
      ...['none', 'chase', 'breathe', 'pulse'].map(type => el('button', {
        class: mo.type === type ? 'active' : '', 'aria-pressed': String(mo.type === type),
        onclick: () => apply({ ...mo, type }, MOTION_NAME[type]),
      }, MOTION_NAME[type]))),
    el('p', { class: 'muted small panel-note', text: MOTION_HELP[mo.type] }),
    mo.type !== 'none' && el('div', { class: 'motion-extra' },
      mo.type === 'chase' && el('button', {
        class: 'small', 'aria-label': 'Change direction',
        onclick: () => apply({ ...mo, dir: mo.dir === 'backward' ? 'forward' : 'backward' }, 'Change direction'),
      }, mo.dir === 'backward' ? '← Back' : 'Forward →'),
      el('div', { class: 'speed-control grow' },
        el('span', { class: 'muted small', text: 'Slow' }),
        el('input', {
          type: 'range', min: 0, max: 100, value: Math.round(mo.speed * 100), 'aria-label': 'Speed, slow to fast',
          onchange: e => apply({ ...mo, speed: e.target.value / 100 }, 'Speed'),
        }),
        el('span', { class: 'muted small', text: 'Fast' }))),
    el('p', { class: 'muted small panel-note', text: 'Changes this group only. A pattern’s own motion is set in the pattern maker.' }));
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

// ----- Schedule: which library schedules this group follows -----

function scheduleTab(g) {
  const list = groupSchedules(g.id);
  const stale = timerInfo?.configured && (!timerInfo.lastTick || Date.now() - timerInfo.lastTick > 20 * 60000) && !timerInfo.repaired;
  if (!list.length) {
    return el('div', { class: 'panel-stack empty-state' },
      el('div', { class: 'empty-icon' }, icon('schedule')),
      el('strong', { text: 'No schedule yet' }),
      el('p', { class: 'muted small', text: 'Fade on at sunset and off at bedtime, every evening, even with your phone off.' }),
      el('button', { class: 'primary', onclick: () => openSchedule(g, null) }, 'Add a schedule'));
  }
  return el('div', { class: 'panel-stack' },
    el('div', { class: 'list' }, ...list.map(s => scheduleRow(g, s))),
    el('button', { class: 'all-row', onclick: () => openSchedule(g, null) },
      el('span', { class: 'grow' }, 'Add a schedule'), el('span', { class: 'chev', 'aria-hidden': 'true' }, '+')),
    stale && list.some(s => s.enabled) && el('p', { class: 'hint warn small', text: 'The schedule timer hasn’t checked in lately. It’s being restarted; check again in a few minutes.' }));
}

function scheduleRow(g, s) {
  const { title, detail } = tonightText(g, s);
  const name = timings[s.timingId]?.name || 'Schedule';
  return el('div', { class: 'schedule-row' + (s.enabled ? '' : ' paused') },
    el('button', { class: 'sched-open', 'aria-label': `${name}: ${title}. ${detail}`, onclick: () => openSchedule(g, s) },
      el('span', { class: 'grow' },
        el('strong', { text: name }),
        el('span', { class: 'small', text: title }),
        el('span', { class: 'muted small', text: detail }))),
    toggleSwitch(s.enabled, false, async e => {
      const enabled = e.target.checked;
      try {
        const res = await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: { ...s, enabled } });
        upsertSchedule(res.schedule);
        showActivity(enabled ? `✓ ${name} on` : `${name} paused`, 'ok');
      } catch (err) { showActivity(err.message, 'err'); }
      renderMain();
    }));
}

// A small strip of color previewing cells (sampled down to fit).
// Smooth patterns (gradients, moods) preview as one continuous blend.
function previewStrip(cells, max = 36, smooth = false) {
  const box = el('span', { class: 'preview-strip', 'aria-hidden': 'true' });
  if (!cells?.length) { box.classList.add('unknown'); return box; }
  if (smooth) {
    const n = Math.min(cells.length, 24);
    const stops = Array.from({ length: n }, (_, i) => {
      const x = cells[Math.floor((i * (cells.length - 1)) / Math.max(1, n - 1))];
      return `${x.b > 0 ? cellCss(x) : '#1b1d23'} ${((i / Math.max(1, n - 1)) * 100).toFixed(1)}%`;
    });
    box.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
    return box;
  }
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

// ---------- Library ----------
// The house's patterns, colors and schedules: made, edited and deleted here,
// used by every group. Two ways in:
//   browse  the Library tab: manage everything
//   pick    from a group's card: tap a pattern or color to show it on that group

let libView = null; // { mode: 'browse' | 'pick', gid, seg: 'patterns' | 'colors' | 'schedules', editColors }

function openLibrary(g, seg = 'patterns') {
  libView = { mode: 'pick', gid: g.id, seg };
  show('library');
  window.scrollTo(0, 0);
  renderLibrary();
}

function openLibraryTab(seg = libView?.seg || 'patterns') {
  libView = { mode: 'browse', gid: null, seg };
  show('library');
  window.scrollTo(0, 0);
  renderLibrary();
}

// The group the pattern maker previews on when you start from the Library.
function previewGroup() {
  const groups = getGroups();
  return groups.find(g => g.id === ui.lastGid) || [...groups].sort((a, b) => positions(b.lights, b.id).length - positions(a.lights, a.id).length)[0] || null;
}

const SEASON_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const seasonText = pt => pt.seasons?.length
  ? pt.seasons.map(([f, t]) => { const a = SEASON_MONTHS[+f.slice(0, 2) - 1], b = SEASON_MONTHS[+t.slice(0, 2) - 1]; return a === b ? a : `${a}–${b}`; }).join(', ')
  : '';
const canCustomize = pt => !isSavedId(pt.id) && pt.layout !== 'blend';
const isSmooth = pt => pt?.layout === 'gradient' || pt?.layout === 'blend';
const mine0 = pt => isSavedId(pt.id);

function renderLibrary() {
  const v = libView;
  const g = v.gid ? groupById(v.gid) : null;
  const pick = v.mode === 'pick' && g;
  if (v.mode === 'pick' && !g) { libView = null; show('main'); renderMain(); return; }
  if (pick && v.seg === 'schedules') v.seg = 'patterns';
  $('#library-title').textContent = pick ? `Choose for ${g.name}` : 'Library';
  $('#library-sub').textContent = pick ? 'Tap to show it now' : `${house?.name || 'Demo House'} · shared with everyone here`;
  $('#library-back').hidden = !pick;
  $('#library').classList.toggle('browse', !pick); // a top-level tab: large title, like Home
  document.querySelectorAll('#library-seg button').forEach(b => {
    b.classList.toggle('active', b.dataset.seg === v.seg);
    b.setAttribute('aria-selected', String(b.dataset.seg === v.seg));
    b.hidden = pick && b.dataset.seg === 'schedules';
  });
  $('#library-seg').classList.toggle('two', !!pick);
  $('#library-seg').classList.toggle('three', !pick);
  const body = v.seg === 'colors' ? libraryColors(g) : v.seg === 'schedules' ? librarySchedules() : libraryPatterns(g);
  $('#library-body').replaceChildren(...body.filter(Boolean));
}

function libraryPatterns(g) {
  const pg = g || previewGroup();
  const now = g ? showing(g) : null;
  const n = pg ? positions(pg.lights, pg.id).length : 40;
  const cellsFor = pt => (pg ? patternCells(pt, pg.id, Math.min(n, 60)) : P.patternCells(pt, {}, 40));
  const row = (pt, sub) => {
    const active = !!now && !isSolid(now) && (now.id ? now.id === pt.id : now.name === pt.name);
    const mo = patternMotion(pt);
    const details = [sub, mine0(pt) && isGradient(pt) && 'Gradient', mo.type !== 'none' && MOTION_NAME[mo.type]].filter(Boolean).join(' · ');
    const mine = isSavedId(pt.id);
    const edit = () => pg && (isGradient(pt) ? openGradient : openMaker)(pg.id, pt, { from: 'library', copy: !mine });
    const play = g
      ? () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)).then(() => { if (libView) renderLibrary(); })
      : mine || canCustomize(pt) ? edit : null;
    return el('div', { class: 'lib-row' + (active ? ' active' : '') },
      el('button', { class: 'lib-play', 'aria-pressed': g ? String(active) : null, disabled: !play, onclick: play },
        previewStrip(cellsFor(pt), 30, isSmooth(pt)),
        el('span', { class: 'grow' }, el('strong', { text: patternLabel(pt.name, pt.id) }), details && el('span', { class: 'muted small', text: details })),
        active && el('span', { class: 'check', text: '✓' }),
        !g && play && el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')),
      g && (mine || canCustomize(pt)) && el('button', {
        class: 'icon-btn ghost', 'aria-label': mine ? `Edit ${pt.name}` : `Make your own version of ${pt.name}`,
        title: mine ? 'Edit' : 'Make your own version', onclick: edit,
      }, '✎'));
  };
  const today = new Date();
  const editing = !g && !!libView.editPatterns;
  // In edit mode built-ins get Hide (or Show, when hidden).
  const withHide = (pt, node) => {
    if (!editing || isSavedId(pt.id)) return node;
    node.append(el('button', {
      class: 'pill', 'aria-label': `${isHidden(pt) ? 'Show' : 'Hide'} ${pt.name}`,
      onclick: () => { if (isHidden(pt)) hiddenIds.delete(pt.id); else hiddenIds.add(pt.id); saveLibrary(); renderLibrary(); },
    }, isHidden(pt) ? 'Show' : 'Hide'));
    return node;
  };
  const visible = pt => !isHidden(pt);
  const out = [
    !g && inbox.length && el('h3', { text: 'Shared with you' }),
    !g && inbox.length && el('div', { class: 'lib-list' }, ...inbox.map(sharedRow)),
    !g && el('div', { class: 'section-head-row lib-tools' },
      el('span', { class: 'muted small', text: hiddenIds.size ? `${hiddenIds.size} hidden` : '' }),
      el('button', { class: 'link small strong', onclick: () => { libView.editPatterns = !editing; renderLibrary(); } }, editing ? 'Done' : 'Edit')),
    pg && !editing && el('button', { class: 'lib-new', onclick: () => newPattern(pg.id) },
      el('span', { class: 'lib-new-icon', 'aria-hidden': 'true' }, '+'),
      el('span', { class: 'grow' }, el('strong', { text: 'New pattern' }), el('span', { class: 'muted small', text: 'Your own colors, spacing and motion' }))),
  ];
  const section = (title, items, note) => {
    if (!items.length) return;
    out.push(el('h3', { text: title }), el('div', { class: 'lib-list' }, ...items));
    if (note) out.push(el('p', { class: 'muted small lib-note', text: note }));
  };
  section(`${house?.name || 'House'} patterns`, [...saved].reverse().map(pt => row(pt, '')));
  section('In season now', BUILTIN.filter(b => inSeason(b, today) && visible(b)).map(pt => withHide(pt, row(pt, seasonText(pt)))));
  for (const c of CATEGORIES) {
    section(c.name, BUILTIN.filter(b => b.category === c.id && visible(b) && !(c.id === 'holidays' && inSeason(b, today))).map(pt => withHide(pt, row(pt, c.id === 'holidays' ? seasonText(pt) : ''))),
      c.id === 'cozy' ? 'Moods use the colors of the LIFX app’s Moods, blended smoothly along your lights.' : '');
  }
  const hidden = BUILTIN.filter(isHidden);
  if (!g && hidden.length) {
    if (libView.showHidden || editing) section('Hidden', hidden.map(pt => withHide(pt, row(pt, 'Hidden'))));
    else out.push(el('button', { class: 'link small show-hidden', onclick: () => { libView.showHidden = true; renderLibrary(); } }, `Show ${hidden.length} hidden pattern${hidden.length === 1 ? '' : 's'}`));
  }
  if (!g) out.push(el('p', { class: 'muted small lib-note', text: editing ? 'Hidden patterns stay out of the Color tab and the Library. You can show them again any time.' : 'Built-in patterns can’t be changed, but you can make your own version of any repeating one.' }));
  return out;
}

function libraryColors(g) {
  const v = libView;
  const editing = !!v.editColors;
  const tile = f => {
    const label = f.name || colorName(f.c);
    const current = g && isSolid(showing(g)) && showing(g).cells[0].c === f.c;
    return el('button', {
      class: 'color-tile' + (editing ? ' editing' : '') + (current ? ' active' : ''),
      'aria-label': editing ? `Remove ${label}` : g ? `Show ${label} on ${g.name}` : label,
      onclick: () => {
        if (editing) { favColors = favColors.filter(x => x !== f); saveLibrary(); renderLibrary(); return; }
        if (g) playColor(g, f.c, label).then(() => { if (libView) renderLibrary(); });
      },
    },
    el('span', { class: 'color-dot', style: `background:${colorCss(f.c)}` }, editing && el('span', { class: 'remove-badge', 'aria-hidden': 'true' }, '✕')),
    el('span', { class: 'color-name', text: label }));
  };
  return [
    el('div', { class: 'section-head-row' },
      el('h3', { text: g ? 'Solid colors' : 'House colors' }),
      !g && el('button', { class: 'link small strong', onclick: () => { v.editColors = !editing; renderLibrary(); } }, editing ? 'Done' : 'Edit')),
    el('div', { class: 'card color-grid' },
      ...favColors.map(tile),
      el('button', {
        class: 'color-tile', 'aria-label': 'Add a color',
        onclick: () => openColorSheet({
          title: g ? `Any color · ${g.name}` : 'Add a house color', initial: 'hue:210 saturation:1',
          useLabel: g ? 'Show this color' : 'Add to house colors', offerFavorite: !!g,
          onPick: c => { if (g) playColor(g, c, colorName(c)); else { addFavorite(c); renderLibrary(); } },
        }),
      }, el('span', { class: 'color-dot more-colors' }, el('span', { 'aria-hidden': 'true' }, '+')), el('span', { class: 'color-name', text: g ? 'Any color' : 'Add' }))),
    el('p', { class: 'muted small lib-note', text: 'These are the quick picks on every group’s Color tab.' }),
    editing && el('button', { class: 'link small', onclick: () => { favColors = defaultFavorites(); saveLibrary(); renderLibrary(); } }, 'Reset to the default colors'),
  ];
}

// "Sunset · fade in 1 hr → 11:00 PM · fade out 30 min · Every day"
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function daysText(days) {
  const d = [...days].sort().join(',');
  if (d === '0,1,2,3,4,5,6') return 'Every day';
  if (d === '1,2,3,4,5') return 'Weeknights';
  if (d === '0,6') return 'Weekends';
  return days.map(x => DAY_NAMES[x]).join(', ');
}
const clock = hhmm => { const [h, m] = hhmm.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
function timingSummary(t) {
  const on = t.on.mode === 'sunset'
    ? (t.on.offsetMin ? `${Math.abs(t.on.offsetMin)} min ${t.on.offsetMin < 0 ? 'before' : 'after'} sunset` : 'Sunset')
    : clock(t.on.time);
  const season = t.season ? ` · ${seasonText({ seasons: [[t.season.from, t.season.to]] })}` : '';
  return `${on} → ${clock(t.off.time)} · ${daysText(t.days)}${season}`;
}
const groupsUsing = id => allSchedules().filter(s => s.timingId === id).map(s => groupById(s.groupId)?.name || s.groupName);

function librarySchedules() {
  const list = Object.values(timings).sort((a, b) => a.name.localeCompare(b.name));
  return [
    el('button', { class: 'lib-new', onclick: () => openTiming(null) },
      el('span', { class: 'lib-new-icon', 'aria-hidden': 'true' }, '+'),
      el('span', { class: 'grow' }, el('strong', { text: 'New schedule' }), el('span', { class: 'muted small', text: 'When lights fade on and off' }))),
    list.length ? el('h3', { text: 'Schedules' }) : el('p', { class: 'muted small lib-note', text: 'No schedules yet. Make one here, then pick it on any group’s Schedule tab.' }),
    list.length && el('div', { class: 'lib-list' }, ...list.map(t => {
      const used = groupsUsing(t.id);
      return el('div', { class: 'lib-row' },
        el('button', { class: 'lib-play', onclick: () => openTiming(t) },
          el('span', { class: 'sched-badge', 'aria-hidden': 'true' }, icon('schedule')),
          el('span', { class: 'grow' },
            el('strong', { text: t.name }),
            el('span', { class: 'muted small', text: timingSummary(t) }),
            el('span', { class: 'small used', text: used.length ? `Used by ${used.join(', ')}` : 'Not used by any group yet' })),
          el('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
    })),
    list.length && el('p', { class: 'muted small lib-note', text: 'Changing a schedule here changes it for every group that uses it.' }),
  ];
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
    overrides: isSaved || opts.keepCells ? overridesFor(pattern, seq, n) : {},
    motion: patternMotion(pattern),
    name: isSaved || opts.keepCells ? pattern.name : opts.copy ? `${pattern.name.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, '')} (mine)`.slice(0, 40) : '',
    // Converted from a gradient: every light is its own color, so don't mark them as "changed".
    painted: !!opts.keepCells || !!pattern?.painted,
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
  const back = maker.from === 'library' && libView ? 'library' : 'main';
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
      if (isGradient(p)) { maker = null; openGradient(m.gid, p, { from: m.from || 'library' }); return; }
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
      if (m.overrides[i] && !m.painted) node.classList.add('changed');
      row.push(node);
    }
    rows.push(el('div', { class: 'strip-row' },
      el('div', { class: 'muted small', text: `${l.label} · ${len} light${len === 1 ? '' : 's'}` }),
      el('div', { class: 'grid house' }, row)));
  }
  $('#house-grid').replaceChildren(...rows);
  const changed = Object.keys(m.overrides).length;
  $('#overrides-note').hidden = !changed || m.painted;
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
    ...(maker.painted ? { painted: true } : {}),
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
  if (!s) return;
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


// The schedule screen edits one of two things:
//   'use'     a group's schedule: which library schedule it follows, the
//             pattern and brightness, on/off and skip tonight
//   'timing'  a library schedule: its name and when it runs (every group
//             using it follows)
let sched = null; // { mode, g, s, isNew, start, picking, pickingWhen, back }

const TIMING_FIELDS = ['on', 'off', 'days', 'season'];
const timesOf = t => Object.fromEntries(TIMING_FIELDS.map(f => [f, clone(t[f])]));

async function openSchedule(g, existing, opts = {}) {
  const firstFree = Object.values(timings).find(t => !groupSchedules(g.id).some(x => x.timingId === t.id)) || Object.values(timings)[0];
  if (!existing && !firstFree && !opts.timingId) {
    // Nothing in the library yet: make the schedule first, then come back here.
    return openTiming(null, { thenUseFor: g });
  }
  const timing = timings[opts.timingId] || (existing && timings[existing.timingId]) || firstFree;
  const s = existing ? clone(existing) : {
    ...clone(core.DEFAULT_SCHEDULE),
    id: newScheduleId(),
    groupId: g.id,
    groupName: g.name,
    // New schedules fade on whatever was played last, so they never surprise you.
    pattern: { source: 'last', name: 'Last played' },
  };
  if (timing) Object.assign(s, timesOf(timing), { timingId: timing.id });
  s.location = houseLocation || s.location || null;
  // Schedules from before patterns were linked kept only a name: link them up.
  if (!s.pattern.source) {
    const b = BUILTIN.find(x => x.name === s.pattern.name);
    const mine = saved.find(x => x.name === s.pattern.name);
    if (b) s.pattern = { ...s.pattern, source: 'builtin', id: b.id };
    else if (mine) s.pattern = { ...s.pattern, source: 'saved', id: mine.id };
  }
  sched = { mode: 'use', g, s, isNew: !existing, start: JSON.stringify(s), picking: false, pickingWhen: false, back: opts.back || 'main' };
  show('sched');
  window.scrollTo(0, 0);
  renderSchedule();
}

// opts.thenUseFor: a group to add this schedule to once it's saved.
function openTiming(t, opts = {}) {
  const base = t ? clone(t) : { id: `t${newScheduleId()}`, name: uniqueTimingName(), ...timesOf(core.DEFAULT_SCHEDULE) };
  const s = { ...base, enabled: true, skipDates: [], level: 1, location: houseLocation };
  sched = { mode: 'timing', s, isNew: !t, start: JSON.stringify(s), thenUseFor: opts.thenUseFor || null, back: opts.back || (opts.thenUseFor ? 'main' : 'library') };
  show('sched');
  window.scrollTo(0, 0);
  renderSchedule();
}

function uniqueTimingName() {
  const taken = new Set(Object.values(timings).map(t => t.name));
  if (!taken.has('Evening')) return 'Evening';
  for (let n = 2; ; n++) if (!taken.has(`Evening ${n}`)) return `Evening ${n}`;
}

function closeSchedule(force = false) {
  if (!force && sched && JSON.stringify(sched.s) !== sched.start && !confirm('Leave without saving your schedule changes?')) return;
  if (sched?.returnToUse) {
    // Back from editing times to the group's schedule.
    const { g, id } = sched.returnToUse;
    const existing = allSchedules().find(x => x.id === id);
    sched = null;
    openSchedule(g, existing || null);
    return;
  }
  const back = sched?.back === 'library' && libView ? 'library' : sched?.back === 'library' ? 'library-tab' : 'main';
  sched = null;
  if (back === 'library-tab') { openLibraryTab('schedules'); return; }
  show(back);
  rerender();
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
    opts.push({ ref: { source: 'saved', id: pt.id, name: pt.name }, label: `⭐ ${pt.name}`, cells: patternCells(pt, g.id, n), smooth: isSmooth(pt), group: 'House patterns', motion: patternMotion(pt) });
  }
  for (const pt of BUILTIN) {
    if (isHidden(pt) && !(ref.source === 'builtin' && ref.id === pt.id)) continue;
    opts.push({ ref: { source: 'builtin', id: pt.id, name: pt.name }, label: pt.name, cells: patternCells(pt, g.id, n), smooth: isSmooth(pt), group: 'Built in' });
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
    previewStrip(chosen.cells, 36, chosen.smooth),
    el('span', { class: 'grow' }, el('strong', { text: chosen.label }), el('span', { class: 'muted small', text: chosen.sub || (chosen.group === 'House patterns' ? 'House pattern' : chosen.group) || '' })),
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
    previewStrip(o.cells, 36, o.smooth),
    el('span', { class: 'grow' },
      el('strong', { text: o.label }),
      (o.sub || MOTION_TEXT[o.motion?.type]) && el('span', { class: 'muted small', text: o.sub || MOTION_TEXT[o.motion.type] })),
    el('span', { class: 'check', text: active ? '✓' : '' })));
  }
  list.replaceChildren(...rows);
}

function renderSchedule() {
  const { g, s, mode } = sched;
  const timingMode = mode === 'timing';
  const timing = timingMode ? s : timings[s.timingId];
  $('#sched-title').textContent = timingMode ? (sched.isNew ? 'New schedule' : s.name || 'Schedule') : (timing?.name || 'Schedule');
  $('#sched-sub').textContent = timingMode ? `Library · ${house?.name || ''}` : `${g.name} · ${house.name}`;
  $('#sched-save').textContent = sched.isNew ? 'Save' : JSON.stringify(s) === sched.start ? 'Saved ✓' : 'Save';
  $('#sched-save').classList.toggle('primary', JSON.stringify(s) !== sched.start || sched.isNew);

  // What each mode shows: a library schedule edits times; a group's schedule
  // picks one, plus its pattern and brightness.
  $('#sched-name-card').hidden = !timingMode;
  $('#sched-when-card').hidden = timingMode;
  for (const id of ['#sched-on-card', '#sched-off-card', '#sched-days-card']) $(id).hidden = !timingMode;
  $('#sched-pattern-card').hidden = timingMode;
  $('#sched-loc-card').hidden = !timingMode && !!s.location;
  $('#sched-enabled-wrap').hidden = timingMode;
  if (timingMode) {
    if (document.activeElement !== $('#sched-name')) $('#sched-name').value = s.name;
    const used = groupsUsing(s.id);
    $('#sched-used').textContent = used.length
      ? `Used by ${used.join(', ')}. Changes apply to ${used.length === 1 ? 'it' : 'all of them'}.`
      : sched.thenUseFor ? `Will be added to ${sched.thenUseFor.name} when you save.` : 'Not used by any group yet. Pick it on a group’s Schedule tab.';
  } else {
    renderWhenPicker();
  }

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

  // Pattern (a group's schedule only)
  if (!timingMode) renderPatternPicker();
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
  $('#skip-btn').hidden = timingMode || sched.isNew || !s.location;
  $('#skip-btn').textContent = s.skipDates.includes(today) ? '↩︎ Run tonight after all' : '⏭ Skip tonight';
  $('#sched-delete').hidden = sched.isNew;
  $('#sched-delete').textContent = timingMode ? 'Delete schedule' : `Remove from ${g.name}`;
  // Two schedules on the same evenings would fight over the lights.
  const clash = timingMode ? null : groupSchedules(g.id).filter(x => x.id !== s.id).map(x => [x, overlapDays(s, x)]).find(([, n]) => n > 0);
  $('#sched-overlap').hidden = !clash;
  if (clash) {
    $('#sched-overlap').textContent = `Runs on the same evenings as “${timings[clash[0].timingId]?.name || 'another schedule'}” on ${g.name} (${clash[1]} days in the next year). Both would change the lights. Pick a different schedule, or pause one.`;
  }
  $('#sched-enabled').checked = s.enabled;

  // Timer health (only once something is saved)
  const stale = !timerInfo?.lastTick || Date.now() - timerInfo.lastTick > 20 * 60000;
  $('#timer-warning').hidden = timingMode || sched.isNew || !timerInfo || (timerInfo.configured && !stale);
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

// A group's schedule: which library schedule it follows.
function renderWhenPicker() {
  const { s } = sched;
  const t = timings[s.timingId];
  const btn = $('#sched-when');
  btn.setAttribute('aria-expanded', String(sched.pickingWhen));
  btn.replaceChildren(
    el('span', { class: 'sched-badge', 'aria-hidden': 'true' }, icon('schedule')),
    el('span', { class: 'grow' }, el('strong', { text: t?.name || 'Choose a schedule' }), el('span', { class: 'muted small', text: t ? timingSummary(t) : '' })),
    el('span', { class: 'chev', text: '›' }));
  const others = t ? groupsUsing(t.id).filter(n => n !== sched.g.name) : [];
  $('#sched-when-note').textContent = others.length ? `Also used by ${others.join(', ')}` : 'Times are shared from the Library';
  $('#sched-edit-times').hidden = !t;
  const list = $('#sched-when-list');
  list.hidden = !sched.pickingWhen;
  if (!sched.pickingWhen) { list.replaceChildren(); return; }
  list.replaceChildren(
    ...Object.values(timings).sort((a, b) => a.name.localeCompare(b.name)).map(x => el('button', {
      class: 'pick-option' + (x.id === s.timingId ? ' active' : ''), role: 'radio', 'aria-checked': String(x.id === s.timingId),
      onclick: () => { sched.pickingWhen = false; setSched({ timingId: x.id, ...timesOf(x) }); },
    },
    el('span', { class: 'grow' }, el('strong', { text: x.name }), el('span', { class: 'muted small', text: timingSummary(x) })),
    el('span', { class: 'check', text: x.id === s.timingId ? '✓' : '' }))),
    el('button', { class: 'pick-option new', onclick: () => {
      if (JSON.stringify(sched.s) !== sched.start && !confirm('Leave this screen without saving?')) return;
      openTiming(null, { thenUseFor: sched.g });
    } }, el('span', { class: 'grow' }, el('strong', { text: '+ New schedule' }), el('span', { class: 'muted small', text: 'Saved to the Library' }))));
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

// A library schedule: save it, and every group using it follows.
async function saveTiming() {
  const { s } = sched;
  const name = s.name.trim();
  if (!name) { $('#sched-name').focus(); showActivity('Give the schedule a name.', 'err'); return; }
  const btn = $('#sched-save');
  btn.disabled = true;
  try {
    const res = await server('PUT', `timings/${house.key}/${s.id}`, { timing: { name, ...timesOf(s) } });
    timings[res.timing.id] = res.timing;
    for (const x of res.schedules || []) upsertSchedule(x);
    const n = res.schedules?.length || 0;
    showActivity(`✓ Saved “${res.timing.name}”${n ? ` · ${n} group${n === 1 ? '' : 's'} updated` : ''}`, 'ok');
    if (sched.thenUseFor) {
      // Made from a group's card: go straight on to add it to that group.
      const g = sched.thenUseFor;
      sched = null;
      return openSchedule(g, null, { timingId: res.timing.id });
    }
    sched.s = { ...sched.s, ...clone(res.timing) };
    sched.isNew = false;
    sched.start = JSON.stringify(sched.s);
    renderSchedule();
  } catch (e) {
    showActivity(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function saveSchedule() {
  if (sched.mode === 'timing') return saveTiming();
  const { g, s } = sched;
  if (!s.location) { alert('Add the house location first, so the app knows when sunset is.'); return; }
  if (!s.timingId) { showActivity('Choose a schedule first.', 'err'); return; }
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

// ----- Sending a pattern to another house -----
// The other house gets it in "Shared with you" and keeps its own copy.

function openSendDialog(pt) {
  const others = allHouses.filter(h => h.key !== house?.key);
  const dlg = $('#send-dialog');
  $('#send-title').textContent = `Send “${pt.name}”`;
  $('#send-houses').replaceChildren(...(others.length ? others.map(h => el('button', {
    class: 'house-item',
    onclick: async () => {
      dlg.close();
      try {
        await server('POST', `shares/${h.key}`, { from: house.key, pattern: pt });
        showActivity(`✓ Sent to ${h.name}. They’ll find it in their Library.`, 'ok');
      } catch (e) { showActivity(e.message, 'err'); }
    },
  }, el('span', { text: h.name }), el('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))) : [el('p', { class: 'muted small', text: 'There are no other houses set up yet.' })]));
  $('#send-link').onclick = () => { dlg.close(); sharePattern(pt); };
  dlg.showModal();
}

function sharedSub(item) {
  const days = Math.floor((Date.now() - item.at) / 86400000);
  return `From ${item.fromName} · ${item.fromHouse}${days ? ` · ${days === 1 ? 'yesterday' : `${days} days ago`}` : ''}`;
}

function sharedRow(item) {
  const pg = previewGroup();
  const cells = pg ? patternCells(item.pattern, pg.id, Math.min(positions(pg.lights, pg.id).length, 60)) : P.patternCells(item.pattern, {}, 40);
  return el('div', { class: 'lib-row shared' },
    el('div', { class: 'lib-play static' },
      previewStrip(cells, 30, isSmooth(item.pattern)),
      el('span', { class: 'grow' }, el('strong', { text: item.pattern.name }), el('span', { class: 'muted small', text: sharedSub(item) }))),
    el('div', { class: 'shared-actions' },
      el('button', { class: 'pill', onclick: () => declineShared(item) }, 'Decline'),
      el('button', { class: 'pill primary', onclick: () => acceptShared(item) }, 'Add')));
}

function inboxBanner() {
  const item = inbox[0];
  const more = inbox.length - 1;
  const pg = previewGroup();
  const cells = pg ? patternCells(item.pattern, pg.id, Math.min(positions(pg.lights, pg.id).length, 60)) : null;
  return el('div', { class: 'inbox-banner', role: 'status' },
    el('div', { class: 'inbox-top' },
      previewStrip(cells, 30),
      el('div', { class: 'grow' },
        el('strong', { text: `${item.fromName} sent you “${item.pattern.name}”` }),
        el('span', { class: 'muted small', text: more ? `From ${item.fromHouse} · and ${more} more in the Library` : `From ${item.fromHouse}. Add it to your Library?` }))),
    el('div', { class: 'inbox-actions' },
      el('button', { onclick: () => declineShared(item) }, 'Not now'),
      el('button', { class: 'primary', onclick: () => acceptShared(item) }, 'Add to Library')));
}

async function acceptShared(item) {
  const taken = new Set(saved.map(p => p.name));
  const name = taken.has(item.pattern.name) ? `${item.pattern.name} (from ${item.fromName})`.slice(0, 40) : item.pattern.name;
  // Its own copy: changes here don't affect the sender's, and theirs don't reach here.
  saved.push({ ...clone(item.pattern), name, id: `p-${Date.now().toString(36)}`, effect: legacyEffect(normalizeMotion(item.pattern.motion)) });
  saveLibrary();
  flushSync(`prefs/library/${house.key}`);
  await removeShared(item);
  showActivity(`✓ Added “${name}” to the Library`, 'ok');
}

async function declineShared(item) {
  await removeShared(item);
  showActivity(`Declined “${item.pattern.name}”`, 'ok');
}

async function removeShared(item) {
  inbox = inbox.filter(x => x.id !== item.id);
  rerender();
  $('#tab-library').classList.toggle('badged', inbox.length > 0);
  try { await server('DELETE', `inbox/${house.key}/${item.id}`); } catch (e) { showActivity(e.message, 'err'); }
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
    if (!confirm(`Add the shared pattern “${d.n}” to the ${house?.name || 'house'} library?`)) return;
    saved.push({ id: `p-${Date.now().toString(36)}`, name: d.n.slice(0, 40), loop: d.l, cells: d.c, effect: legacyEffect(normalizeMotion(d.e, d.m || {})), motion: normalizeMotion(d.e, d.m || {}) });
    saveLibrary();
    showActivity(`✓ Added “${d.n}” to the library`, 'ok');
  } catch {
    showActivity('That pattern link looks broken.', 'err');
  }
}

// ---------- Screens and loading ----------

function show(screen) {
  for (const s of ['auth', 'main', 'library', 'group', 'maker', 'grad', 'sched']) $(`#${s}`).hidden = screen !== s;
  // The tab bar sits under the two top-level places: Home and the Library.
  const tabs = screen === 'main' || (screen === 'library' && libView?.mode === 'browse');
  $('#tabbar').hidden = !tabs;
  document.body.classList.toggle('has-tabbar', tabs);
  $('#tab-library').classList.toggle('badged', inbox.length > 0);
  for (const [id, here] of [['#tab-home', screen === 'main'], ['#tab-library', screen === 'library']]) {
    if (here) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
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
  allHouses = data.allHouses || data.houses;
  try {
    const p = await server('GET', 'prefs/user');
    personal = p.prefs || {};
    collapsedGroups = personal.collapsed && typeof personal.collapsed === 'object' ? personal.collapsed : {};
  } catch { personal = {}; }
  if (!houses.length) {
    return showAuth('notready', me.admin
      ? 'No houses are set up yet. Add a LIFX_TOKEN_… environment variable in Vercel, then redeploy.'
      : 'You don’t have access to any houses yet. Ask the family admin.');
  }
  const last = local.get('active');
  await setActive(houses.find(h => h.key === last) || houses[0]);
  importFromHash();
}

// A house's library. The first time a library is opened, it starts with the
// patterns and colors this person saved before libraries existed (once only).
function loadLibrary(lib) {
  hiddenIds = new Set(Array.isArray(lib?.hidden) ? lib.hidden : []);
  if (Array.isArray(lib?.patterns)) {
    saved = lib.patterns;
    favColors = Array.isArray(lib.colors) ? lib.colors : defaultFavorites();
    return;
  }
  const mine = !personal.migrated;
  saved = mine && Array.isArray(personal.patterns) ? structuredClone(personal.patterns) : [];
  favColors = mine && Array.isArray(personal.colors) ? structuredClone(personal.colors) : defaultFavorites();
  saveLibrary();
  if (mine && (personal.patterns?.length || personal.colors)) {
    personal = { ...personal, migrated: true };
    saveUserPrefs();
  }
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
  libView = null;
  groupScreen = null;
  groupPrefs = {};
  houseLocation = null;
  saved = [];
  favColors = defaultFavorites();
  timings = {};
  show('main');
  $('#status').textContent = '';
  $('#house-name').textContent = h.name;
  $('#groups').replaceChildren();
  schedules = {};
  try {
    const [p, sc, lib, box] = await Promise.all([
      server('GET', `prefs/house/${h.key}`),
      server('GET', `schedules/${h.key}`),
      server('GET', `prefs/library/${h.key}`),
      server('GET', `inbox/${h.key}`).catch(() => ({ items: [] })),
    ]);
    if (house !== h) return; // switched again meanwhile
    groupPrefs = p.prefs.groups || {};
    houseLocation = p.prefs.location || null;
    loadLibrary(lib.prefs);
    inbox = box.items || [];
    $('#tab-library').classList.toggle('badged', inbox.length > 0);
    schedules = {};
    for (const x of sc.schedules) upsertSchedule(x);
    timings = Object.fromEntries((sc.timings || []).map(t => [t.id, t]));
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
  $('#this-house').hidden = demo;
  $('#house-loc-text').textContent = locationText(houseLocation);
  $('#house-loc-btn').textContent = houseLocation ? 'Update' : 'Set';
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
$('#library-back').addEventListener('click', () => { libView = null; show('main'); renderMain(); });
document.querySelectorAll('#library-seg button').forEach(b => b.addEventListener('click', () => {
  libView.seg = b.dataset.seg;
  libView.editColors = false;
  renderLibrary();
}));
$('#tab-home').addEventListener('click', () => { libView = null; show('main'); renderMain(); window.scrollTo(0, 0); });
$('#tab-library').addEventListener('click', () => openLibraryTab());
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
  saveLibrary();
  maker.editingId = pt.id;
  maker.savedState = editState();
  renderMaker();
  const using = schedulesUsing(pt.id);
  showActivity(using.length
    ? `✓ Saved “${pt.name}” · your ${using.map(s => s.groupName).join(' & ')} schedule uses the new version`
    : `✓ Saved “${pt.name}” — it’s in your Patterns`, 'ok');
  if (using.length) { flushSync('prefs/user'); refreshSchedulesUsing(pt.id); }
});
$('#maker-share').addEventListener('click', () => openSendDialog(makerPattern()));
$('#send-cancel').addEventListener('click', () => $('#send-dialog').close());
$('#maker-delete').addEventListener('click', () => {
  const pt = saved.find(p => p.id === maker.editingId);
  const using = schedulesUsing(pt?.id);
  const warning = using.length
    ? `\n\nYour ${using.map(s => s.groupName).join(' & ')} schedule uses it. It will keep using the colors it has now until you pick another pattern for it.`
    : '';
  if (!pt || !confirm(`Delete the pattern “${pt.name}”?${warning}`)) return;
  saved = saved.filter(p => p.id !== pt.id);
  saveLibrary();
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
// The house's location (for sunset), asked for once and kept with the house.
function useMyLocation(btn, done) {
  if (!navigator.geolocation) return alert('This browser can’t share its location.');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    btn.disabled = false;
    houseLocation = {
      lat: Math.round(pos.coords.latitude * 100) / 100,
      lon: Math.round(pos.coords.longitude * 100) / 100,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    saveGroupPrefs();
    updateScheduleLocations();
    done(houseLocation);
  }, err => {
    btn.disabled = false;
    alert(err.code === 1
      ? 'Location is turned off for this app. Allow it in Settings › Privacy & Security › Location Services › Safari Websites, then try again.'
      : 'Couldn’t get your location. Please try again.');
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
}

// Schedules keep a copy of the house location (the server runs them); bring them up to date.
async function updateScheduleLocations() {
  for (const s of allSchedules()) {
    if (JSON.stringify(s.location) === JSON.stringify(houseLocation)) continue;
    try { upsertSchedule((await server('PUT', `schedules/${house.key}/${s.id}`, { schedule: { ...s, location: houseLocation } })).schedule); } catch { /* next save fixes it */ }
  }
}

const locationText = loc => (loc ? `Sunset times for ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)} (${loc.tz.replace(/_/g, ' ')})` : 'Not set yet. Needed to work out sunset.');

$('#loc-btn').addEventListener('click', () => useMyLocation($('#loc-btn'), location => setSched({ location })));
$('#house-loc-btn').addEventListener('click', () => useMyLocation($('#house-loc-btn'), () => { $('#house-loc-text').textContent = locationText(houseLocation); }));
$('#skip-btn').addEventListener('click', async () => {
  const s = sched.s;
  const today = core.ymd(core.zonedParts(new Date(), s.location.tz));
  s.skipDates = s.skipDates.includes(today) ? s.skipDates.filter(d => d !== today) : [...s.skipDates, today];
  await saveSchedule();
});
$('#sched-delete').addEventListener('click', async () => {
  const { s, mode, g } = sched;
  if (mode === 'timing') {
    const used = groupsUsing(s.id);
    if (!confirm(`Delete “${s.name}” from the Library?${used.length ? ` It will also stop on ${used.join(', ')}.` : ''}`)) return;
    try {
      const res = await server('DELETE', `timings/${house.key}/${s.id}`);
      delete timings[s.id];
      for (const id of res.removed || []) removeSchedule(allSchedules().find(x => x.id === id));
      showActivity(`Deleted “${s.name}”`, 'ok');
      closeSchedule(true);
    } catch (e) { showActivity(e.message, 'err'); }
    return;
  }
  if (!confirm(`Remove this schedule from ${g.name}? It stays in the Library for other groups.`)) return;
  try {
    await server('DELETE', `schedules/${house.key}/${s.id}`);
    removeSchedule(s);
    showActivity(`Removed from ${g.name}`, 'ok');
    closeSchedule(true);
  } catch (e) { showActivity(e.message, 'err'); }
});
$('#sched-name').addEventListener('input', e => { sched.s.name = e.target.value.slice(0, 40); renderSchedule(); });
$('#sched-when').addEventListener('click', () => { sched.pickingWhen = !sched.pickingWhen; renderWhenPicker(); });
$('#sched-edit-times').addEventListener('click', () => {
  const t = timings[sched.s.timingId];
  if (!t) return;
  if (JSON.stringify(sched.s) !== sched.start && !confirm('Leave this screen without saving?')) return;
  const back = { g: sched.g, id: sched.isNew ? null : sched.s.id };
  openTiming(t);
  sched.returnToUse = back;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushSync(); return; }
  if ((house || demo) && !$('#main').hidden) refresh('Checking for changes');
});
window.addEventListener('pagehide', () => flushSync());

// ---------- Gradient editor ----------
// A gradient is a flow of color: stops along a bar, repeated (mirrored or
// restarting) around the house. You shape the flow; the lights follow. It's
// saved as a pattern like any other, so it works everywhere patterns do.

let grad = null; // { gid, n, name, editingId, stops, repeat, style, blend, motion, sel, from, start, sent }

const isGradient = pt => pt?.layout === 'gradient';
const gradState = (m = grad) => JSON.stringify({ name: m.name, stops: m.stops, repeat: m.repeat, style: m.style, blend: m.blend, motion: m.motion });
const gradDirty = () => !!grad && gradState() !== grad.start;

function openGradient(gid, pattern, opts = {}) {
  const g = groupById(gid);
  if (!g) return;
  const mine = !!pattern && isSavedId(pattern.id) && !opts.copy;
  const base = P.gradientSettings(pattern || P.builtinById('b-g-aurora'));
  grad = {
    gid, n: positions(g.lights, gid).length,
    name: mine ? pattern.name : pattern ? `${pattern.name.replace(/^\p{Extended_Pictographic}️?\s*/u, '')} (mine)`.slice(0, 40) : '',
    editingId: mine ? pattern.id : null,
    ...clone(base),
    motion: pattern ? patternMotion(pattern) : normalizeMotion('none'),
    sel: 0,
    from: opts.from || 'library',
    sent: null,
  };
  grad.start = mine ? gradState() : '';
  show('grad');
  window.scrollTo(0, 0);
  renderGradient();
}

function gradPattern() {
  const stops = grad.stops.map(s => ({ c: s.c, b: s.b, pos: Math.round(s.pos * 1000) / 1000 }));
  return {
    id: grad.editingId || `p-${Date.now().toString(36)}`,
    name: (grad.name || 'My gradient').slice(0, 40),
    layout: 'gradient', stops, repeat: grad.repeat, style: grad.style, blend: grad.blend,
    loop: stops.map(({ c, b }) => ({ c, b })),
    motion: clone(grad.motion), effect: legacyEffect(grad.motion),
  };
}

const stopCss = s => colorCss(s.c);

function renderGradient() {
  const m = grad;
  const g = groupById(m.gid);
  $('#grad-title').textContent = m.name || 'New gradient';
  $('#grad-title').classList.toggle('placeholder', !m.name);
  $('#grad-sub').textContent = `${g.name} · ${m.n} lights`;
  const dirty = gradDirty();
  $('#grad-save').textContent = m.editingId && !dirty ? 'Saved ✓' : 'Save';
  $('#grad-save').classList.toggle('primary', dirty || !m.editingId);
  renderGradientBar();
  renderGradientStop();
  renderGradientHouse();
  $('#grad-rep').textContent = m.repeat;
  $('#grad-rep-minus').disabled = m.repeat <= 1;
  $('#grad-rep-plus').disabled = m.repeat >= 8;
  document.querySelectorAll('#grad-style button').forEach(b => b.classList.toggle('active', b.dataset.v === m.style));
  document.querySelectorAll('#grad-blend button').forEach(b => b.classList.toggle('active', b.dataset.v === m.blend));
  const each = Math.max(1, Math.round(m.n / m.repeat / (m.style === 'mirror' ? 2 : 1)));
  $('#grad-flow-note').textContent = m.style === 'mirror'
    ? `Flows there and back ${m.repeat === 1 ? 'once' : `${m.repeat} times`} around the house, about ${each} lights each way.`
    : `Runs ${m.repeat === 1 ? 'once' : `${m.repeat} times`} around the house, about ${each} lights each time.`;
  document.querySelectorAll('#grad-motion button').forEach(b => b.classList.toggle('active', b.dataset.v === m.motion.type));
  $('#grad-motion-extra').hidden = m.motion.type === 'none';
  $('#grad-dir').hidden = m.motion.type !== 'chase';
  $('#grad-dir').textContent = m.motion.dir === 'backward' ? '← Back' : 'Forward →';
  $('#grad-speed').value = Math.round(m.motion.speed * 100);
  $('#grad-presets').replaceChildren(...BUILTIN.filter(isGradient).map(pt => el('button', {
    class: 'preset', onclick: () => {
      if (gradDirty() && grad.editingId && !confirm(`Replace the colors of “${grad.name}” with ${pt.name}?`)) return;
      Object.assign(grad, clone(P.gradientSettings(pt)), { sel: 0 });
      renderGradient();
    },
  }, el('span', { class: 'preset-bar', style: `background:${gradientCss(pt)}` }), el('span', { class: 'preset-name', text: pt.name }))));
  $('#grad-share').hidden = !m.editingId;
  $('#grad-delete').hidden = !m.editingId;
  const upToDate = m.sent === JSON.stringify(gradPattern().stops) + gradState();
  $('#grad-preview').textContent = upToDate ? '✓ On house' : '💡 Show on house';
  $('#grad-preview').classList.toggle('primary', !upToDate);
  $('#grad-preview').classList.toggle('done', upToDate);
}

// One run of the gradient (stop to stop) as a CSS gradient, sampled finely so
// the screen shows the same perceptual blend the lights get.
function gradientCss(pt, samples = 48) {
  const g = P.gradientSettings(pt);
  const cols = [];
  for (let i = 0; i <= samples; i++) {
    const x = P.gradientAt(g, i / samples);
    cols.push(`${cellCss(x)} ${((i / samples) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${cols.join(', ')})`;
}

function renderGradientBar() {
  const m = grad;
  $('#grad-fill').style.background = gradientCss(m);
  $('#grad-handles').replaceChildren(...m.stops.map((s, i) => el('button', {
    class: 'grad-handle' + (i === m.sel ? ' selected' : ''),
    style: `left:${(s.pos * 100).toFixed(2)}%;--c:${stopCss(s)}`,
    'aria-label': `Color ${i + 1} of ${m.stops.length}, ${colorName(s.c)}, at ${Math.round(s.pos * 100)}%`,
    'data-i': i,
  })));
}

const GRAD_LEVELS = [[1, '100%'], [0.6, '60%'], [0.3, '30%']];

function renderGradientStop() {
  const m = grad;
  const s = m.stops[m.sel];
  if (!s) { $('#grad-stop').replaceChildren(); return; }
  $('#grad-stop').replaceChildren(
    el('div', { class: 'grad-stop-head' },
      el('span', { class: 'grad-stop-dot', style: `background:${stopCss(s)}` }),
      el('span', { class: 'grow' }, el('strong', { text: colorName(s.c) }), el('span', { class: 'muted small', text: `Color ${m.sel + 1} of ${m.stops.length} · ${Math.round(s.pos * 100)}% along` })),
      m.stops.length > 2 && el('button', { class: 'link small danger-link', onclick: () => removeStop(m.sel) }, 'Remove')),
    el('div', { class: 'swatch-row' },
      ...favColors.map(f => sw(colorCss(f.c), f.name || colorName(f.c), () => setStop({ c: f.c }), { class: 'swatch-btn' + (s.c === f.c ? ' active' : '') })),
      el('button', {
        class: 'swatch-btn more-colors', 'aria-label': 'Pick any color',
        onclick: () => openColorSheet({ title: `Color ${m.sel + 1}`, initial: s.c, useLabel: 'Use this color', offerFavorite: true, onPick: c => setStop({ c }) }),
      }, el('span', { 'aria-hidden': 'true' }, '+'))),
    el('div', { class: 'sheet-row' },
      el('span', { class: 'muted small', text: 'Brightness' }),
      el('div', { class: 'levels' }, ...GRAD_LEVELS.map(([v, t]) => el('button', {
        class: Math.abs(s.b - v) < 0.05 ? 'active' : '', onclick: () => setStop({ b: v }),
      }, t)))));
}

function renderGradientHouse() {
  const m = grad;
  const g = groupById(m.gid);
  const cells = P.gradientCells(m, m.n);
  const pos = positions(g.lights, g.id);
  let i = 0;
  $('#grad-house').replaceChildren(...g.lights.map(l => {
    const len = pos.filter(p => p.light === l).length;
    const dots = [];
    for (let k = 0; k < len; k++, i++) {
      const x = cells[i];
      dots.push(el('span', { style: `--c:${cellCss(x)};opacity:${Math.max(0.35, Math.min(1, x.b * 1.4))}` }));
    }
    return el('div', { class: 'strip-row' },
      el('div', { class: 'muted small', text: `${l.label} · ${len} light${len === 1 ? '' : 's'}` }),
      el('div', { class: 'bulbs' }, dots));
  }));
}

function setStop(change) {
  Object.assign(grad.stops[grad.sel], change);
  renderGradient();
}

function removeStop(i) {
  if (grad.stops.length <= 2) return;
  grad.stops.splice(i, 1);
  grad.sel = Math.min(grad.sel, grad.stops.length - 1);
  renderGradient();
}

// Drag a stop along the bar; pull it down off the bar to remove it. Tap the
// bar to add a color there (the color the gradient already has at that spot).
(() => {
  const bar = $('#grad-bar');
  let drag = null;
  const posAt = x => { const r = $('#grad-fill').getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)); };
  bar.addEventListener('pointerdown', e => {
    if (!grad) return;
    const handle = e.target.closest('.grad-handle');
    if (handle) {
      const i = +handle.dataset.i;
      grad.sel = i;
      drag = { i, x: e.clientX, y: e.clientY, moved: false, off: false };
      bar.setPointerCapture(e.pointerId);
      renderGradientBar();
      renderGradientStop();
      return;
    }
    const pos = posAt(e.clientX);
    const at = P.gradientAt(P.gradientSettings(grad), pos);
    grad.stops.push({ c: at.c, b: Math.max(0.3, Math.min(1, at.b)), pos });
    grad.stops.sort((a, b) => a.pos - b.pos);
    grad.sel = grad.stops.findIndex(s => s.pos === pos);
    renderGradient();
  });
  let frame = 0;
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    drag.off = grad.stops.length > 2 && e.clientY - drag.y > 56;
    const s = grad.stops[drag.i];
    s.pos = posAt(e.clientX);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Keep the list in order while dragging, and follow the dragged stop.
      const moving = grad.stops[drag.i];
      grad.stops.sort((a, b) => a.pos - b.pos);
      drag.i = grad.stops.indexOf(moving);
      grad.sel = drag.i;
      renderGradientBar();
      bar.querySelector(`.grad-handle[data-i="${drag.i}"]`)?.classList.toggle('removing', drag.off);
      $('#grad-fill').style.background = gradientCss(grad);
      renderGradientHouse();
    });
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.off) removeStop(d.i); else renderGradient();
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
})();

function closeGradient(force = false) {
  if (!force && gradDirty() && !confirm('Leave without saving? Your changes to this gradient will be lost.')) return;
  const back = grad?.from === 'library' && libView ? 'library' : 'main';
  grad = null;
  show(back);
  rerender();
}

function saveGradient() {
  if (!grad.name) {
    const name = prompt('Name this gradient', '')?.trim();
    if (!name) return;
    grad.name = name.slice(0, 40);
  }
  const pt = gradPattern();
  const i = saved.findIndex(p => p.id === pt.id);
  if (i >= 0) saved[i] = pt; else saved.push(pt);
  saveLibrary();
  grad.editingId = pt.id;
  grad.start = gradState();
  renderGradient();
  const using = schedulesUsing(pt.id);
  showActivity(using.length
    ? `✓ Saved “${pt.name}” · ${using.map(s => s.groupName).join(' & ')} schedule${using.length === 1 ? '' : 's'} use the new version`
    : `✓ Saved “${pt.name}” to the Library`, 'ok');
  if (using.length) { flushSync(`prefs/library/${house.key}`); refreshSchedulesUsing(pt.id); }
}

$('#grad-back').addEventListener('click', () => closeGradient());
$('#grad-save').addEventListener('click', saveGradient);
$('#grad-rename').addEventListener('click', () => {
  const name = prompt('Name this gradient', grad.name)?.trim();
  if (name) { grad.name = name.slice(0, 40); renderGradient(); }
});
$('#grad-rep-minus').addEventListener('click', () => { grad.repeat = Math.max(1, grad.repeat - 1); renderGradient(); });
$('#grad-rep-plus').addEventListener('click', () => { grad.repeat = Math.min(8, grad.repeat + 1); renderGradient(); });
document.querySelectorAll('#grad-style button').forEach(b => b.addEventListener('click', () => { grad.style = b.dataset.v; renderGradient(); }));
document.querySelectorAll('#grad-blend button').forEach(b => b.addEventListener('click', () => { grad.blend = b.dataset.v; renderGradient(); }));
document.querySelectorAll('#grad-motion button').forEach(b => b.addEventListener('click', () => { grad.motion = { ...grad.motion, type: b.dataset.v }; renderGradient(); }));
$('#grad-dir').addEventListener('click', () => { grad.motion = { ...grad.motion, dir: grad.motion.dir === 'backward' ? 'forward' : 'backward' }; renderGradient(); });
$('#grad-speed').addEventListener('change', e => { grad.motion = { ...grad.motion, speed: e.target.value / 100 }; renderGradient(); });
$('#grad-preview').addEventListener('click', () => {
  const m = grad;
  const g = groupById(m.gid);
  const pt = gradPattern();
  const key = JSON.stringify(pt.stops) + gradState();
  run(`Show on house · ${g.name}`, async () => {
    await paintGroup(g, P.gradientCells(m, m.n), m.motion, m.editingId && !gradDirty() ? { name: pt.name, id: pt.id } : { name: m.name ? `${m.name} (edited)` : 'New gradient' });
    m.sent = key;
  }).then(() => { if (grad === m) renderGradient(); });
});
$('#grad-share').addEventListener('click', () => openSendDialog(gradPattern()));
$('#grad-delete').addEventListener('click', () => {
  const pt = saved.find(p => p.id === grad.editingId);
  if (!pt) return;
  const using = schedulesUsing(pt.id);
  const warning = using.length ? `\n\nYour ${using.map(s => s.groupName).join(' & ')} schedule uses it. It will keep using the colors it has now until you pick another pattern for it.` : '';
  if (!confirm(`Delete the gradient “${pt.name}”?${warning}`)) return;
  saved = saved.filter(p => p.id !== pt.id);
  saveLibrary();
  showActivity(`Deleted “${pt.name}”`, 'ok');
  closeGradient(true);
});
// Turn the gradient into a painted pattern, to change single lights.
$('#grad-convert').addEventListener('click', () => {
  if (!confirm('Make a painted copy of this gradient? You can then change single lights. The gradient itself stays as it is.')) return;
  const m = grad;
  const cells = P.gradientCells(m, m.n);
  const name = `${m.name || 'Gradient'} (painted)`.slice(0, 40);
  const from = m.from;
  grad = null;
  openMaker(m.gid, { name, loop: [cells[0]], cells, motion: m.motion }, { from, copy: true, keepCells: true });
});

// ----- New pattern: a gradient, or painted light by light -----
function newPattern(gid, from = 'library') {
  const dlg = $('#new-dialog');
  $('#new-gradient').onclick = () => { dlg.close(); openGradient(gid, null, { from }); };
  $('#new-painted').onclick = () => { dlg.close(); openMaker(gid, null, { from }); };
  dlg.showModal();
}
$('#new-cancel').addEventListener('click', () => $('#new-dialog').close());


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
