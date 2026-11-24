// Patterns: how colours are laid out along a group of light strips.
//
// Shared by the app (to paint the lights when you tap something) and the
// server (to paint the lights when a schedule fades them on), so a pattern
// always looks the same whoever sends it, and a schedule always uses the
// current version of the pattern it was given.
//
// Words used here:
//   cell     one light's setting: { c: LIFX colour string, b: brightness 0–1 (0 = off) }
//   prefs    a group's settings: { order, reversed, level, last }
//   pattern  { id, name, loop: [cell…], width?, gaps?, layout?, overrides?, cells?, motion }

// ---------- Colours ----------

export const COLORS = [
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
export const C = Object.fromEntries(COLORS.map(c => [c.name, c.api]));
export const cell = (c, b = 1) => ({ c, b });

// ---------- The pattern catalog ----------
// Built-in patterns, grouped like a library. Holidays carry the dates they're
// "in season" (MM-DD ranges, which may wrap New Year) so the home screen can
// show what's relevant now. Ids never change: schedules point at them.

export const CATEGORIES = [
  { id: 'holidays', name: 'Holidays & seasons' },
  { id: 'calm', name: 'Moods · Calm' },
  { id: 'lively', name: 'Moods · Bright & lively' },
  { id: 'cozy', name: 'Moods · Warm & cozy' },
  { id: 'basics', name: 'Basics' },
];

const hsb = (h, s, b = 1, k = 3500) => (s < 0.01 ? cell(`kelvin:${k} saturation:0`, b) : cell(`hue:${h} saturation:${s}`, b));
const holiday = (id, name, loop, seasons) => ({ id, name, loop, seasons, category: 'holidays' });
// Moods use the colours of the LIFX app's Moods, blended smoothly along the lights.
const mood = (id, name, category, palette, seasons) => ({ id, name, category, layout: 'blend', loop: palette, seasons });

export const BUILTIN = [
  holiday('b-newyear', '🎆 New Year', [hsb(45, 0.85), cell(C.White)], [['12-26', '01-02']]),
  holiday('b-valen', '💖 Valentine', [cell(C.Red), cell(C.Pink)], [['02-01', '02-14']]),
  holiday('b-patty', '☘️ St Patrick', [cell(C.Green), cell('hue:100 saturation:0.5')], [['03-01', '03-17']]),
  holiday('b-easter', '🐣 Easter', [hsb(330, 0.35), hsb(55, 0.45), hsb(270, 0.35), hsb(150, 0.35)], [['03-15', '04-25']]),
  holiday('b-spring', '🌷 Spring', [hsb(340, 0.5), hsb(100, 0.6), hsb(50, 0.6)], [['03-20', '05-31']]),
  holiday('b-july', '🇺🇸 July 4th', [cell(C.Red), cell(C.White), cell(C.Blue)], [['05-20', '05-31'], ['06-25', '07-05'], ['08-28', '09-07']]),
  holiday('b-autumn', '🍂 Autumn', [hsb(25, 1), hsb(42, 0.9), hsb(5, 0.9)], [['09-15', '11-30']]),
  holiday('b-hallo', '🎃 Halloween', [cell(C.Orange), cell(C.Purple)], [['10-01', '10-31']]),
  holiday('b-thanks', '🦃 Thanksgiving', [hsb(28, 0.95), hsb(42, 0.85), hsb(10, 0.85, 0.6)], [['11-01', '11-30']]),
  holiday('b-xmas', '🎄 Christmas', [cell(C.Red), cell(C.Green)], [['11-15', '12-31']]),
  holiday('b-candy', '🍬 Candy cane', [cell(C.Red), cell(C.Red), cell(C.White), cell(C.White)], [['11-15', '12-31']]),
  holiday('b-hanuk', '🕎 Hanukkah', [cell(C.Blue), cell(C.White)], [['11-25', '12-31']]),
  holiday('b-winter', '❄️ Winter', [cell(C.White), cell('hue:200 saturation:0.6')], [['12-01', '02-28']]),

  mood('b-m-dream', '💭 Dream', 'calm', [hsb(201, 0.76, 0.23), hsb(183, 0.75, 0.32), hsb(199, 0.22, 0.62), hsb(223, 0.22, 1), hsb(219, 0.29, 0.52), hsb(167, 0.62, 0.55)]),
  mood('b-m-gentle', '🕊️ Gentle', 'calm', [hsb(42, 0.36), hsb(52, 0.21), hsb(0, 0, 1, 9000), hsb(338, 0.38), hsb(0, 0, 1, 2500)]),
  mood('b-m-peaceful', '🌅 Peaceful', 'calm', [hsb(198, 0.48, 0.11), hsb(2, 0.46, 1), hsb(54, 0.36, 0.85), hsb(4, 0.63, 0.56), hsb(203, 0.34, 0.56)]),
  mood('b-m-sleepy', '😴 Sleepy', 'calm', [hsb(0, 1, 0.05), hsb(1, 1, 1), hsb(0, 1, 0.5)]),
  mood('b-m-soothing', '🛁 Soothing', 'calm', [hsb(336, 0.18, 0.67), hsb(335, 0.5, 0.67), hsb(0, 0, 1, 8000), hsb(302, 0.69, 1), hsb(330, 0.45, 0.58)]),
  mood('b-m-tranquil', '🌊 Tranquil', 'calm', [hsb(205, 0.4, 0.96), hsb(203, 0.5, 0.96), hsb(60, 0.25, 0.99), hsb(241, 0.5, 1), hsb(75, 0.25, 0.53)]),
  mood('b-m-cheerful', '😊 Cheerful', 'lively', [hsb(51, 1, 0.67), hsb(310, 1, 1), hsb(266, 0.87, 0.47), hsb(248, 1, 0.67), hsb(282, 1, 0.67)]),
  mood('b-m-energizing', '⚡ Energizing', 'lively', [hsb(242, 1, 0.42), hsb(0, 0, 1, 9000), hsb(205, 0.47, 1), hsb(191, 0.89, 1), hsb(180, 0.87, 0.27), hsb(0, 0, 0.3, 9000)]),
  mood('b-m-focus', '🎯 Focus', 'lively', [hsb(0, 0, 1, 6500), hsb(240, 0.3, 1)]),
  mood('b-m-powerful', '💥 Powerful', 'lively', [hsb(10, 0.99, 0.66), hsb(59, 0.7, 1), hsb(11, 0.99, 0.41), hsb(61, 0.44, 0.99), hsb(18, 0.98, 0.98), hsb(52, 0.88, 0.97)]),
  mood('b-m-pride', '🏳️‍🌈 Pride', 'lively', [hsb(349, 0.88), hsb(32, 1), hsb(60, 1), hsb(120, 0.5), hsb(215, 0.85), hsb(271, 1), hsb(303, 0.2), hsb(240, 1)], [['06-01', '06-30']]),
  mood('b-m-blissful', '🌸 Blissful', 'cozy', [hsb(303, 0.18, 1), hsb(232, 0.46, 0.53), hsb(252, 0.37, 0.69), hsb(245, 0.29, 0.81), hsb(303, 0.37, 0.18), hsb(56, 1, 1), hsb(321, 0.39, 0.78)]),
  mood('b-m-mellow', '🍷 Mellow', 'cozy', [hsb(359, 0.31, 0.59), hsb(315, 0.24, 1), hsb(79, 0.05, 0.4), hsb(256, 0.36, 0.5), hsb(241, 1, 0.4)]),
  mood('b-m-romance', '🌹 Romance', 'cozy', [hsb(322, 0.15, 0.98), hsb(315, 0.45, 0.92), hsb(349, 0.88, 0.9), hsb(307, 0.16, 1), hsb(345, 0.76, 1)]),
  mood('b-m-warming', '🕯️ Warming', 'cozy', [hsb(4, 1, 0.76), hsb(42, 0.81, 1), hsb(355, 0.81, 0.56), hsb(44, 0.44, 0.65), hsb(51, 0.85, 0.59), hsb(0, 0, 0.3)]),

  { id: 'b-warm', name: '✨ Warm bulbs', loop: [cell(C.Warm)], category: 'basics' },
  { id: 'b-rainbow', name: '🌈 Rainbow', rainbow: true, category: 'basics' },
];
export const builtinById = id => BUILTIN.find(b => b.id === id) || null;

/** Is a pattern "in season" on a date (by its MM-DD ranges)? */
export function inSeason(pattern, date = new Date()) {
  if (!pattern?.seasons) return false;
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return pattern.seasons.some(([from, to]) => (from <= to ? md >= from && md <= to : md >= from || md <= to));
}
export const isBuiltin = p => !!p && (p.rainbow || p.id?.startsWith('b-'));

// ---------- Lights along the string ----------

export const isMultizone = l => !!l.product?.capabilities?.has_multizone;
export const stripLength = l => (isMultizone(l) ? l.zones?.count || 32 : 1);

/** Fill in a group's settings with defaults (changes and returns the same object). */
export function withDefaults(p = {}) {
  p.order ??= [];
  p.reversed ??= {};
  p.level ??= 1;
  return p;
}

/** A group's lights in the saved strip order (new lights go at the end). */
export function orderLights(lights, prefs) {
  const order = prefs?.order || [];
  const rank = l => { const i = order.indexOf(l.id); return i === -1 ? 1e6 : i; };
  return [...lights].sort((a, b) => rank(a) - rank(b) || (a.label || '').localeCompare(b.label || ''));
}

/** Every light position along the string, in order: [{ light, zone }]. */
export function positions(lights, prefs) {
  const rev = prefs?.reversed || {};
  const out = [];
  for (const l of lights) {
    if (!isMultizone(l)) { out.push({ light: l, zone: null }); continue; }
    const n = stripLength(l);
    for (let i = 0; i < n; i++) out.push({ light: l, zone: rev[l.id] ? n - 1 - i : i });
  }
  return out;
}

// ---------- Cells ----------

export const tile = (loop, n) => Array.from({ length: n }, (_, i) => ({ ...loop[i % loop.length] }));

// Spacing: each colour can cover several lights ("lights per colour"), with an
// optional gap after it that is off or barely lit.
export const GAPS = ['none', 'off', 'dim'];
export const spacingOf = p => ({
  width: Number.isInteger(p?.width) && p.width >= 1 && p.width <= 50 ? p.width : 1,
  gaps: GAPS.includes(p?.gaps) ? p.gaps : 'none',
});

/** Lay a pattern's colours along n lights, honouring its spacing. */
export function layoutCells(pattern, n) {
  if (pattern.layout === 'blend' && pattern.loop?.length) return blendCells(pattern.loop, n);
  const { width, gaps } = spacingOf(pattern);
  const perBlock = gaps === 'none' ? 1 : 2;
  const colourBlocks = Math.max(1, Math.ceil(n / width / perBlock));
  const loop = pattern.loop?.length ? pattern.loop : [cell(C.Warm)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const block = Math.floor(i / width);
    const k = Math.floor(block / perBlock);
    const x = pattern.rainbow ? cell(`hue:${Math.round((360 * k) / colourBlocks) % 360} saturation:1`) : loop[k % loop.length];
    const isGap = gaps !== 'none' && block % 2 === 1;
    out.push(isGap ? { c: x.c, b: gaps === 'dim' ? 0.02 : 0 } : { c: x.c, b: x.b ?? 1 });
  }
  return out;
}

// A smooth blend through the palette, repeating about every 40 lights.
function parseHsbk(c) {
  const o = {};
  for (const [, k, v] of String(c).matchAll(/(\w+):([\d.]+)/g)) o[k] = Number(v);
  return { h: o.hue ?? 0, s: o.saturation ?? 0, k: o.kelvin ?? 3500 };
}
function blendCells(palette, n) {
  const pts = palette.map(x => ({ ...parseHsbk(x.c), b: x.b ?? 1 }));
  const cycles = Math.max(1, Math.round(n / 40));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * cycles * pts.length;
    const a = pts[Math.floor(t) % pts.length], z = pts[(Math.floor(t) + 1) % pts.length];
    const f = t - Math.floor(t);
    let dh = z.h - a.h;
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    // A white blends by temperature; its hue follows the coloured neighbour.
    const h = a.s < 0.01 ? z.h : z.s < 0.01 ? a.h : (a.h + dh * f + 360) % 360;
    const s = a.s + (z.s - a.s) * f, k = a.k + (z.k - a.k) * f, b = a.b + (z.b - a.b) * f;
    const c = s < 0.01 ? `kelvin:${Math.round(k / 100) * 100} saturation:0` : `hue:${Math.round(h)} saturation:${Math.round(s * 100) / 100} kelvin:${Math.round(k / 100) * 100}`;
    out.push({ c, b: Math.max(0.01, Math.round(b * 100) / 100) });
  }
  return out;
}

/** The cells a pattern paints on n lights. */
export function patternCells(pattern, prefs, n) {
  if (!isBuiltin(pattern)) {
    if (pattern.cells?.length === n) return pattern.cells.map(x => ({ ...x })); // exactly as painted
    if (!pattern.loop?.length && pattern.cells?.length) return tile(pattern.cells, n); // painted for another length
  }
  const cells = layoutCells(pattern, n);
  for (const [i, x] of Object.entries(pattern.overrides || {})) if (+i < n) cells[+i] = { ...x };
  return cells;
}

export const scaled = (b, level) => (b > 0 ? Math.max(0.01, Math.round(b * level * 1000) / 1000) : 0);
const cellKey = (x, level) => `${x.c}|${scaled(x.b, level)}`;

/** Turn per-light cells into the fewest LIFX states (runs of equal zones merge). */
export function cellsToStates(pos, cells, level = 1) {
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

// ---------- Motion ----------
// What the lights do after a pattern is painted:
//   { type: 'none' | 'chase' | 'breathe' | 'pulse', dir, speed, to }
// Older patterns stored just a string ('chase', 'chase-back', …); both work.
// Speed is a slider from 0 (slowest) to 1 (fastest). It maps to the LIFX
// "period" (seconds per cycle) on a curve, so every step of the slider feels
// like a similar change in speed.

const PERIODS = {
  chase: { slow: 8, fast: 0.3 },     // seconds per step along the strip
  breathe: { slow: 10, fast: 1 },    // seconds per fade in and out
  pulse: { slow: 3, fast: 0.25 },    // seconds per blink
};
const OLD_SPEEDS = { slow: 0.2, medium: 0.5, fast: 0.8 }; // patterns saved before the slider
export const DEFAULT_TO = 'brightness:0.05';

export const periodFor = (type, speed) => {
  const p = PERIODS[type];
  return p && Math.round(p.slow * (p.fast / p.slow) ** speed * 100) / 100;
};

export function normalizeMotion(effect, motion = {}) {
  if (effect && typeof effect === 'object') return normalizeMotion(effect.type, effect);
  const type = effect === 'chase' || effect === 'chase-back' ? 'chase' : effect === 'breathe' || effect === 'pulse' ? effect : 'none';
  return {
    type,
    dir: effect === 'chase-back' || motion?.dir === 'backward' ? 'backward' : 'forward',
    speed: typeof motion?.speed === 'number' && motion.speed >= 0 && motion.speed <= 1 ? motion.speed
      : OLD_SPEEDS[motion?.speed] ?? 0.5,
    to: typeof motion?.to === 'string' && motion.to.length < 60 ? motion.to : DEFAULT_TO,
  };
}
export const patternMotion = p => normalizeMotion(p?.motion || p?.effect, p?.motion);
export const legacyEffect = mo => (mo.type === 'chase' ? (mo.dir === 'backward' ? 'chase-back' : 'chase') : mo.type);

/** The LIFX effect call for a motion setting, or null for "steady". */
export function motionRequest(mo) {
  if (!mo || mo.type === 'none') return null;
  const period = periodFor(mo.type, mo.speed);
  if (mo.type === 'chase') return { effect: 'move', body: { direction: mo.dir === 'backward' ? 'backward' : 'forward', period, power_on: true } };
  if (mo.type === 'breathe' || mo.type === 'pulse') {
    return { effect: mo.type, body: { color: mo.to || DEFAULT_TO, period, cycles: 100000, persist: false, power_on: true } };
  }
  return null;
}

// ---------- What a schedule shows ----------
// A schedule points at a pattern instead of keeping its own copy:
//   { source: 'last' }                      whatever was last played on the group
//   { source: 'saved', id, owner }          one of a person's saved patterns
//   { source: 'builtin', id }               a built-in pattern
// Schedules saved before this existed have no source, just a name.

/** The pattern a schedule points at, as it is right now, or null if it's gone. */
export function resolvePattern(ref, { prefs, savedPatterns = [] }) {
  if (!ref) return null;
  if (ref.source === 'last') {
    const last = prefs?.last;
    return last?.cells?.length ? { name: last.name || 'Last played', cells: last.cells, motion: normalizeMotion(last.effect) } : null;
  }
  if (ref.source === 'builtin') return BUILTIN.find(b => b.id === ref.id) || null;
  if (ref.source === 'saved') return savedPatterns.find(p => p.id === ref.id) || null;
  // Older schedules: match by name.
  return BUILTIN.find(b => b.name === ref.name) || savedPatterns.find(p => p.name === ref.name) || null;
}

/** States and motion for a pattern on a group's lights (brightness at 100%). */
export function expandPattern(pattern, lights, prefs) {
  const pos = positions(orderLights(lights, prefs), prefs);
  return {
    name: pattern.name,
    states: cellsToStates(pos, patternCells(pattern, prefs, pos.length), 1),
    motion: patternMotion(pattern),
  };
}
