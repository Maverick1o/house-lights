/* House Lights — a tiny LIFX controller for one household.
 *
 * Each phone stores ONE LIFX token (its owner's). A token can only see the
 * lights on its own LIFX account, so one house can never affect another.
 * Nothing is sent anywhere except api.lifx.com.
 */
'use strict';

const API = 'https://api.lifx.com/v1';
const TOKEN_KEY = 'houselights.token';
const PREFS_KEY = 'houselights.prefs'; // per-light zone settings

// ---------- Colours and scenes ----------

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

// Patterns repeat their colours along a multizone strip.
// Lights without zones just get the first colour.
const PATTERNS = [
  { name: '✨ Warm bulbs',  colors: [C.Warm] },
  { name: '🎄 Christmas',   colors: [C.Red, C.Green] },
  { name: '🎃 Halloween',   colors: [C.Orange, C.Purple] },
  { name: '🇺🇸 July 4th',   colors: [C.Red, C.White, C.Blue] },
  { name: '❄️ Winter',      colors: [C.White, 'hue:200 saturation:0.6'] },
  { name: '💖 Valentine',   colors: [C.Red, C.Pink] },
  { name: '☘️ St Patrick',  colors: [C.Green, 'hue:100 saturation:0.5'] },
  { name: '🌈 Rainbow',     rainbow: true },
];

const SCENES = [
  { name: '🏠 Warm white',  state: { power: 'on', color: C.Warm, brightness: 0.8 } },
  { name: '💡 Bright white', state: { power: 'on', color: C.White, brightness: 1 } },
  { name: '🌙 Dim',          state: { power: 'on', color: C.Warm, brightness: 0.2 } },
  ...PATTERNS.map(p => ({ name: p.name, pattern: p })),
];

// ---------- State ----------

let token = localStorage.getItem(TOKEN_KEY);
let demo = false;
let lights = [];
let prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');

const $ = sel => document.querySelector(sel);

// ---------- API ----------

async function api(method, path, body) {
  if (demo) return mockApi(method, path, body);
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach LIFX. Check your internet connection.');
  }
  if (res.status === 401) {
    const err = new Error('LIFX did not accept this token.');
    err.unauthorized = true;
    throw err;
  }
  if (res.status === 429) throw new Error('Too many changes at once — wait a few seconds and try again.');
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.error || data.errors?.[0]?.message)) || `LIFX error ${res.status}`);

  // 207 Multi-Status: report lights that didn't respond.
  const results = data?.results?.flatMap(r => r.results || [r]) || [];
  const failed = results.filter(r => r.status && r.status !== 'ok');
  for (const f of failed) {
    activity.failed.add(`${f.label || 'A light'} (${f.status.replace('_', ' ')})`);
  }
  return data;
}

const sel = s => encodeURIComponent(s);
const setState = (selector, state) => api('PUT', `/lights/${sel(selector)}/state`, { duration: 0.5, ...state });

// ---------- Activity bar ----------
// A bar at the top that says what the app is doing right now, so a slow
// response never looks like nothing happened.

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

// Progress message for the action in progress.
function step(text) {
  if (activity.busy) showActivity(`${activity.busy} — ${text}`);
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- Commands ----------

// Run one action at a time. While it runs, the bar shows progress and the
// controls are locked so repeated taps don't queue up duplicate commands.
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
    await wait(demo ? 300 : 700); // let the fade finish before reading back
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

function zoneCount(light) {
  return light.zones?.count || prefs[light.id]?.zones || 32;
}
function segmentSize(light) {
  // On LIFX Permanent Outdoor one zone is one light, so default to
  // alternating light-by-light.
  return prefs[light.id]?.segment || 1;
}
// 'none' | 'off' | 'dim' — what goes between coloured segments.
function gapMode(light) {
  return prefs[light.id]?.gaps || 'none';
}
const GAP_BRIGHTNESS = { off: 0, dim: 0.02 };

// Build zone-range states that paint a pattern along a strip.
// With gaps on, every other segment is turned off or barely lit,
// e.g. red, off, green, off, …
function patternStates(light, pattern) {
  const n = zoneCount(light);
  const seg = segmentSize(light);
  const gaps = gapMode(light);
  const chunks = Math.ceil(n / seg);
  const colorChunks = gaps === 'none' ? chunks : Math.ceil(chunks / 2);
  const states = [];
  let color;
  for (let i = 0; i < chunks; i++) {
    const from = i * seg;
    const selector = `id:${light.id}|${from}-${Math.min(n - 1, from + seg - 1)}`;
    if (gaps !== 'none' && i % 2 === 1) {
      // Keep the neighbour's colour so a dim gap glows the same hue.
      states.push({ selector, color, brightness: GAP_BRIGHTNESS[gaps] });
      continue;
    }
    const k = gaps === 'none' ? i : i / 2;
    color = pattern.rainbow
      ? `hue:${Math.round((360 * k) / colorChunks)} saturation:1`
      : pattern.colors[k % pattern.colors.length];
    states.push({ selector, color });
  }
  return states;
}

async function applyPattern(light, pattern, prefix = '') {
  if (!isMultizone(light)) {
    return setState(`id:${light.id}`, {
      power: 'on',
      color: pattern.rainbow ? 'hue:0 saturation:1' : pattern.colors[0],
    });
  }
  step(`${prefix}stopping any animation…`);
  await api('POST', `/lights/${sel(`id:${light.id}`)}/effects/off`, {});
  // The LIFX API accepts at most 50 states per request, so long strips are
  // painted in several batches.
  const states = patternStates(light, pattern);
  const defaults = { power: 'on', duration: 0.5, brightness: Math.max(light.brightness || 0, 0.6) };
  const parts = Math.ceil(states.length / MAX_STATES);
  for (let i = 0; i < states.length; i += MAX_STATES) {
    const part = i / MAX_STATES + 1;
    step(`${prefix}painting ${zoneCount(light)} lights${parts > 1 ? ` (part ${part} of ${parts})` : ''}…`);
    await api('PUT', '/lights/states', { states: states.slice(i, i + MAX_STATES), defaults });
  }
}
const MAX_STATES = 50;

async function applyScene(scene) {
  if (scene.state) return setState('all', scene.state);
  const targets = lights.filter(l => l.connected);
  for (const [i, light] of targets.entries()) {
    const prefix = `${light.label} (${i + 1} of ${targets.length}): `;
    step(`${prefix}starting…`);
    await applyPattern(light, scene.pattern, prefix);
  }
}

// ---------- Rendering ----------

const isMultizone = l => !!l.product?.capabilities?.has_multizone;
const hasColor = l => l.product?.capabilities?.has_color !== false;

function cssColor(light) {
  const { hue = 0, saturation = 0, kelvin = 3500 } = light.color || {};
  if (saturation < 0.05) return kelvin < 3200 ? '#ffd7a0' : '#f4f6ff';
  return `hsl(${hue}, ${Math.round(saturation * 100)}%, 55%)`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'style') node.style.cssText = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function renderScenes() {
  const box = $('#scenes');
  box.replaceChildren(...SCENES.map(s =>
    el('button', { onclick: () => run(`${s.name} · whole house`, () => applyScene(s)) }, s.name)));
}

function renderLights() {
  const names = [...new Set(lights.map(l => l.location?.name).filter(Boolean))];
  $('#house-name').textContent = names.length === 1 ? names[0] : names.length ? names.join(' + ') : 'My House';
  $('#status').textContent = (demo ? 'Demo mode · ' : '') +
    `${lights.length} light${lights.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('#empty').hidden = lights.length > 0;
  // Keep "Pattern settings" open across refreshes.
  const open = new Set([...document.querySelectorAll('details[open]')].map(d => d.dataset.id));
  $('#lights').replaceChildren(...lights.map(lightCard));
  document.querySelectorAll('details').forEach(d => { if (open.has(d.dataset.id)) d.open = true; });
}

function lightCard(light) {
  const on = light.power === 'on';
  const id = `id:${light.id}`;

  const toggle = el('input', {
    type: 'checkbox', checked: on, disabled: !light.connected,
    onchange: e => run(`${light.label} ${e.target.checked ? 'on' : 'off'}`, () => setState(id, { power: e.target.checked ? 'on' : 'off' })),
  });

  const brightness = el('input', {
    type: 'range', min: 1, max: 100, value: Math.round((light.brightness || 0) * 100),
    disabled: !light.connected, 'aria-label': 'Brightness',
    onchange: e => run(`${light.label} brightness ${e.target.value}%`, () => setState(id, { power: 'on', brightness: e.target.value / 100 })),
  });

  const head = el('div', { class: 'light-head' },
    el('span', { class: 'dot' + (on && light.connected ? '' : ' off'), style: `background:${cssColor(light)};color:${cssColor(light)}` }),
    el('div', { class: 'name' },
      el('strong', {}, light.label || 'Light'),
      el('span', { class: 'muted small' + (light.connected ? '' : ' offline') },
        light.connected ? `${light.group?.name || ''}${on ? '' : ' · off'}` : 'Offline')),
    el('label', { class: 'switch' }, toggle, el('span')));

  const card = el('div', { class: 'card' }, head);
  if (!light.connected) return card;

  card.append(brightness);

  const colors = hasColor(light) ? COLORS : COLORS.slice(0, 2);
  card.append(el('h3', {}, 'Colour'), el('div', { class: 'chips' },
    colors.map(c => el('button', {
      class: 'swatch-btn', title: c.name, 'aria-label': c.name, style: `background:${c.css}`,
      onclick: () => run(`${light.label} → ${c.name}`, () => setState(id, { power: 'on', color: c.api })),
    })),
    hasColor(light) && el('input', {
      type: 'color', 'aria-label': 'Custom colour', value: '#ff8800',
      onchange: e => run(`${light.label} → custom colour`, () => setState(id, { power: 'on', color: e.target.value })),
    })));

  if (isMultizone(light)) {
    card.append(el('h3', {}, 'Patterns'), el('div', { class: 'chips' },
      PATTERNS.map(p => el('button', { onclick: () => run(`${p.name} · ${light.label}`, () => applyPattern(light, p)) }, p.name)),
      el('button', {
        onclick: () => run(`Animate · ${light.label}`, () => api('POST', `/lights/${sel(id)}/effects/move`, { direction: 'forward', period: 2, power_on: true })),
      }, '▶︎ Animate'),
      el('button', {
        onclick: () => run(`Stop animation · ${light.label}`, () => api('POST', `/lights/${sel(id)}/effects/off`, {})),
      }, '■ Stop')));

    card.append(el('details', { 'data-id': light.id },
      el('summary', { class: 'muted small' }, 'Pattern settings'),
      el('div', { class: 'row', style: 'margin-top:8px' },
        !light.zones?.count && numberPref(light, 'zones', 'Zones on strip', zoneCount(light)),
        numberPref(light, 'segment', 'Zones per colour', segmentSize(light)),
        selectPref(light, 'gaps', 'Gaps between colours', gapMode(light), [
          ['none', 'None'], ['off', 'Off'], ['dim', 'Barely lit'],
        ]))));
  }
  return card;
}

function savePref(light, key, value) {
  prefs[light.id] = { ...prefs[light.id], [key]: value };
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function selectPref(light, key, label, value, options) {
  return el('label', { class: 'inline' }, label,
    el('select', { onchange: e => savePref(light, key, e.target.value) },
      options.map(([v, text]) => el('option', { value: v, selected: v === value }, text))));
}

function numberPref(light, key, label, value) {
  return el('label', { class: 'inline' }, label,
    el('input', {
      type: 'number', min: 1, max: 500, value, inputmode: 'numeric',
      onchange: e => {
        savePref(light, key, Math.max(1, parseInt(e.target.value, 10) || 1));
      },
    }));
}

// ---------- Screens ----------

function show(screen) {
  $('#setup').hidden = screen !== 'setup';
  $('#main').hidden = screen !== 'main';
}

async function loadLights() {
  lights = await api('GET', '/lights/all');
  lights.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  renderLights();
}

// Refresh from LIFX, showing it in the activity bar unless an action is running.
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
  if (e.unauthorized) {
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    $('#activity').hidden = true;
    show('setup');
    showSetupError('Your saved token no longer works. Please paste a new one.');
    return;
  }
  showActivity(`${label ? `${label} — ` : ''}${e.message}`, 'err');
}

function showSetupError(msg) {
  const p = $('#setup-error');
  p.textContent = msg;
  p.hidden = !msg;
}

async function start() {
  show('main');
  $('#status').textContent = '';
  await refresh('Loading your lights');
}

// ---------- Events ----------

$('#token-form').addEventListener('submit', async e => {
  e.preventDefault();
  const value = $('#token-input').value.trim();
  if (!value) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  showSetupError('');
  token = value;
  demo = false;
  try {
    await loadLights(); // validates the token
    localStorage.setItem(TOKEN_KEY, token);
    $('#token-input').value = '';
    show('main');
  } catch (err) {
    token = null;
    showSetupError(err.unauthorized ? 'That token didn’t work. Check you copied all of it.' : err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#demo-btn').addEventListener('click', () => { demo = true; start(); });

document.querySelectorAll('[data-all]').forEach(b =>
  b.addEventListener('click', () => run(`All lights ${b.dataset.all}`, () => setState('all', { power: b.dataset.all }))));

$('#settings-btn').addEventListener('click', () => {
  $('#settings-info').textContent = demo
    ? 'You are in demo mode. No real lights are being changed.'
    : `Connected to LIFX. Token ends in …${(token || '').slice(-4)}.`;
  $('#logout-btn').textContent = demo ? 'Leave demo mode' : 'Remove token from this phone';
  $('#settings').showModal();
});
$('#close-settings').addEventListener('click', () => $('#settings').close());
$('#refresh-btn').addEventListener('click', () => { $('#settings').close(); refresh(); });
$('#logout-btn').addEventListener('click', () => {
  if (!demo && !confirm('Remove your LIFX token from this phone?')) return;
  localStorage.removeItem(TOKEN_KEY);
  token = null;
  demo = false;
  lights = [];
  $('#settings').close();
  show('setup');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (token || demo) && !$('#main').hidden) refresh('Checking for changes');
});

// ---------- Demo mode (fake lights, no network) ----------

const demoLights = [
  { id: 'demo1', label: 'Front Roofline', power: 'on', brightness: 0.8, connected: true,
    color: { hue: 30, saturation: 0, kelvin: 2700 }, zones: { count: 40 },
    group: { name: 'Front' }, location: { name: 'Demo House' },
    product: { capabilities: { has_color: true, has_multizone: true } } },
  { id: 'demo2', label: 'Back Patio', power: 'off', brightness: 0.5, connected: true,
    color: { hue: 225, saturation: 1, kelvin: 3500 },
    group: { name: 'Back' }, location: { name: 'Demo House' },
    product: { capabilities: { has_color: true, has_multizone: true } } },
  { id: 'demo3', label: 'Garage Side', power: 'on', brightness: 1, connected: false,
    color: { hue: 0, saturation: 0, kelvin: 4000 },
    group: { name: 'Side' }, location: { name: 'Demo House' },
    product: { capabilities: { has_color: true, has_multizone: false } } },
];

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

function mockApply(selector, state) {
  const id = selector === 'all' ? null : selector.replace(/^id:/, '').split('|')[0];
  for (const l of demoLights) {
    if ((id && l.id !== id) || !l.connected) continue;
    if (state.power) l.power = state.power;
    if (state.brightness != null) l.brightness = state.brightness;
    if (state.color) l.color = { ...l.color, ...parseColor(state.color) };
  }
}

async function mockApi(method, path, body) {
  await new Promise(r => setTimeout(r, 150));
  if (method === 'GET') return structuredClone(demoLights);
  const m = path.match(/^\/lights\/([^/]+)\/state$/);
  if (m) mockApply(decodeURIComponent(m[1]), body);
  if (path === '/lights/states') {
    body.states.forEach((s, i) => i === 0 && mockApply(s.selector, { ...body.defaults, ...s }));
  }
  return { results: [] };
}

// ---------- Boot ----------

renderScenes();
if (token) start(); else show('setup');
