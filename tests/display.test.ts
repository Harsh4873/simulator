import assert from 'node:assert/strict';
import test from 'node:test';
import { empiricalPercent, nextPanelAthlete, shownPercent, typicalityBucket, winCounts } from '../src/display.ts';

test('empirical percent is the share at or below the shown integer', () => {
  assert.equal(empiricalPercent([], 4), 50);
  assert.equal(empiricalPercent([1, 2, 2, 4], 2), 75);
  assert.equal(empiricalPercent([1, 2, 2, 4], 0), 0);
  assert.equal(empiricalPercent([1, 2, 2, 4], 4), 100);
  assert.equal(shownPercent([1, 2, 2, 4], 2), 75);
  assert.equal(shownPercent([1, 2, 3], 1), 33);
  assert.equal(shownPercent([1, 2, 3], 2), 67);
});

test('typicality bucket is pure', () => {
  const cases: [number, boolean, number][] = [
    [50, false, 0],
    [43, false, 0],
    [57, false, 0],
    [42, false, 1],
    [58, false, 1],
    [35, false, 1],
    [65, false, 1],
    [34, false, 2],
    [66, false, 2],
    [26, false, 3],
    [74, false, 3],
    [18, false, 4],
    [82, false, 4],
    [10, false, 5],
    [90, false, 5],
    [4, false, 6],
    [96, false, 6],
    [0, false, 6],
    [100, false, 6],
    [100, true, 0],
    [0, true, 0],
  ];
  for (const [percent, constant, bucket] of cases) {
    assert.equal(typicalityBucket(percent, constant), bucket);
    assert.equal(typicalityBucket(percent, constant), typicalityBucket(percent, constant));
  }
});

test('win counts sum to the draws', () => {
  const away = [10, 8, 7, 5];
  const home = [9, 8, 9, 6];
  const counts = winCounts(away, home);
  assert.equal(counts.away + counts.tie + counts.home, away.length);
  assert.equal(counts.away, 1);
  assert.equal(counts.tie, 1);
  assert.equal(counts.home, 2);

  const manyAway = new Array<number>(10000).fill(5);
  const manyHome = new Array<number>(10000).fill(4);
  manyHome[0] = 5;
  manyHome[1] = 9;
  const many = winCounts(manyAway, manyHome);
  assert.equal(many.away + many.tie + many.home, 10000);
  assert.equal(many.tie, 1);
  assert.equal(many.home, 1);
  assert.equal(many.away, 9998);
});

test('the panel toggles, swaps, and closes', () => {
  assert.equal(nextPanelAthlete('a', 'a'), null);
  assert.equal(nextPanelAthlete('a', 'b'), 'b');
  assert.equal(nextPanelAthlete('a', null), null);
  assert.equal(nextPanelAthlete(null, 'b'), 'b');
});
