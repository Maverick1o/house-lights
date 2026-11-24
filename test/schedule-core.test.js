import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunsetNear, zonedToUtc, zonedParts, planFor, dueEvents, nextRun, currentPlan, DEFAULT_SCHEDULE } from '../public/shared/schedule-core.js';

const NYC = { lat: 40.7128, lon: -74.006, tz: 'America/New_York' };
const SEA = { lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles' };
const sched = (extra = {}) => ({ ...structuredClone(DEFAULT_SCHEDULE), location: NYC, ...extra });
const local = (instant, tz) => { const p = zonedParts(instant, tz); return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`; };
const minutesApart = (a, b) => Math.abs(a - b) / 60000;

test('sunset matches published times within 2 minutes', () => {
  // Reference values from NOAA's solar calculator method (computed independently).
  const cases = [
    [NYC, 2026, 12, 21, '16:31'],
    [NYC, 2026, 6, 21, '20:30'],
    [SEA, 2026, 11, 24, '16:24'],
  ];
  for (const [loc, y, m, d, expected] of cases) {
    const s = sunsetNear(zonedToUtc(y, m, d, 12, 0, loc.tz), loc.lat, loc.lon);
    const [eh, em] = expected.split(':').map(Number);
    const exp = zonedToUtc(y, m, d, eh, em, loc.tz);
    assert.ok(minutesApart(s, exp) <= 1, `${loc.tz} ${y}-${m}-${d}: got ${local(s, loc.tz)}, expected ${expected}`);
  }
});

test('no sunset in polar day returns null instead of a wrong time', () => {
  assert.equal(sunsetNear(zonedToUtc(2026, 6, 21, 12, 0, 'Europe/Oslo'), 78.2, 15.6), null); // Svalbard
});

test('local times convert correctly, including across daylight-saving changes', () => {
  assert.equal(zonedToUtc(2026, 11, 24, 23, 0, 'America/New_York').toISOString(), '2026-11-25T04:00:00.000Z');
  assert.equal(zonedToUtc(2026, 7, 4, 23, 0, 'America/New_York').toISOString(), '2026-07-05T03:00:00.000Z');
  // Day the clocks go back (Nov 1 2026): 11 PM is EST
  assert.equal(zonedToUtc(2026, 11, 1, 23, 0, 'America/New_York').toISOString(), '2026-11-02T04:00:00.000Z');
  // Day the clocks go forward (Mar 8 2026): 11 PM is EDT
  assert.equal(zonedToUtc(2026, 3, 8, 23, 0, 'America/New_York').toISOString(), '2026-03-09T03:00:00.000Z');
});

test('default plan: fully on at sunset after a 60-minute fade, off fade starts 11:00, off by 11:30', () => {
  const p = planFor(sched(), { y: 2026, m: 12, d: 21 });
  assert.ok(minutesApart(p.fullOn, p.sunset) < 0.01);
  assert.equal(minutesApart(p.fadeInStart, p.fullOn), 60);
  assert.equal(local(p.fadeOutStart, NYC.tz), '23:00');
  assert.equal(local(p.offAt, NYC.tz), '23:30');
});

test('offsets, fixed on-times and after-midnight off times', () => {
  const offset = planFor(sched({ on: { mode: 'sunset', offsetMin: 15, fadeMin: 30, time: '17:00' } }), { y: 2026, m: 12, d: 21 });
  assert.equal(minutesApart(offset.fullOn, offset.sunset), 15);
  const fixed = planFor(sched({ on: { mode: 'time', time: '18:30', fadeMin: 0, offsetMin: 0 }, off: { time: '01:00', fadeMin: 20 } }), { y: 2026, m: 12, d: 21 });
  assert.equal(local(fixed.fullOn, NYC.tz), '18:30');
  assert.equal(fixed.fadeOutStart.toISOString(), zonedToUtc(2026, 12, 22, 1, 0, NYC.tz).toISOString());
  assert.equal(local(fixed.offAt, NYC.tz), '01:20');
});

test('days, seasons (across New Year), skip-tonight and pause', () => {
  const tue = { y: 2026, m: 12, d: 22 };
  assert.equal(planFor(sched({ days: [5, 6] }), tue).skip, 'day');
  const season = { from: '11-28', to: '01-02' };
  assert.equal(planFor(sched({ season }), { y: 2026, m: 12, d: 31 }).skip, undefined);
  assert.equal(planFor(sched({ season }), { y: 2027, m: 1, d: 1 }).skip, undefined);
  assert.equal(planFor(sched({ season }), { y: 2027, m: 1, d: 3 }).skip, 'season');
  assert.equal(planFor(sched({ season }), { y: 2026, m: 11, d: 27 }).skip, 'season');
  assert.equal(planFor(sched({ skipDates: ['2026-12-22'] }), tue).skip, 'skipped');
  assert.equal(planFor(sched({ enabled: false }), tue).skip, 'paused');
});

test('due events fire inside the window only, with the remaining fade time', () => {
  const s = sched();
  const p = planFor(s, { y: 2026, m: 12, d: 21 });
  const at = (base, min) => new Date(base.getTime() + min * 60000);
  assert.deepEqual(dueEvents(s, at(p.fadeInStart, -1)), []);
  const first = dueEvents(s, at(p.fadeInStart, 2));
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'fade-in');
  assert.equal(first[0].seconds, 58 * 60); // started 2 minutes late → finishes on time
  assert.equal(dueEvents(s, at(p.fullOn, 1))[0].kind, 'motion');
  const out = dueEvents(s, at(p.fadeOutStart, 4));
  assert.equal(out[0].kind, 'fade-out');
  assert.equal(out[0].seconds, 26 * 60);
  assert.deepEqual(dueEvents(s, at(p.fadeOutStart, 25)).map(e => e.kind), []); // window passed
});

test('fade-out after midnight is still found the next day', () => {
  const s = sched({ off: { time: '00:30', fadeMin: 30 } });
  const p = planFor(s, { y: 2026, m: 12, d: 21 });
  const due = dueEvents(s, new Date(p.fadeOutStart.getTime() + 60000));
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, 'fade-out');
  assert.equal(due[0].date, '2026-12-21');
});

test('nextRun and currentPlan describe tonight correctly', () => {
  const s = sched({ days: [6] }); // Saturdays only
  const tue = zonedToUtc(2026, 12, 22, 9, 0, NYC.tz);
  assert.equal(nextRun(s, tue).date, '2026-12-26');
  const lateNight = zonedToUtc(2026, 12, 21, 23, 10, NYC.tz);
  assert.equal(currentPlan(sched(), lateNight).date, '2026-12-21');
});
