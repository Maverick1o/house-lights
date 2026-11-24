// Schedule maths shared by the app (for the live timeline) and the server
// (which actually runs the schedule), so both always agree.
//
// A schedule turns the lights on with a fade that finishes at sunset (or a set
// time), then starts fading them off at a set time.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;

// ---------- Sunset (NOAA solar calculator, accurate to about a minute) ----------

const sinD = x => Math.sin(x * RAD);
const cosD = x => Math.cos(x * RAD);

function julianDay(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

/**
 * Sunset on the UTC calendar day of `date` nearest that date's evening, for
 * lat/lon. Pass the house's local noon. Returns null where the sun doesn't set.
 */
export function sunsetNear(date, lat, lon) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
  let minutes = date.getUTCHours() * 60 + date.getUTCMinutes(); // first guess: noon local, in UTC minutes
  for (let i = 0; i < 3; i++) {
    const T = (julianDay(y, m, d) + minutes / 1440 - 2451545) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = sinD(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sinD(2 * M) * (0.019993 - 0.000101 * T) + sinD(3 * M) * 0.000289;
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * sinD(omega);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * cosD(omega);
    const dec = Math.asin(sinD(eps) * sinD(lambda)) / RAD;
    const yv = Math.tan((eps / 2) * RAD) ** 2;
    const eqTime = 4 / RAD * (yv * Math.sin(2 * L0 * RAD) - 2 * e * sinD(M) + 4 * e * yv * sinD(M) * Math.cos(2 * L0 * RAD)
      - 0.5 * yv * yv * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
    const cosHA = cosD(90.833) / (cosD(lat) * cosD(dec)) - Math.tan(lat * RAD) * Math.tan(dec * RAD);
    if (cosHA < -1 || cosHA > 1) return null; // midnight sun or polar night
    const ha = Math.acos(cosHA) / RAD;
    minutes = 720 - 4 * lon - eqTime + 4 * ha; // sunset, minutes after 00:00 UTC (may exceed 1440)
  }
  return new Date(Date.UTC(y, m - 1, d) + Math.round(minutes * 60000));
}

// ---------- Time zones ----------

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsCache.get(tz);
}

/** Calendar date and time of an instant in a time zone. */
export function zonedParts(instant, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(instant).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second };
}

const offsetMs = (instant, tz) => {
  const p = zonedParts(instant, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(instant.getTime() / 1000) * 1000;
};

/** The instant when the clock in `tz` reads y-m-d hh:mm (handles daylight saving). */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(first), tz);
  return new Date(second);
}

export const isValidTimeZone = tz => {
  try { formatter(tz); return true; } catch { return false; }
};

// ---------- Days ----------

export const addDays = (day, n) => {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
export const ymd = day => `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
export const weekday = day => new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay(); // 0 = Sunday

function inSeason(day, season) {
  if (!season?.from || !season?.to) return true;
  const md = `${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
  return season.from <= season.to ? md >= season.from && md <= season.to : md >= season.from || md <= season.to;
}

const hm = s => s.split(':').map(Number);

// ---------- Schedules ----------

export const DEFAULT_SCHEDULE = {
  enabled: true,
  on: { mode: 'sunset', offsetMin: 0, time: '17:00', fadeMin: 60 },
  off: { time: '23:00', fadeMin: 30 },
  days: [0, 1, 2, 3, 4, 5, 6],
  season: null,
  skipDates: [],
  level: 1,
};

/**
 * What a schedule does on one evening (a calendar date in the house's time zone).
 * Returns { date, sunset, fadeInStart, fullOn, fadeOutStart, offAt } or
 * { date, skip: reason } when nothing happens that evening.
 */
export function planFor(s, day) {
  const { tz, lat, lon } = s.location;
  const date = ymd(day);
  const noon = zonedToUtc(day.y, day.m, day.d, 12, 0, tz);
  const sunset = sunsetNear(noon, lat, lon);
  if (!s.enabled) return { date, sunset, skip: 'paused' };
  if (!s.days.includes(weekday(day))) return { date, sunset, skip: 'day' };
  if (!inSeason(day, s.season)) return { date, sunset, skip: 'season' };
  if (s.skipDates?.includes(date)) return { date, sunset, skip: 'skipped' };

  let fullOn;
  if (s.on.mode === 'sunset') {
    if (!sunset) return { date, sunset, skip: 'no-sunset' };
    fullOn = new Date(sunset.getTime() + s.on.offsetMin * 60000);
  } else {
    const [h, mi] = hm(s.on.time);
    fullOn = zonedToUtc(day.y, day.m, day.d, h, mi, tz);
  }
  const fadeInStart = new Date(fullOn.getTime() - s.on.fadeMin * 60000);

  // The off time belongs to the same evening; if it's earlier than "on"
  // (e.g. 1:00 AM) it's after midnight.
  const [oh, om] = hm(s.off.time);
  let fadeOutStart = zonedToUtc(day.y, day.m, day.d, oh, om, tz);
  if (fadeOutStart <= fullOn) {
    const next = addDays(day, 1);
    fadeOutStart = zonedToUtc(next.y, next.m, next.d, oh, om, tz);
  }
  const offAt = new Date(fadeOutStart.getTime() + s.off.fadeMin * 60000);
  return { date, sunset, fadeInStart, fullOn, fadeOutStart, offAt };
}

/** The evening currently relevant at `now`: tonight, or last night if it is still running. */
export function currentPlan(s, now = new Date()) {
  const today = zonedParts(now, s.location.tz);
  const todayDay = { y: today.y, m: today.m, d: today.d };
  const last = planFor(s, addDays(todayDay, -1));
  if (!last.skip && last.offAt > now) return last;
  return planFor(s, todayDay);
}

/** The next evening (from now) when the schedule actually runs, within two weeks. */
export function nextRun(s, now = new Date()) {
  const p = zonedParts(now, s.location.tz);
  let day = { y: p.y, m: p.m, d: p.d };
  for (let i = -1; i < 14; i++) {
    const plan = planFor(s, addDays(day, i));
    if (!plan.skip && plan.offAt > now) return plan;
  }
  return null;
}

/** Events the server should start, with how long each fade should take. */
export function dueEvents(s, now, windowMs = 20 * 60000) {
  const today = zonedParts(now, s.location.tz);
  const todayDay = { y: today.y, m: today.m, d: today.d };
  const out = [];
  for (const day of [addDays(todayDay, -1), todayDay]) {
    const p = planFor(s, day);
    if (p.skip) continue;
    const events = [
      { kind: 'fade-in', at: p.fadeInStart, until: p.fullOn },
      { kind: 'motion', at: p.fullOn },
      { kind: 'fade-out', at: p.fadeOutStart, until: p.offAt },
    ];
    for (const e of events) {
      if (e.at > now || e.at <= now - windowMs) continue;
      // Don't start the fade-in if it's already time to turn off.
      if (e.kind !== 'fade-out' && p.fadeOutStart <= now) continue;
      const seconds = e.until ? Math.max(1, Math.round((e.until - Math.max(now, e.at)) / 1000)) : 0;
      out.push({ ...e, date: p.date, seconds });
    }
  }
  return out;
}
