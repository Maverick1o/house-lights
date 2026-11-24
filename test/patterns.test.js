import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  C, cell, BUILTIN, positions, layoutCells, inSeason, orderLights, patternCells, cellsToStates, resolvePattern, expandPattern, normalizeMotion, motionRequest,
} from '../public/shared/patterns.js';

const strip = (id, label, count) => ({ id, label, zones: { count }, product: { capabilities: { has_multizone: true } } });
const A = strip('a', 'Front', 3), B = strip('b', 'Garage', 2);

test('strips follow the saved order and direction, new strips go last', () => {
  const prefs = { order: ['b', 'a'], reversed: { b: true } };
  const lights = orderLights([A, B, strip('c', 'Back', 1)], prefs);
  assert.deepEqual(lights.map(l => l.id), ['b', 'a', 'c']);
  assert.deepEqual(positions(lights, prefs).map(p => `${p.light.id}${p.zone}`), ['b1', 'b0', 'a0', 'a1', 'a2', 'c0']);
});

test('spacing: lights per color and what goes between colors, set on the pattern', () => {
  const xmas = BUILTIN.find(b => b.id === 'b-xmas');
  assert.deepEqual(patternCells(xmas, {}, 4).map(x => x.c), [C.Red, C.Green, C.Red, C.Green]);
  const spaced = { id: 'p-1', loop: [cell(C.Red), cell(C.Green)], width: 2, gaps: 'off' };
  assert.deepEqual(patternCells(spaced, {}, 8).map(x => x.b), [1, 1, 0, 0, 1, 1, 0, 0]);
  assert.deepEqual(patternCells(spaced, {}, 8).map(x => x.c), [C.Red, C.Red, C.Red, C.Red, C.Green, C.Green, C.Green, C.Green]);
  assert.deepEqual(layoutCells({ loop: [cell(C.Red)], gaps: 'dim' }, 4).map(x => x.b), [1, 0.02, 1, 0.02]);
  assert.deepEqual(layoutCells({ loop: [cell(C.Red)], width: 99, gaps: 'nonsense' }, 2).map(x => x.b), [1, 1], 'bad values fall back safely');
});

test('single-light changes sit on top of the spacing', () => {
  const p = { id: 'p-2', loop: [cell(C.Red)], width: 1, gaps: 'none', overrides: { 1: cell(C.Blue) } };
  assert.deepEqual(patternCells(p, {}, 3).map(x => x.c), [C.Red, C.Blue, C.Red]);
});

test('moods blend smoothly through their colors, repeating along long strings', () => {
  const tranquil = BUILTIN.find(b => b.id === 'b-m-tranquil');
  const cells = patternCells(tranquil, {}, 120);
  assert.equal(cells.length, 120);
  assert.ok(new Set(cells.map(x => x.c)).size > 20, 'a gradient, not blocks');
  assert.equal(cells[0].c, cells[40].c, 'repeats about every 40 lights');
  for (const x of cells) assert.ok(x.b > 0 && x.b <= 1);
  assert.equal(BUILTIN.filter(b => b.layout === 'blend').length, 15, 'all 15 LIFX moods');
});

test('holidays know when they are in season, across New Year too', () => {
  const byId = id => BUILTIN.find(b => b.id === id);
  assert.ok(inSeason(byId('b-xmas'), new Date(2026, 11, 10)));
  assert.ok(!inSeason(byId('b-xmas'), new Date(2026, 6, 4)));
  assert.ok(inSeason(byId('b-july'), new Date(2026, 6, 4)));
  assert.ok(inSeason(byId('b-newyear'), new Date(2027, 0, 1)));
  assert.ok(!inSeason(byId('b-warm'), new Date()), 'basics have no season');
  assert.equal(new Set(BUILTIN.map(b => b.id)).size, BUILTIN.length, 'ids are unique');
  for (const id of ['b-warm', 'b-xmas', 'b-hallo', 'b-july', 'b-winter', 'b-valen', 'b-patty', 'b-rainbow']) assert.ok(byId(id), `${id} still exists for schedules`);
});

test('painted cells are reused exactly, or repeated when the light count changed', () => {
  const painted = { id: 'p-1', cells: [cell(C.Red), cell(C.Blue)] };
  assert.deepEqual(patternCells(painted, {}, 2), painted.cells);
  assert.deepEqual(patternCells(painted, {}, 3).map(x => x.c), [C.Red, C.Blue, C.Red]);
});

test('runs of equal zones merge into one LIFX state', () => {
  const pos = positions([A], {});
  const states = cellsToStates(pos, [cell(C.Red), cell(C.Red), cell(C.Blue)], 0.5);
  assert.deepEqual(states, [
    { selector: 'id:a|0-1', color: C.Red, brightness: 0.5 },
    { selector: 'id:a|2-2', color: C.Blue, brightness: 0.5 },
  ]);
});

test('a schedule finds its pattern as it is now', () => {
  const savedPatterns = [{ id: 'p-candy', name: 'Candy', loop: [cell(C.Red), cell(C.White)], motion: { type: 'chase', speed: 0.5 } }];
  const prefs = { last: { name: 'Snow', cells: [cell(C.White)], effect: { type: 'breathe', speed: 0.2 } } };
  assert.equal(resolvePattern({ source: 'saved', id: 'p-candy' }, { savedPatterns }).name, 'Candy');
  assert.equal(resolvePattern({ source: 'saved', id: 'p-gone' }, { savedPatterns }), null);
  assert.equal(resolvePattern({ source: 'builtin', id: 'b-xmas' }, {}).name, '🎄 Christmas');
  const last = resolvePattern({ source: 'last' }, { prefs });
  assert.equal(last.name, 'Snow');
  assert.equal(last.motion.type, 'breathe');
  assert.equal(resolvePattern({ source: 'last' }, { prefs: {} }), null, 'nothing played yet');
  // Older schedules had only a name.
  assert.equal(resolvePattern({ name: 'Candy' }, { savedPatterns }).id, 'p-candy');
  assert.equal(resolvePattern({ name: '🎄 Christmas' }, {}).id, 'b-xmas');
});

test('expanding a pattern gives states in strip order plus its motion', () => {
  const out = expandPattern({ id: 'p-1', name: 'Two', loop: [cell(C.Red), cell(C.Blue)], motion: { type: 'chase', dir: 'backward', speed: 1 } }, [A, B], { order: ['b', 'a'] });
  assert.deepEqual(out.states.map(s => s.selector), ['id:b|0-0', 'id:b|1-1', 'id:a|0-0', 'id:a|1-1', 'id:a|2-2']);
  assert.deepEqual(motionRequest(out.motion), { effect: 'move', body: { direction: 'backward', period: 0.3, power_on: true } });
});

test('old motion formats still read correctly', () => {
  assert.equal(normalizeMotion('chase-back').dir, 'backward');
  assert.equal(normalizeMotion('pulse', { speed: 'fast' }).speed, 0.8);
  assert.equal(motionRequest(normalizeMotion('none')), null);
});
