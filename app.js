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
let refreshTimer = null;

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
  if (failed.length) {
    toast(`${failed.map(f => f.label || 'A light').join(', ')} didn't respond (${failed[0].status.replace('_', ' ')})`, true);
  }
  return data;
}

const sel = s => encodeURIComponent(s);
const setState = (selector, state) => api('PUT', `/lights/${sel(selector)}/state`, { duration: 0.5, ...state });

// ---------- Commands ----------

async function run(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    handleError(e);
  }
  scheduleRefresh();
}

function zoneCount(light) {
  return light.zones?.count || prefs[light.id]?.zones || 32;
}
function segmentSize(light) {
  return prefs[light.id]?.segment || 3;
}

// Build zone-range states that paint a pattern along a strip.
function patternStates(light, pattern) {
  const n = zoneCount(light);
  // The LIFX API accepts up to 50 states per request.
  const seg = Math.max(segmentSize(light), Math.ceil(n / 50));
  const chunks = Math.ceil(n / seg);
  const states = [];
  for (let i = 0; i < chunks; i++) {
    const from = i * seg;
    const to = Math.min(n - 1, from + seg - 1);
    const color = pattern.rainbow
      ? `hue:${Math.round((360 * i) / chunks)} saturation:1`
      : pattern.colors[i % pattern.colors.length];
    states.push({ selector: `id:${light.id}|${from}-${to}`, color });
  }
  return states;
}

async function applyPattern(light, pattern) {
  if (!isMultizone(light)) {
    return setState(`id:${light.id}`, {
      power: 'on',
      color: pattern.rainbow ? 'hue:0 saturation:1' : pattern.colors[0],
    });
  }
  await api('POST', `/lights/${sel(`id:${light.id}`)}/effects/off`, {});
  return api('PUT', '/lights/states', {
    states: patternStates(light, pattern),
    defaults: { power: 'on', duration: 0.5, brightness: Math.max(light.brightness || 0, 0.6) },
  });
}

async function applyScene(scene) {
  if (scene.state) return setState('all', scene.state);
  for (const light of lights.filter(l => l.connected)) {
    await applyPattern(light, scene.pattern);
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
    el('button', { onclick: () => run(() => applyScene(s), `${s.name} on`) }, s.name)));
}

function renderLights() {
  const names = [...new Set(lights.map(l => l.location?.name).filter(Boolean))];
  $('#house-name').textContent = names.length === 1 ? names[0] : names.length ? names.join(' + ') : 'My House';
  $('#status').textContent = (demo ? 'Demo mode · ' : '') +
    `${lights.length} light${lights.length === 1 ? '' : 's'} · updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('#empty').hidden = lights.length > 0;
  $('#lights').replaceChildren(...lights.map(lightCard));
}

function lightCard(light) {
  const on = light.power === 'on';
  const id = `id:${light.id}`;

  const toggle = el('input', {
    type: 'checkbox', checked: on, disabled: !light.connected,
    onchange: e => run(() => setState(id, { power: e.target.checked ? 'on' : 'off' })),
  });

  const brightness = el('input', {
    type: 'range', min: 1, max: 100, value: Math.round((light.brightness || 0) * 100),
    disabled: !light.connected, 'aria-label': 'Brightness',
    onchange: e => run(() => setState(id, { power: 'on', brightness: e.target.value / 100 })),
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
      onclick: () => run(() => setState(id, { power: 'on', color: c.api })),
    })),
    hasColor(light) && el('input', {
      type: 'color', 'aria-label': 'Custom colour', value: '#ff8800',
      onchange: e => run(() => setState(id, { power: 'on', color: e.target.value })),
    })));

  if (isMultizone(light)) {
    card.append(el('h3', {}, 'Patterns'), el('div', { class: 'chips' },
      PATTERNS.map(p => el('button', { onclick: () => run(() => applyPattern(light, p), `${p.name} on ${light.label}`) }, p.name)),
      el('button', {
        onclick: () => run(() => api('POST', `/lights/${sel(id)}/effects/move`, { direction: 'forward', period: 2, power_on: true }), 'Animating'),
      }, '▶︎ Animate'),
      el('button', {
        onclick: () => run(() => api('POST', `/lights/${sel(id)}/effects/off`, {}), 'Animation stopped'),
      }, '■ Stop')));

    card.append(el('details', {},
      el('summary', { class: 'muted small' }, 'Pattern settings'),
      el('div', { class: 'row', style: 'margin-top:8px' },
        !light.zones?.count && numberPref(light, 'zones', 'Zones on strip', zoneCount(light)),
        numberPref(light, 'segment', 'Zones per colour', segmentSize(light)))));
  }
  return card;
}

function numberPref(light, key, label, value) {
  return el('label', { class: 'inline' }, label,
    el('input', {
      type: 'number', min: 1, max: 500, value, inputmode: 'numeric',
      onchange: e => {
        const v = Math.max(1, parseInt(e.target.value, 10) || 1);
        prefs[light.id] = { ...prefs[light.id], [key]: v };
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      },
    }));
}

// ---------- Screens ----------

function show(screen) {
  $('#setup').hidden = screen !== 'setup';
  $('#main').hidden = screen !== 'main';
}

async function loadLights() {
  clearTimeout(refreshTimer);
  lights = await api('GET', '/lights/all');
  lights.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  renderLights();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadLights().catch(handleError), 1500);
}

function handleError(e) {
  if (e.unauthorized) {
    localStorage.removeItem(TOKEN_KEY);
    token = null;
    show('setup');
    showSetupError('Your saved token no longer works. Please paste a new one.');
    return;
  }
  toast(e.message, true);
}

function showSetupError(msg) {
  const p = $('#setup-error');
  p.textContent = msg;
  p.hidden = !msg;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 4500 : 2000);
}

async function start() {
  show('main');
  $('#status').textContent = 'Loading lights…';
  try {
    await loadLights();
  } catch (e) {
    handleError(e);
  }
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
  b.addEventListener('click', () => run(() => setState('all', { power: b.dataset.all }), `All lights ${b.dataset.all}`)));

$('#settings-btn').addEventListener('click', () => {
  $('#settings-info').textContent = demo
    ? 'You are in demo mode. No real lights are being changed.'
    : `Connected to LIFX. Token ends in …${(token || '').slice(-4)}.`;
  $('#logout-btn').textContent = demo ? 'Leave demo mode' : 'Remove token from this phone';
  $('#settings').showModal();
});
$('#close-settings').addEventListener('click', () => $('#settings').close());
$('#refresh-btn').addEventListener('click', () => { $('#settings').close(); loadLights().catch(handleError); });
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
  if (!document.hidden && (token || demo) && !$('#main').hidden) loadLights().catch(handleError);
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
