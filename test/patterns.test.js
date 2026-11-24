import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  C, cell, BUILTIN, positions, orderLights, patternCells, cellsToStates, resolvePattern, expandPattern, normalizeMotion, motionRequest,
} from '../public/shared/patterns.js';

const strip = (id, label, count) => ({ id, label, zones: { count }, product: { capabilities: { has_multizone: true } } });
const A = strip('a', 'Front', 3), B = strip('b', 'Garage', 2);

test('strips follow the saved order and direction, new strips go last', () => {
  const prefs = { order: ['b', 'a'], reversed: { b: true } };
  const lights = orderLights([A, B, strip('c', 'Back', 1)], prefs);
  assert.deepEqual(lights.map(l => l.id), ['b', 'a', 'c']);
  assert.deepEqual(positions(lights, prefs).map(p => `${p.light.id}${p.zone}`), ['b1', 'b0', 'a0', 'a1', 'a2', 'c0']);
});

test('built-in patterns honour lights per colour and gaps', () => {
  const xmas = BUILTIN.find(b => b.id === 'b-xmas');
  assert.deepEqual(patternCells(xmas, { width: 1, gaps: 'none' }, 4).map(x => x.c), [C.Red, C.Green, C.Red, C.Green]);
  assert.deepEqual(patternCells(xmas, { width: 2, gaps: 'off' }, 8).map(x => x.b), [1, 1, 0, 0, 1, 1, 0, 0]);
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
