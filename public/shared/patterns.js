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

// ---------- Color science ----------
// Gradients blend in OKLCH, a color space built around how eyes see color,
// so midpoints stay bright and rich (red to blue passes through a vivid
// violet, not a muddy purple-gray). LIFX speaks hue/saturation/brightness
// (and kelvin for whites), so colors are converted on the way in and out.

const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = c => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };

function rgbToOklch([r, g, b]) {
  r = lin(r); g = lin(g); b = lin(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToRgb([L, C, H]) {
  const A = C * Math.cos(H), B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// Bring an out-of-range color back inside what screens and LEDs can show by
// easing off its chroma, which keeps its hue and lightness. Returns sRGB (0–1).
function inGamut(lch) {
  let [L, C, H] = lch;
  let rgb = oklchToRgb([L, C, H]);
  for (let i = 0; i < 12 && !rgb.every(v => v >= -0.001 && v <= 1.001); i++) {
    C *= 0.85;
    rgb = oklchToRgb([L, C, H]);
  }
  return rgb.map(gam);
}

export function hsvToRgb(h, s, v = 1) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

function rgbToHsv([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

// How a white at a color temperature looks, roughly (1500K warm … 9000K cool).
const KELVIN_RGB = [[1500, [1, 0.6, 0.24]], [2700, [1, 0.82, 0.63]], [4000, [1, 0.95, 0.88]], [6500, [0.96, 0.97, 1]], [9000, [0.84, 0.89, 1]]];
export function kelvinToRgb(k) {
  const i = Math.min(KELVIN_RGB.length - 1, Math.max(1, KELVIN_RGB.findIndex(([x]) => x >= k)));
  const [k0, a] = KELVIN_RGB[i - 1], [k1, b] = KELVIN_RGB[i];
  const f = Math.max(0, Math.min(1, (k - k0) / (k1 - k0)));
  return a.map((v, j) => v + (b[j] - v) * f);
}

export function parseHsbk(c) {
  const o = {};
  for (const [, k, v] of String(c).matchAll(/(\w+):([\d.]+)/g)) o[k] = Number(v);
  return { h: o.hue ?? 0, s: o.saturation ?? 0, k: o.kelvin ?? 3500 };
}

/** A LIFX color string as RGB (0–1) at full brightness. */
export function lifxToRgb(c) {
  if (typeof c === 'string' && c.startsWith('#')) return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
  const { h, s, k } = parseHsbk(c);
  return s < 0.01 ? kelvinToRgb(k) : hsvToRgb(h, s, 1);
}

/** A cell from a #hex color: its hue and saturation, with its darkness as brightness. */
export function hexCell(hex) {
  const [h, s, v] = rgbToHsv([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));
  return s < 0.03
    ? cell('kelvin:5000 saturation:0', Math.round(Math.max(0.05, v) * 100) / 100)
    : cell(`hue:${Math.round(h)} saturation:${Math.round(s * 100) / 100}`, Math.round(Math.max(0.05, v) * 100) / 100);
}

// ---------- Gradients ----------
// A gradient is color stops along the string: { c, b, pos 0–1 }. It can
// repeat around the house (mirrored, so it flows back and forth, or
// restarting), and blend directly or the long way round the color wheel.

export const GRADIENT_STYLES = ['mirror', 'repeat'];
export const GRADIENT_BLENDS = ['direct', 'rainbow'];

export function gradientSettings(p) {
  const stops = (Array.isArray(p?.stops) && p.stops.length >= 2 ? p.stops : (p?.loop || []).map((x, i, a) => ({ ...x, pos: a.length > 1 ? i / (a.length - 1) : 0 })))
    .filter(x => x && typeof x.c === 'string')
    .map(x => ({ c: x.c, b: typeof x.b === 'number' ? Math.min(1, Math.max(0.01, x.b)) : 1, pos: Math.min(1, Math.max(0, Number(x.pos) || 0)) }))
    .sort((a, b) => a.pos - b.pos);
  return {
    stops: stops.length ? stops : [{ c: C.Red, b: 1, pos: 0 }, { c: C.Blue, b: 1, pos: 1 }],
    repeat: Number.isInteger(p?.repeat) && p.repeat >= 1 && p.repeat <= 8 ? p.repeat : 1,
    style: GRADIENT_STYLES.includes(p?.style) ? p.style : 'mirror',
    blend: GRADIENT_BLENDS.includes(p?.blend) ? p.blend : 'direct',
  };
}

// Straight through each stop (perceptual blending is already smooth); easing
// in and out of every stop would leave flat bands of color at each one.
const ease = f => f;

/** The color at t (0–1) along a gradient: { c, b }. */
export function gradientAt(g, t) {
  const stops = g.stops;
  if (t <= stops[0].pos) return { c: stops[0].c, b: stops[0].b };
  if (t >= stops.at(-1).pos) return { c: stops.at(-1).c, b: stops.at(-1).b };
  let k = 0;
  while (k < stops.length - 2 && t > stops[k + 1].pos) k++;
  const a = stops[k], z = stops[k + 1];
  const f = ease(z.pos > a.pos ? (t - a.pos) / (z.pos - a.pos) : 0);
  const b = Math.round(Math.max(0.01, a.b + (z.b - a.b) * f) * 100) / 100;
  const ha = parseHsbk(a.c), hz = parseHsbk(z.c);
  // Two whites: blend the color temperature.
  if (ha.s < 0.01 && hz.s < 0.01 && !a.c.startsWith('#') && !z.c.startsWith('#')) {
    return { c: `kelvin:${Math.round((ha.k + (hz.k - ha.k) * f) / 50) * 50} saturation:0`, b };
  }
  const A = rgbToOklch(lifxToRgb(a.c)), Z = rgbToOklch(lifxToRgb(z.c));
  // A white has no hue of its own: it takes its neighbor's.
  if (A[1] < 0.02) A[2] = Z[2];
  if (Z[1] < 0.02) Z[2] = A[2];
  let dh = Z[2] - A[2];
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  if (g.blend === 'rainbow' && A[1] >= 0.02 && Z[1] >= 0.02) dh = dh > 0 ? dh - 2 * Math.PI : dh + 2 * Math.PI;
  const rgb = inGamut([A[0] + (Z[0] - A[0]) * f, A[1] + (Z[1] - A[1]) * f, A[2] + dh * f]);
  const [h, s, v] = rgbToHsv(rgb);
  // Stops carry their own brightness; blending only nudges it where colors
  // genuinely darken between them, so the string stays evenly lit.
  const bright = Math.round(Math.max(0.01, b * (0.75 + 0.25 * v)) * 100) / 100;
  return s < 0.02
    ? { c: 'kelvin:5500 saturation:0', b: bright }
    : { c: `hue:${Math.round(h)} saturation:${Math.round(s * 100) / 100}`, b: bright };
}

/** A gradient laid along n lights. */
export function gradientCells(pattern, n) {
  const g = gradientSettings(pattern);
  const out = [];
  for (let i = 0; i < n; i++) {
    let t;
    if (g.repeat === 1 && g.style === 'repeat') t = n > 1 ? i / (n - 1) : 0;
    else {
      const x = ((i + 0.5) / n) * g.repeat;
      const frac = x - Math.floor(x);
      t = g.style === 'mirror' ? (frac < 0.5 ? frac * 2 : 2 - frac * 2) : frac;
    }
    out.push(gradientAt(g, t));
  }
  return out;
}

// ---------- The pattern catalog ----------
// Built-in patterns, grouped like a library. Holidays carry the dates they're
// "in season" (MM-DD ranges, which may wrap New Year) so the home screen can
// show what's relevant now. Ids never change: schedules point at them.

export const CATEGORIES = [
  { id: 'holidays', name: 'Holidays & seasons' },
  { id: 'gradients', name: 'Gradients' },
  { id: 'calm', name: 'Moods · Calm' },
  { id: 'lively', name: 'Moods · Bright & lively' },
  { id: 'cozy', name: 'Moods · Warm & cozy' },
  { id: 'basics', name: 'Basics' },
];

const hsb = (h, s, b = 1, k = 3500) => (s < 0.01 ? cell(`kelvin:${k} saturation:0`, b) : cell(`hue:${h} saturation:${s}`, b));
const holiday = (id, name, loop, seasons) => ({ id, name, loop, seasons, category: 'holidays' });
// Moods use the colours of the LIFX app's Moods, blended smoothly along the lights.
const mood = (id, name, category, palette, seasons) => ({ id, name, category, layout: 'blend', loop: palette, seasons });
// Gradients: stops from #hex, spread evenly unless positions are given; tuned for how LEDs glow.
const gradient = (id, name, hexes, { repeat = 2, style = 'mirror', blend = 'direct', pos } = {}) => {
  const stops = hexes.map((h, i) => ({ ...hexCell(h), pos: pos ? pos[i] : i / (hexes.length - 1) }));
  return { id, name, category: 'gradients', layout: 'gradient', stops, repeat, style, blend, loop: stops.map(({ c, b }) => ({ c, b })) };
};

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

  gradient('b-g-aurora', '🌌 Aurora', ['#00f5a0', '#00d9f5', '#7f5af0', '#ff4fd8']),
  gradient('b-g-ember', '🔥 Ember', ['#ff2d1e', '#ff7a00', '#ffc14d', '#ff3d7f']),
  gradient('b-g-lagoon', '🏝️ Lagoon', ['#00e0c6', '#00c6ff', '#0072ff']),
  gradient('b-g-sunset', '🌅 Sunset', ['#ff512f', '#f09819', '#ff5e62', '#c86dd7'], { repeat: 1, pos: [0, 0.3, 0.6, 1] }),
  gradient('b-g-cotton', '🍭 Cotton candy', ['#ff9ad5', '#a18cff', '#7ad7ff']),
  gradient('b-g-northern', '🌠 Northern lights', ['#43e97b', '#38f9d7', '#4facfe', '#8e54e9'], { pos: [0, 0.25, 0.6, 1] }),
  gradient('b-g-peach', '🍑 Peach glow', ['#ff6a88', '#ff9a8b', '#ffc3a0']),
  gradient('b-g-reef', '🪸 Coral reef', ['#ff6f61', '#ffb88c', '#00d4c7']),
  gradient('b-g-ultraviolet', '💜 Ultraviolet', ['#5b00ff', '#b300ff', '#ff00c8']),
  gradient('b-g-glacier', '🧊 Glacier', ['#e6f7ff', '#7fd8ff', '#4f7dff'], { pos: [0, 0.45, 1] }),
  gradient('b-g-citrus', '🍋 Citrus', ['#f9f871', '#ffc75f', '#ff9671']),
  gradient('b-g-forest', '🌿 Forest mist', ['#00b09b', '#96c93d', '#e2f58a']),
  gradient('b-g-sakura', '🌸 Sakura', ['#ffd1e3', '#ff8fb1', '#c77dff']),
  gradient('b-g-desert', '🏜️ Desert dusk', ['#ff7e5f', '#feb47b', '#8e6dd8'], { repeat: 1, pos: [0, 0.45, 1] }),
  gradient('b-g-peacock', '🦚 Peacock', ['#00d68f', '#00a8a8', '#0061ff', '#7b2ff7']),
  gradient('b-g-cherry', '🍒 Cherry cola', ['#ff0844', '#ff6a3d', '#ffb199']),
  gradient('b-g-prism', '🔮 Prism', ['#ff3cac', '#784ba0', '#2b86c5']),
  gradient('b-g-bloom', '🌺 Midnight bloom', ['#3a1cff', '#a637ff', '#ff4fa3']),
  gradient('b-g-evergreen', '🌲 Evergreen & gold', ['#00b35c', '#9be15d', '#ffd54a'], { repeat: 3 }),
  gradient('b-g-swirl', '🍬 Candy swirl', ['#ff2a4d', '#ffd6de'], { repeat: 6 }),

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
  if (pattern.layout === 'gradient') return gradientCells(pattern, n);
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

// Moods: a smooth (perceptual) blend through the palette that loops back to
// its first color, repeating about every 40 lights.
function blendCells(palette, n) {
  const k = palette.length;
  const stops = [...palette, palette[0]].map((x, i) => ({ c: x.c, b: x.b ?? 1, pos: i / k }));
  return gradientCells({ stops, repeat: Math.max(1, Math.round(n / 40)), style: 'repeat' }, n);
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
