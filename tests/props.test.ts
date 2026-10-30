import assert from 'node:assert/strict';
import test from 'node:test';
import {
  americanBreakEven,
  decideVerdict,
  fairAmericanOdds,
  formatFairPrice,
  gradeProp,
  parseBookPrice,
  PROP_POLICY,
  propContextFromPlayer,
  quoteProp,
  type PlayerSample,
  type PropContext,
  type PropPolicy,
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

const ready: PropContext = { available: true, missingShooting: false, thinSample: false, onCard: true };
const checked: PropPolicy = { ...PROP_POLICY, calibrated: true };

function counted(wins: number, losses: number, pushes = 0, voids = 0, line = 34.5): PlayerSample {
  const total = wins + losses + pushes + voids;
  const min = new Array<number>(total);
  const pts = new Array<number>(total);
  for (let index = 0; index < wins; index += 1) {
    min[index] = 30;
    pts[index] = line + 5;
  }
  for (let index = wins; index < wins + losses; index += 1) {
    min[index] = 30;
    pts[index] = Math.max(0, line - 5);
  }
  for (let index = wins + losses; index < wins + losses + pushes; index += 1) {
    min[index] = 30;
    pts[index] = line;
  }
  for (let index = wins + losses + pushes; index < total; index += 1) {
    min[index] = 0;
    pts[index] = 0;
  }
  return { min, pts, reb: pts, ast: pts, tpm: pts };
}

function verdictFor(
  rows: PlayerSample,
  odds: number | string,
  context: PropContext = ready,
  market: 'pts' | 'reb' = 'pts',
  policy: PropPolicy = PROP_POLICY,
  line = 34.5,
) {
  const price = typeof odds === 'number' ? odds : parseBookPrice(odds, 'percent');
  assert.ok(price);
  const quote = quoteProp(rows, market, 'over', line, price);
  assert.ok(quote);
  return { quote, verdict: decideVerdict(quote, context, market, policy) };
}

test('the shipped policy leans or passes and does not call a strong edge a bet', () => {
  assert.equal(PROP_POLICY.calibrated, false);
  const strong = verdictFor(counted(7000, 3000), -110);
  assert.equal(strong.verdict?.verdict, 'LEAN');
  assert.match(strong.verdict?.text ?? '', /not yet been historically calibrated/);
  const same = verdictFor(counted(7000, 3000), -110, ready, 'pts', checked);
  assert.equal(same.verdict?.verdict, 'LEAN'); // A manually toggled policy cannot certify calibration.
  const modest = verdictFor(counted(6000, 4000), -110, ready, 'pts', checked);
  assert.equal(modest.verdict?.verdict, 'LEAN');
  assert.match(modest.verdict?.text ?? '', /not yet been historically calibrated/);
  const example = verdictFor(counted(5800, 4200), -110);
  assert.equal(example.verdict?.verdict, 'LEAN');
  const coin = verdictFor(counted(5000, 5000), -110);
  assert.equal(coin.verdict?.verdict, 'PASS');
  assert.match(coin.verdict?.text ?? '', /do not clear this line/);
});

test('a huge gap is a reliability check, including after calibration', () => {
  const weird = verdictFor(counted(9900, 100), '36.5%', ready, 'pts', checked);
  assert.equal(weird.verdict?.verdict, 'PASS');
  assert.match(weird.verdict?.text ?? '', /reliability check/);
  const faded = verdictFor(counted(1000, 9000), -110, ready, 'pts', checked);
  assert.equal(faded.verdict?.verdict, 'PASS');
  assert.match(faded.verdict?.text ?? '', /reliability check/);
});

test('missing data, thin samples, and players who do not play cannot become a bet', () => {
  const noShots = verdictFor(counted(7000, 3000), -110, { ...ready, missingShooting: true }, 'pts', checked);
  assert.equal(noShots.verdict?.verdict, 'PASS');
  assert.match(noShots.verdict?.text ?? '', /prior/);
  const boards = verdictFor(counted(7000, 3000), -110, { ...ready, missingShooting: true }, 'reb', checked);
  assert.equal(boards.verdict?.verdict, 'LEAN');
  const thin = verdictFor(counted(7000, 3000), -110, { ...ready, thinSample: true }, 'pts', checked);
  assert.equal(thin.verdict?.verdict, 'LEAN');
  assert.match(thin.verdict?.text ?? '', /thin/);
  const out = verdictFor(counted(7000, 3000), -110, { ...ready, available: false }, 'pts', checked);
  assert.equal(out.verdict?.verdict, 'PASS');
  assert.match(out.verdict?.text ?? '', /does not play/);
  const absent = verdictFor(counted(7000, 3000), -110, { ...ready, onCard: false }, 'pts', checked);
  assert.equal(absent.verdict?.verdict, 'PASS');
  const sits = verdictFor(counted(1500, 500, 0, 8000), -110, ready, 'pts', checked);
  assert.equal(sits.verdict?.verdict, 'PASS');
  assert.match(sits.verdict?.text ?? '', /sits out/);
  assert.equal(propContextFromPlayer(null).onCard, false);
  assert.equal(propContextFromPlayer({ minutes_weight: 0, shooting_games: 12, thin_sample: false }).available, false);
});

test('pushes, tiny samples, noise, and invalid prices stay out of a recommendation', () => {
  const diluted = verdictFor(counted(250, 150, 9600, 0, 20), -110, ready, 'pts', checked, 20);
  assert.equal(diluted.quote.grade.pushes, 9600);
  assert.equal(diluted.verdict?.verdict, 'PASS');
  assert.match(diluted.verdict?.text ?? '', /pushes/);
  const short = verdictFor(counted(120, 40), -110, ready, 'pts', checked);
  assert.equal(short.verdict?.verdict, 'PASS');
  assert.match(short.verdict?.text ?? '', /Too few/);
  const noisy = verdictFor(counted(112, 88), -110, ready, 'pts', checked);
  assert.equal(noisy.verdict?.verdict, 'PASS');
  assert.match(noisy.verdict?.text ?? '', /sampling noise/);
  const bad = quoteProp(counted(7000, 3000), 'pts', 'over', 34.5, 50);
  assert.ok(bad);
  assert.equal(decideVerdict(bad, ready, 'pts', checked), null);
});

test('the sportsbook price does not change the simulated prop results', () => {
  const rows = counted(5800, 4200);
  const before = rows.pts[0];
  const american = quoteProp(rows, 'pts', 'over', 34.5, -110);
  const plus = quoteProp(rows, 'pts', 'over', 34.5, 250);
  const decimal = parseBookPrice('1.91x', 'american');
  assert.ok(decimal);
  const multiplier = quoteProp(rows, 'pts', 'over', 34.5, decimal);
  assert.ok(american && plus && multiplier);
  assert.deepEqual(american.grade, plus.grade);
  assert.deepEqual(american.grade, multiplier.grade);
  assert.equal(rows.pts[0], before);
  assert.equal(american.modelProbability, plus.modelProbability);
});

test('the quote does not depend on which example game is on screen', () => {
  const rows = [played(40), played(10), played(40)];
  const first = quoteProp(sample(rows), 'pts', 'over', 34.5, -110);
  const second = quoteProp(sample(rows), 'pts', 'over', 34.5, -110);
  assert.deepEqual(first, second);
  assert.equal(quoteProp(null, 'pts', 'over', 34.5, -110), null);
  assert.equal(quoteProp(sample([]), 'pts', 'over', 34.5, -110), null);
});
