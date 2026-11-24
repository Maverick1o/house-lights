// Patterns: how colours are laid out along a group of light strips.
//
// Shared by the app (to paint the lights when you tap something) and the
// server (to paint the lights when a schedule fades them on), so a pattern
// always looks the same whoever sends it, and a schedule always uses the
// current version of the pattern it was given.
//
// Words used here:
//   cell     one light's setting: { c: LIFX colour string, b: brightness 0–1 (0 = off) }
//   prefs    a group's settings: { order, reversed, width, gaps, level, last }
//   pattern  { id, name, loop: [cell…], cells?: [cell…], motion } or a built-in

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

export const BUILTIN = [
  { id: 'b-warm',  name: '✨ Warm bulbs', loop: [cell(C.Warm)] },
  { id: 'b-xmas',  name: '🎄 Christmas',  loop: [cell(C.Red), cell(C.Green)] },
  { id: 'b-hallo', name: '🎃 Halloween',  loop: [cell(C.Orange), cell(C.Purple)] },
  { id: 'b-july',  name: '🇺🇸 July 4th',  loop: [cell(C.Red), cell(C.White), cell(C.Blue)] },
  { id: 'b-winter', name: '❄️ Winter',    loop: [cell(C.White), cell('hue:200 saturation:0.6')] },
  { id: 'b-valen', name: '💖 Valentine',  loop: [cell(C.Red), cell(C.Pink)] },
  { id: 'b-patty', name: '☘️ St Patrick', loop: [cell(C.Green), cell('hue:100 saturation:0.5')] },
  { id: 'b-rainbow', name: '🌈 Rainbow',  rainbow: true },
];
export const isBuiltin = p => !!p && (p.rainbow || p.id?.startsWith('b-'));

// ---------- Lights along the string ----------

export const isMultizone = l => !!l.product?.capabilities?.has_multizone;
export const stripLength = l => (isMultizone(l) ? l.zones?.count || 32 : 1);

/** Fill in a group's settings with defaults (changes and returns the same object). */
export function withDefaults(p = {}) {
  p.order ??= [];
  p.reversed ??= {};
  p.width ??= 1;
  p.gaps ??= 'none';
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

/** Built-in patterns honour the group's "lights per colour" and "gaps" options. */
export function builtinCells(pattern, prefs, n) {
  const { width = 1, gaps = 'none' } = prefs || {};
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

/** The cells a pattern paints on n lights. */
export function patternCells(pattern, prefs, n) {
  if (isBuiltin(pattern)) return builtinCells(pattern, prefs, n);
  if (pattern.cells?.length === n) return pattern.cells.map(x => ({ ...x }));
  if (pattern.loop?.length) return tile(pattern.loop, n);
  if (pattern.cells?.length) return tile(pattern.cells, n); // painted for a different number of lights
  return tile([cell(C.Warm)], n);
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
