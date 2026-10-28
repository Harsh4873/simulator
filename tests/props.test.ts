import assert from 'node:assert/strict';
import test from 'node:test';
import {
  americanBreakEven,
  fairAmericanOdds,
  gradeProp,
  quoteProp,
  type PlayerSample,
} from '../src/props.ts';

function sample(rows: { min: number; pts: number; reb: number; ast: number; tpm: number }[]): PlayerSample {
  return {
    min: rows.map((row) => row.min),
    pts: rows.map((row) => row.pts),
    reb: rows.map((row) => row.reb),
    ast: rows.map((row) => row.ast),
    tpm: rows.map((row) => row.tpm),
  };
}

const played = (pts: number, reb = 0, ast = 0, tpm = 0) => ({ min: 30, pts, reb, ast, tpm });

test('half-point lines do not push and whole-number lines do', () => {
  const rows = [played(35), played(34), played(34), played(10)];
  const overHalf = gradeProp(sample(rows), 'pts', 'over', 34.5);
  assert.deepEqual(overHalf, { wins: 1, losses: 3, pushes: 0, voids: 0 });
  const overWhole = gradeProp(sample(rows), 'pts', 'over', 34);
  assert.deepEqual(overWhole, { wins: 1, losses: 1, pushes: 2, voids: 0 });
  const underWhole = gradeProp(sample(rows), 'pts', 'under', 34);
  assert.deepEqual(underWhole, { wins: 1, losses: 1, pushes: 2, voids: 0 });
});

test('a player who does not play is void, not a loss', () => {
  const rows = [{ min: 0, pts: 0, reb: 0, ast: 0, tpm: 0 }, played(40)];
  const grade = gradeProp(sample(rows), 'pts', 'over', 34.5);
  assert.deepEqual(grade, { wins: 1, losses: 0, pushes: 0, voids: 1 });
});

test('PRA uses the same draw for points, rebounds and assists', () => {
  const rows = [played(20, 10, 5), played(10, 10, 10)];
  const grade = gradeProp(sample(rows), 'pra', 'over', 34.5);
  assert.deepEqual(grade, { wins: 1, losses: 1, pushes: 0, voids: 0 });
  const separate = gradeProp(sample([played(30, 0, 0), played(0, 30, 0), played(0, 0, 30)]), 'pra', 'over', 34.5);
  assert.equal(separate.wins, 0);
});

test('American odds break-even, return, fair price and no-vig', () => {
  assert.equal(americanBreakEven(-110), 110 / 210);
  assert.equal(americanBreakEven(125), 100 / 225);
  assert.equal(americanBreakEven(50), null);
  assert.equal(americanBreakEven(-50), null);
  const rows = Array.from({ length: 10 }, (_, index) => played(index < 6 ? 40 : 10));
  const quote = quoteProp(sample(rows), 'pts', 'over', 34.5, -110, -110);
  assert.ok(quote);
  assert.equal(quote.modelProbability, 0.6);
  assert.equal(quote.breakEven, 110 / 210);
  assert.ok(quote.edge !== null && quote.edge > 0);
  assert.equal(quote.noVig, 0.5);
  assert.equal(quote.expectedReturn, (6 * (100 / 110) - 4) / 10);
  assert.equal(fairAmericanOdds(0.6), -150);
  assert.equal(fairAmericanOdds(0.4), 150);
});

test('the quote does not depend on which example game is on screen', () => {
  const rows = [played(40), played(10), played(40)];
  const first = quoteProp(sample(rows), 'pts', 'over', 34.5, -110);
  const second = quoteProp(sample(rows), 'pts', 'over', 34.5, -110);
  assert.deepEqual(first, second);
  assert.equal(quoteProp(null, 'pts', 'over', 34.5, -110), null);
  assert.equal(quoteProp(sample([]), 'pts', 'over', 34.5, -110), null);
});
