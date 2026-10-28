import assert from 'node:assert/strict';
import test from 'node:test';
import {
  americanBreakEven,
  fairAmericanOdds,
  formatFairPrice,
  gradeProp,
  parseBookPrice,
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

test('a multiplier and a percent match the same American price', () => {
  const rows = Array.from({ length: 10 }, (_, index) => played(index < 6 ? 40 : 10));
  const american = quoteProp(sample(rows), 'pts', 'over', 34.5, -110, -110);
  const decimal = 210 / 110;
  const multiplier = parseBookPrice(String(decimal), 'multiplier');
  const percent = parseBookPrice(`${(110 / 210) * 100}%`, 'percent');
  assert.ok(american && multiplier && percent);
  const fromMultiplier = quoteProp(sample(rows), 'pts', 'over', 34.5, multiplier, multiplier);
  const fromPercent = quoteProp(sample(rows), 'pts', 'over', 34.5, percent, percent);
  assert.ok(fromMultiplier && fromPercent);
  assert.ok(Math.abs((fromMultiplier.breakEven ?? 0) - (american.breakEven ?? 0)) < 1e-12);
  assert.ok(Math.abs((fromPercent.breakEven ?? 0) - (american.breakEven ?? 0)) < 1e-12);
  assert.ok(Math.abs((fromMultiplier.expectedReturn ?? 0) - (american.expectedReturn ?? 0)) < 1e-12);
  assert.ok(Math.abs((fromPercent.expectedReturn ?? 0) - (american.expectedReturn ?? 0)) < 1e-12);
  assert.equal(fromMultiplier.noVig, 0.5);
  assert.equal(fromPercent.noVig, 0.5);
  assert.deepEqual(fromMultiplier.grade, american.grade);
  assert.equal(parseBookPrice('2.5x', 'american')?.breakEven, 0.4);
  assert.equal(parseBookPrice('2.5x', 'american')?.profit, 1.5);
  assert.equal(parseBookPrice('40%', 'multiplier')?.breakEven, 0.4);
  assert.ok(Math.abs((parseBookPrice('40', 'percent')?.profit ?? 0) - 1.5) < 1e-12);
  assert.equal(parseBookPrice('0.4', 'percent')?.breakEven, 0.4);
  assert.equal(parseBookPrice('-110', 'percent')?.breakEven, 110 / 210);
  assert.equal(parseBookPrice('1', 'multiplier'), null);
  assert.equal(parseBookPrice('0.91', 'multiplier'), null);
  assert.equal(parseBookPrice('0', 'percent'), null);
  assert.equal(parseBookPrice('100', 'percent'), null);
  assert.equal(parseBookPrice('150%', 'percent'), null);
  assert.equal(parseBookPrice('+10000', 'american')?.breakEven, 100 / 10100);
  assert.equal(parseBookPrice('101', 'multiplier')?.breakEven, 1 / 101);
  assert.equal(parseBookPrice('1%', 'percent')?.profit, 99);
  assert.equal(formatFairPrice(0.6, 'multiplier'), '1.6667x');
  assert.equal(formatFairPrice(0.6, 'percent'), '60%');
  assert.equal(formatFairPrice(0.6, 'american'), '-150');
});

test('the quote does not depend on which example game is on screen', () => {
  const rows = [played(40), played(10), played(40)];
  const first = quoteProp(sample(rows), 'pts', 'over', 34.5, -110);
  const second = quoteProp(sample(rows), 'pts', 'over', 34.5, -110);
  assert.deepEqual(first, second);
  assert.equal(quoteProp(null, 'pts', 'over', 34.5, -110), null);
  assert.equal(quoteProp(sample([]), 'pts', 'over', 34.5, -110), null);
});
