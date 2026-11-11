import assert from 'node:assert/strict';
import test from 'node:test';
import { chicagoDate, formatTip, recentChicagoDates, shiftChicagoDate } from '../src/date.ts';

test('a 03:00Z tip is still the previous Chicago date', () => {
  assert.equal(chicagoDate(new Date('2026-10-28T03:00:00Z')), '2026-10-27');
  assert.equal(chicagoDate(new Date('2026-10-27T05:00:00Z')), '2026-10-27');
  assert.equal(chicagoDate(new Date('2026-10-27T04:59:00Z')), '2026-10-26');
});

test('the published window is yesterday and today across the daylight change', () => {
  assert.equal(shiftChicagoDate('2026-11-11', -1), '2026-11-10');
  assert.equal(shiftChicagoDate('2026-03-09', -1), '2026-03-08');
  assert.equal(shiftChicagoDate('2026-11-02', -1), '2026-11-01');
  assert.deepEqual(recentChicagoDates('2026-11-11'), ['2026-11-10', '2026-11-11']);
});

test('tip copy uses the Chicago clock', () => {
  const tip = formatTip('2026-10-27T23:30:00Z');
  assert.match(tip, /Oct/);
  assert.match(tip, /27/);
  assert.match(tip, /6:30/);
  assert.match(tip, /CDT/);
});
