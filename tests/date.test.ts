import assert from 'node:assert/strict';
import test from 'node:test';
import { chicagoDate, formatTip } from '../src/date.ts';

test('a 03:00Z tip is still the previous Chicago date', () => {
  assert.equal(chicagoDate(new Date('2026-10-28T03:00:00Z')), '2026-10-27');
  assert.equal(chicagoDate(new Date('2026-10-27T05:00:00Z')), '2026-10-27');
  assert.equal(chicagoDate(new Date('2026-10-27T04:59:00Z')), '2026-10-26');
});

test('tip copy uses the Chicago clock', () => {
  const tip = formatTip('2026-10-27T23:30:00Z');
  assert.match(tip, /Oct/);
  assert.match(tip, /27/);
  assert.match(tip, /6:30/);
  assert.match(tip, /CDT/);
});
