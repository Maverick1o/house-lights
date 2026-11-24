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
 */
'use strict';

const APP_VERSION = '2026.11.24-1';
const MAX_STATES = 50; // LIFX limit per /lights/states request

// ---------- Colours ----------

const COLORS = [
  { name: 'Warm',   api: 'kelvin:2700 saturation:0', css: '#ffd7a0' },
  { name: 'White',  api: 'kelvin:4000 saturation:0', css: '#f4f6ff' },
  { name: 'Red',    api: 'hue:0 saturation:1',       css: '#ff3b3b' },
  { name: 'Orange', api: 'hue:28 saturation:1',      css: '#ff8a1f' },
  { name: 'Yellow', api: 'hue:52 saturation:1',      css: '#ffe03b' },
  { name: 'Green',  api: 'hue:120 saturation:1',     css: '#3bdc5a' },
  { name: 'Blue',   api: 'hue:225 saturation:1',     css: '#3b6bff' },
  { name: 'Purple', api: 'hue:275 saturation:1',     css: '#a64bff' },
  { name: 'Pink',   api: 'hue:320 saturation:0.7',   css: '#ff6bcf' },
];
const C = Object.fromEntries(COLORS.map(c => [c.name, c.api]));

// A cell is one light's setting: colour + brightness (0 = off).
const cell = (c, b = 1) => ({ c, b });
const OFF = cell(C.Warm, 0);

const BUILTIN = [
  { id: 'b-warm',  name: '✨ Warm bulbs', loop: [cell(C.Warm)] },
  { id: 'b-xmas',  name: '🎄 Christmas',  loop: [cell(C.Red), cell(C.Green)] },
  { id: 'b-hallo', name: '🎃 Halloween',  loop: [cell(C.Orange), cell(C.Purple)] },
  { id: 'b-july',  name: '🇺🇸 July 4th',  loop: [cell(C.Red), cell(C.White), cell(C.Blue)] },
  { id: 'b-winter', name: '❄️ Winter',    loop: [cell(C.White), cell('hue:200 saturation:0.6')] },
  { id: 'b-valen', name: '💖 Valentine',  loop: [cell(C.Red), cell(C.Pink)] },
  { id: 'b-patty', name: '☘️ St Patrick', loop: [cell(C.Green), cell('hue:100 saturation:0.5')] },
  { id: 'b-rainbow', name: '🌈 Rainbow',  rainbow: true },
];

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

const isMultizone = l => !!l.product?.capabilities?.has_multizone;
const hasColor = l => l.product?.capabilities?.has_color !== false;
const stripLength = l => (isMultizone(l) ? l.zones?.count || 32 : 1);

function gp(gid) {
  groupPrefs[gid] ??= {};
  const p = groupPrefs[gid];
  p.order ??= [];
  p.reversed ??= {};
  p.width ??= 1;
  p.gaps ??= 'none';
  p.level ??= 1;
  return p;
}

// Groups with their lights in the saved order (new lights go at the end).
function getGroups() {
  const byId = new Map();
  for (const l of lights) {
    const id = l.group?.id || 'none';
    if (!byId.has(id)) byId.set(id, { id, name: l.group?.name || 'Lights', lights: [] });
    byId.get(id).lights.push(l);
  }
  for (const g of byId.values()) {
    const order = gp(g.id).order;
    const rank = l => { const i = order.indexOf(l.id); return i === -1 ? 1e6 : i; };
    g.lights.sort((a, b) => rank(a) - rank(b) || (a.label || '').localeCompare(b.label || ''));
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const groupById = gid => getGroups().find(g => g.id === gid);

// Every light position along the string, in order: [{ light, zone }].
function positions(stripLights, gid) {
  const rev = gp(gid).reversed;
  const out = [];
  for (const l of stripLights) {
    if (!isMultizone(l)) { out.push({ light: l, zone: null }); continue; }
    const n = stripLength(l);
    for (let i = 0; i < n; i++) out.push({ light: l, zone: rev[l.id] ? n - 1 - i : i });
  }
  return out;
}

const tile = (loop, n) => Array.from({ length: n }, (_, i) => ({ ...loop[i % loop.length] }));

// Built-in patterns honour the group's "lights per colour" and "gaps" options.
function builtinCells(pattern, gid, n) {
  const { width, gaps } = gp(gid);
  const gapB = gaps === 'dim' ? 0.02 : 0;
  const perBlock = gaps === 'none' ? 1 : 2;
  const colourBlocks = Math.ceil(n / width / perBlock);
  const out = [];
  for (let i = 0; i < n; i++) {
    const block = Math.floor(i / width);
    const isGap = gaps !== 'none' && block % 2 === 1;
    const k = Math.floor(block / perBlock);
    const c = pattern.rainbow
      ? `hue:${Math.round((360 * k) / colourBlocks)} saturation:1`
      : pattern.loop[k % pattern.loop.length].c;
    out.push(cell(c, isGap ? gapB : 1));
  }
  return out;
}

function patternCells(pattern, gid, n) {
  if (pattern.rainbow || pattern.id?.startsWith('b-')) return builtinCells(pattern, gid, n);
  if (pattern.cells?.length === n) return pattern.cells.map(x => ({ ...x }));
  return tile(pattern.loop, n);
}

const cellKey = (x, level) => `${x.c}|${scaled(x.b, level)}`;
const scaled = (b, level) => (b > 0 ? Math.max(0.01, Math.round(b * level * 1000) / 1000) : 0);

// Turn per-light cells into the fewest LIFX states (runs of equal zones merge).
function cellsToStates(pos, cells, level = 1) {
  const perLight = new Map();
  pos.forEach((p, i) => {
    if (!perLight.has(p.light.id)) perLight.set(p.light.id, { light: p.light, zones: [] });
    const entry = perLight.get(p.light.id);
    if (p.zone == null) entry.single = cells[i];
    else entry.zones[p.zone] = cells[i];
  });
  const states = [];
  for (const { light, zones, single } of perLight.values()) {
    if (single) {
      states.push({ selector: `id:${light.id}`, color: single.c, brightness: scaled(single.b, level) });
      continue;
    }
    let start = 0;
    for (let z = 1; z <= zones.length; z++) {
      if (z === zones.length || cellKey(zones[z], level) !== cellKey(zones[start], level)) {
        const x = zones[start];
        states.push({ selector: `id:${light.id}|${start}-${z - 1}`, color: x.c, brightness: scaled(x.b, level) });
        start = z;
      }
    }
  }
  return states;
}

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

// Paint cells along a set of strips, then optionally start an effect.
async function paint(selector, pos, cells, level, effect = 'none') {
  step('stopping any animation…');
  await effectsOff(selector);
  await sendStates(cellsToStates(pos, cells, level), `painting ${pos.length} lights`);
  if (effect === 'chase' || effect === 'chase-back') {
    step('starting chase…');
    await chase(selector, effect === 'chase' ? 'forward' : 'backward');
  }
}

// Apply cells to a whole group and remember them (so the brightness slider
// can rescale the pattern instead of flattening it).
async function paintGroup(g, cells, effect = 'none') {
  const p = gp(g.id);
  await paint(`group_id:${g.id}`, positions(g.lights, g.id), cells, p.level, effect);
  p.last = { cells, effect };
  saveGroupPrefs();
}

function applyToGroup(g, pattern) {
  const n = positions(g.lights, g.id).length;
  return paintGroup(g, patternCells(pattern, g.id, n), pattern.effect || 'none');
}

function applyToStrip(g, light, pattern) {
  const pos = positions([light], g.id);
  gp(g.id).last = null; // the group is now mixed
  saveGroupPrefs();
  return paint(`id:${light.id}`, pos, patternCells(pattern, g.id, pos.length), 1, pattern.effect || 'none');
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

  const brightnessValue = p.last ? Math.round(p.level * 100)
    : Math.round(Math.max(0, ...online.map(l => l.brightness || 0)) * 100);

  const solid = (c, label) => run(`${g.name} → ${label}`, () => paintGroup(g, tile([cell(c)], n)));

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
        if (p.last) {
          p.level = v;
          saveGroupPrefs();
          run(`${g.name} brightness ${e.target.value}%`, () => paintGroup(g, p.last.cells, p.last.effect));
        } else {
          run(`${g.name} brightness ${e.target.value}%`, () => setState(sel, { power: 'on', brightness: v }));
        }
      },
    }));

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
      ...BUILTIN.map(pt => el('button', { onclick: () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)) }, pt.name)),
      ...saved.map(pt => el('button', { class: 'saved', onclick: () => run(`${pt.name} · ${g.name}`, () => applyToGroup(g, pt)) }, `⭐ ${pt.name}`)),
    ]),
    el('button', { class: 'primary wide', style: 'margin-top:12px', onclick: () => openMaker(g.id) }, '✏️ Pattern maker'),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { onclick: () => run(`Chase · ${g.name}`, () => chase(sel)) }, '▶︎ Chase'),
      el('button', { onclick: () => run(`Stop · ${g.name}`, () => effectsOff(sel)) }, '■ Stop')));

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

const BRIGHTNESS = [[1, '100%'], [0.5, '50%'], [0.15, '15%'], [0.03, '3%']];
let maker = null;

function openMaker(gid, pattern) {
  const g = groupById(gid);
  const pos = positions(g.lights, gid);
  const loop = pattern?.loop?.map(x => ({ ...x })) || [cell(C.Red), cell(C.Green)];
  maker = {
    gid,
    n: pos.length,
    loop,
    cells: pattern ? patternCells(pattern, gid, pos.length) : tile(loop, pos.length),
    brush: cell(C.Red),
    effect: pattern?.effect || 'none',
    name: pattern && !pattern.id.startsWith('b-') ? pattern.name : '',
    editingId: pattern && !pattern.id.startsWith('b-') ? pattern.id : null,
  };
  if (pattern?.rainbow) maker.loop = maker.cells.slice(0, Math.min(12, maker.n));
  show('maker');
  renderMaker();
  window.scrollTo(0, 0);
}

function closeMaker() {
  maker = null;
  show('main');
  renderMain();
}

function renderMaker() {
  const g = groupById(maker.gid);
  const m = maker;
  $('#maker-title').textContent = `${g.name} · ${m.n} lights`;
  $('#maker-name').value = m.name;

  // Start-from menu
  const startFrom = $('#maker-start');
  startFrom.replaceChildren(
    el('option', { value: '', text: 'Start from…' }),
    el('option', { value: 'blank', text: 'Blank (all off)' }),
    el('optgroup', { label: 'Built-in' }, BUILTIN.map(p => el('option', { value: p.id, text: p.name }))),
    saved.length && el('optgroup', { label: 'Saved' }, saved.map(p => el('option', { value: p.id, text: p.name }))));

  // Brush colours
  $('#brush-colors').replaceChildren(
    ...COLORS.map(c => sw(c.css, c.name, () => setBrush(c.api), { class: 'swatch-btn' + (m.brush.c === c.api && m.brush.b > 0 ? ' active' : '') })),
    el('input', {
      type: 'color', class: 'custom-swatch' + (m.brush.c.startsWith('#') && m.brush.b > 0 ? ' active' : ''),
      title: 'Any colour', 'aria-label': 'Pick any colour',
      value: m.brush.c.startsWith('#') ? m.brush.c : '#ff8800', onchange: e => setBrush(e.target.value),
    }),
    el('button', { class: 'swatch-btn off-swatch' + (m.brush.b === 0 ? ' active' : ''), title: 'Off', 'aria-label': 'Off', onclick: () => { m.brush = { ...m.brush, b: 0 }; renderMaker(); } }, 'Off'));
  $('#brush-levels').replaceChildren(...BRIGHTNESS.map(([v, t]) =>
    el('button', { class: 'small' + (m.brush.b === v ? ' active' : ''), onclick: () => { m.brush = { ...m.brush, b: v }; renderMaker(); } }, t)));


  // Loop
  $('#loop-len').textContent = m.loop.length;
  $('#loop-grid').replaceChildren(...m.loop.map((x, i) => cellEl('loop', i, x, i + 1)));
  $('#repeat-btn').textContent = `Repeat loop across all ${m.n} lights ↓`;

  // Full string, split by strip
  const pos = positions(g.lights, g.id);
  const rows = [];
  let i = 0;
  for (const l of g.lights) {
    const len = pos.filter(p => p.light === l).length;
    const cells = [];
    for (let k = 0; k < len; k++, i++) cells.push(cellEl('full', i, m.cells[i], k + 1));
    rows.push(el('div', { class: 'strip-row' },
      el('div', { class: 'muted small', text: `${l.label} · ${len} light${len === 1 ? '' : 's'}${gp(g.id).reversed[l.id] ? ' (reversed)' : ''}` }),
      el('div', { class: 'grid full', 'data-kind': 'full' }, cells)));
  }
  $('#full-grid').replaceChildren(...rows);

  $('#maker-effect').value = m.effect;
  $('#maker-delete').hidden = !m.editingId;
  $('#maker-share').hidden = !m.editingId;
}

function cellEl(kind, i, x, label) {
  const node = el('div', { class: 'cell', 'data-kind': kind, 'data-i': i, title: `Light ${label}` });
  paintCellEl(node, x);
  return node;
}

function setBrush(c) {
  maker.brush = { c, b: maker.brush.b > 0 ? maker.brush.b : 1 };
  renderMaker();
}

// Tap or drag across cells to paint them with the brush.
let painting = false;
function paintAt(target) {
  const node = target?.closest?.('.cell[data-i]');
  if (!node || !maker) return;
  const list = node.dataset.kind === 'loop' ? maker.loop : maker.cells;
  const i = +node.dataset.i;
  list[i] = { ...maker.brush };
  paintCellEl(node, list[i]);
}
document.addEventListener('pointerdown', e => {
  if (!e.target.closest?.('#maker .cell')) return;
  painting = true;
  e.preventDefault();
  paintAt(e.target);
});
document.addEventListener('pointermove', e => {
  if (painting) paintAt(document.elementFromPoint(e.clientX, e.clientY));
});
['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, () => (painting = false)));

function makerPattern() {
  return {
    id: maker.editingId || `p-${Date.now().toString(36)}`,
    name: ($('#maker-name').value.trim() || 'My pattern').slice(0, 40),
    loop: maker.loop.map(x => ({ ...x })),
    cells: maker.cells.map(x => ({ ...x })),
    effect: maker.effect,
  };
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
  const data = { n: pt.name, l: pt.loop, ...(plain ? {} : { c: pt.cells }), e: pt.effect };
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
    saved.push({ id: `p-${Date.now().toString(36)}`, name: d.n.slice(0, 40), loop: d.l, cells: d.c, effect: ['chase', 'chase-back'].includes(d.e) ? d.e : 'none' });
    savePatterns();
    showActivity(`✓ Added “${d.n}” to your patterns`, 'ok');
  } catch {
    showActivity('That pattern link looks broken.', 'err');
  }
}

// ---------- Screens and loading ----------

function show(screen) {
  for (const s of ['auth', 'main', 'maker']) $(`#${s}`).hidden = screen !== s;
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
  try {
    const p = await server('GET', `prefs/house/${h.key}`);
    if (house !== h) return; // switched again meanwhile
    groupPrefs = p.prefs.groups || {};
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
$('#maker-back').addEventListener('click', closeMaker);
$('#maker-name').addEventListener('input', e => (maker.name = e.target.value));
$('#maker-start').addEventListener('change', e => {
  const v = e.target.value;
  if (!v) return;
  const name = maker.name;
  if (v === 'blank') {
    maker.loop = [{ ...OFF }, { ...OFF }];
    maker.cells = tile(maker.loop, maker.n);
  } else {
    const pt = [...BUILTIN, ...saved].find(p => p.id === v);
    const keepId = maker.editingId;
    openMaker(maker.gid, pt);
    if (pt.id.startsWith('b-')) { maker.editingId = keepId; maker.name = name; }
  }
  renderMaker();
});
$('#loop-minus').addEventListener('click', () => {
  if (maker.loop.length > 1) { maker.loop.pop(); renderMaker(); }
});
$('#loop-plus').addEventListener('click', () => {
  if (maker.loop.length < 24) { maker.loop.push({ ...OFF }); renderMaker(); }
});
$('#repeat-btn').addEventListener('click', () => {
  maker.cells = tile(maker.loop, maker.n);
  renderMaker();
  showActivity(`✓ Loop of ${maker.loop.length} repeated across ${maker.n} lights — tap “Preview on house” to see it`, 'ok');
});
$('#maker-effect').addEventListener('change', e => (maker.effect = e.target.value));
$('#maker-preview').addEventListener('click', () => {
  const g = groupById(maker.gid);
  const cells = maker.cells.map(x => ({ ...x }));
  run(`Preview · ${g.name}`, () => paintGroup(g, cells, maker.effect));
});
$('#maker-save').addEventListener('click', () => {
  const pt = makerPattern();
  const i = saved.findIndex(p => p.id === pt.id);
  if (i >= 0) saved[i] = pt; else saved.push(pt);
  savePatterns();
  maker.editingId = pt.id;
  maker.name = pt.name;
  renderMaker();
  showActivity(`✓ Saved “${pt.name}” — it’s now in your Patterns`, 'ok');
});
$('#maker-share').addEventListener('click', () => sharePattern(makerPattern()));
$('#maker-delete').addEventListener('click', () => {
  const pt = saved.find(p => p.id === maker.editingId);
  if (!pt || !confirm(`Delete the pattern “${pt.name}”?`)) return;
  saved = saved.filter(p => p.id !== pt.id);
  savePatterns();
  showActivity(`Deleted “${pt.name}”`, 'ok');
  closeMaker();
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
