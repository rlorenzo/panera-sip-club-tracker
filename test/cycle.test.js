import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleFor, isoDate, levelFor, paceFor } from '../src/cycle.js';

const ANCHOR = '2026-07-12';
const at = (iso) => new Date(iso).getTime();

test('the documented fixture: 2026-07-12 anchor evaluated 2026-08-15', () => {
  const c = cycleFor(ANCHOR, at('2026-08-15T17:40:00Z'));
  assert.equal(isoDate(c.start), '2026-08-11');
  assert.equal(isoDate(c.end), '2026-09-09');
  assert.equal(c.day, 5);
  assert.equal(c.daysLeft, 25);
});

test('day and daysLeft always sum to the period length', () => {
  for (let d = 0; d < 30; d += 1) {
    const c = cycleFor(ANCHOR, at('2026-08-11T00:00:00Z') + d * 86_400_000 + 3600_000);
    assert.equal(c.day + c.daysLeft, 30, `day ${d}`);
  }
});

test('exact anchor instant is day 1 of the first period', () => {
  const c = cycleFor(ANCHOR, at('2026-07-12T00:00:00Z'));
  assert.equal(isoDate(c.start), '2026-07-12');
  assert.equal(c.day, 1);
  assert.equal(c.daysLeft, 29);
});

test('last millisecond of a period is day 30', () => {
  const c = cycleFor(ANCHOR, at('2026-08-10T23:59:59.999Z'));
  assert.equal(isoDate(c.start), '2026-07-12');
  assert.equal(isoDate(c.end), '2026-08-10');
  assert.equal(c.day, 30);
  assert.equal(c.daysLeft, 0);
});

test('first millisecond of the next period rolls over', () => {
  const c = cycleFor(ANCHOR, at('2026-08-11T00:00:00.000Z'));
  assert.equal(isoDate(c.start), '2026-08-11');
  assert.equal(c.day, 1);
});

test('the period boundary is contiguous: no gap, no overlap', () => {
  const before = cycleFor(ANCHOR, at('2026-08-10T23:59:59.999Z'));
  const after = cycleFor(ANCHOR, at('2026-08-11T00:00:00.000Z'));
  assert.equal(before.endExclusive.getTime(), after.start.getTime());
});

test('instants before the anchor clamp to the first period', () => {
  const c = cycleFor(ANCHOR, at('2026-07-01T00:00:00Z'));
  assert.equal(isoDate(c.start), '2026-07-12');
  assert.equal(c.day, 1);
});

test('a bad anchor is rejected rather than silently producing NaN dates', () => {
  assert.throws(() => cycleFor('not-a-date'), /bad anchor date/);
});

test('pace projects to the end of the period from elapsed days', () => {
  assert.equal(paceFor(6, 5), 36);
  assert.equal(paceFor(1, 1), 30);
  assert.equal(paceFor(30, 30), 30);
  assert.equal(paceFor(0, 5), 0);
});

test('levels escalate on count first and projection second', () => {
  assert.equal(levelFor(30, 20), 'hit');
  assert.equal(levelFor(31, 20), 'hit');
  assert.equal(levelFor(27, 20), 'warn');
  assert.equal(levelFor(6, 5), 'pace');
  // 26 in 26 days projects to exactly 30 — on track, not a warning.
  assert.equal(levelFor(26, 26), 'ok');
  assert.equal(levelFor(5, 5), 'ok');
});
