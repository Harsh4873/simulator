import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseLedger, serializeLedger } from '../src/pick-ledger.ts';
import { buildRecord, gradeRow, listed, MIN_TIER_LEANS, tierFor, type Lean, type LedgerFile, type LedgerRow } from '../src/picks.ts';
import {
  applyCalibration,
  blendWithMarket,
  calibrationMetrics,
  driftAction,
  expectedCalibrationError,
  fitBeta,
  fitBlendWeight,
  fitIsotonic,
  fitPlatt,
  fitTemperature,
  groupOf,
  meanBiasCorrection,
  rowsFromLedger,
  selectMethod,
  splitChronological,
  splitTipDates,
  type PropCalibrationCard,
  type PropCalibrationParams,
  type PropCalibrationRow,
} from '../src/prop-calibration.ts';
import { executeCalibration, refuseNonLive } from '../scripts/fit-prop-calibration.ts';
import { mulberry32 } from '../src/rng.ts';
import { PROP_POLICY } from '../src/props.ts';

const sigmoid = (value: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const logit = (p: number) => {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
};

function row(partial: Partial<PropCalibrationRow> & Pick<PropCalibrationRow, 'p' | 'y'>): PropCalibrationRow {
  return {
    date: '2026-11-15',
    key: 'e:a',
    group: 'points',
    market: 'pts',
    noVig: 0.5,
    lineAgeMinutes: 12,
    lineMoved: false,
    ...partial,
  };
}

function datedRows(count: number, seed: number, draw: (rng: () => number, index: number) => { p: number; y: 0 | 1 }): PropCalibrationRow[] {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, (_, index) => {
    const outcome = draw(rng, index);
    return row({
      date: `2026-03-${String((index % 20) + 1).padStart(2, '0')}`,
      key: `e:${index}`,
      p: outcome.p,
      y: outcome.y,
    });
  });
}

function grid(): number[] {
  const values: number[] = [];
  for (let p = 0.01; p <= 0.991; p += 0.04) values.push(Number(p.toFixed(2)));
  return values;
}

function assertMonotone(params: PropCalibrationParams): void {
  let previous = -1;
  for (const p of grid()) {
    const value = applyCalibration(params, p);
    assert.ok(value + 1e-12 >= previous, `${params.method} ${p} -> ${value} after ${previous}`);
    previous = value;
  }
}

function loadLedgers(): LedgerFile[] {
  return readdirSync('data/pick-ledger')
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseLedger(readFileSync(join('data/pick-ledger', name), 'utf8')));
}

test('Platt recovers a slope near one third on a synthetic overconfident sample', () => {
  const rows = datedRows(2000, 1, (rng) => {
    const truth = 0.2 + 0.6 * rng();
    return { p: sigmoid(3 * logit(truth)), y: rng() < truth ? 1 : 0 };
  });
  const platt = fitPlatt(rows.slice(0, 1000));
  assert.ok(platt.b >= 0.28 && platt.b <= 0.39, `slope ${platt.b}`);
  assert.ok(platt.a >= -0.1 && platt.a <= 0.1, `intercept ${platt.a}`);
  const params: PropCalibrationParams = { method: 'platt', platt };
  const hold = rows.slice(1000);
  const calibrated = calibrationMetrics(hold, (item) => applyCalibration(params, item.p));
  const raw = calibrationMetrics(hold, (item) => item.p);
  assert.ok(calibrated.eceWidth10 < 0.02, `ece ${calibrated.eceWidth10}`);
  assert.ok(calibrated.logLoss <= raw.logLoss - 0.03, `loss ${calibrated.logLoss} vs ${raw.logLoss}`);
});

test('beta stays near the identity when the raw probability is already the truth', () => {
  const rows = datedRows(2000, 19, (rng) => {
    const p = 0.05 + 0.9 * rng();
    return { p, y: rng() < p ? 1 : 0 };
  });
  const beta = fitBeta(rows);
  const params: PropCalibrationParams = { method: 'beta', beta };
  for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    assert.ok(Math.abs(applyCalibration(params, p) - p) < 0.02, `${p} -> ${applyCalibration(params, p)}`);
  }
});

test('temperature 3.9 moves 0.74 to about 0.567 and 0.64 to about 0.537', () => {
  const params: PropCalibrationParams = { method: 'temperature', temperature: 3.9 };
  assert.ok(Math.abs(applyCalibration(params, 0.74) - 0.567) < 0.001);
  assert.ok(Math.abs(applyCalibration(params, 0.64) - 0.537) < 0.001);
});

test('the beta formula is applied as written, and a negative coefficient is clamped above zero', () => {
  // Formula check of the unconstrained map. Not a fit of the live ledger.
  const formula: PropCalibrationParams = { method: 'beta', beta: { a: -0.106, b: 0.627, c: -0.476 } };
  const direct = (p: number) => {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
    const x = -0.476 - 0.106 * Math.log(q) - 0.627 * Math.log(1 - q);
    return sigmoid(x);
  };
  assert.ok(Math.abs(applyCalibration(formula, 0.74) - direct(0.74)) < 1e-9);
  assert.ok(Math.abs(applyCalibration(formula, 0.74) - 0.6) < 0.01);
  assert.ok(Math.abs(applyCalibration(formula, 0.64) - 0.55) < 0.01);

  const reversed = datedRows(1600, 13, (rng, index) => {
    const p = index % 2 === 0 ? 0.2 : 0.8;
    const truth = p === 0.2 ? 0.85 : 0.15;
    return { p, y: rng() < truth ? 1 : 0 };
  });
  const beta = fitBeta(reversed);
  assert.ok(beta.a >= 0 && beta.b >= 0, `a ${beta.a} b ${beta.b}`);
  const fitted: PropCalibrationParams = { method: 'beta', beta };
  assert.ok(applyCalibration(fitted, 0.2) <= applyCalibration(fitted, 0.8));
  let previous = -1;
  for (const p of grid()) {
    const value = applyCalibration(fitted, p);
    assert.ok(value + 1e-12 >= previous, `beta ${p} -> ${value} after ${previous}`);
    previous = value;
  }
  const selected = selectMethod(reversed.slice(0, 1000), reversed.slice(1000));
  assert.match(selected.reason ?? '', /clamp/i);
  assert.ok(applyCalibration(selected.params, 0.2) <= applyCalibration(selected.params, 0.8));
  previous = -1;
  for (const p of grid()) {
    const value = applyCalibration(selected.params, p);
    assert.ok(value + 1e-12 >= previous, `${selected.method} ${p} -> ${value} after ${previous}`);
    previous = value;
  }
});

test('Nov 15 through Nov 18 have the settled counts on disk', () => {
  const nov15 = parseLedger(readFileSync('data/pick-ledger/2026-11-15.json', 'utf8'));
  const nov16 = parseLedger(readFileSync('data/pick-ledger/2026-11-16.json', 'utf8'));
  assert.equal(nov15.rows.length, 790);
  assert.equal(nov15.source, 'live');
  const voids = nov15.rows.filter((item) => item.result && 'void' in item.result).length;
  const pushes = nov15.rows.filter((item) => item.result && !('void' in item.result) && item.result.actual === (item.last ?? item.open).line).length;
  const settled = nov15.rows.filter((item) => item.result && !('void' in item.result) && item.result.actual !== (item.last ?? item.open).line).length;
  assert.equal(voids, 50);
  assert.equal(pushes, 0);
  assert.equal(settled, 740);
  const qualified = rowsFromLedger([nov15]);
  assert.equal(qualified.length, settled - nov15.rows.filter((item) => item.result && !('void' in item.result) && item.result.actual !== (item.last ?? item.open).line && !groupOf(item.m)).length);
  assert.equal(qualified.length, 735);
  assert.equal(nov16.source, 'live');
  assert.equal(nov16.rows.length, 796);
  const nov16Settled = nov16.rows.filter((item) => item.result && !('void' in item.result) && item.result.actual !== (item.last ?? item.open).line).length;
  const nov16Voids = nov16.rows.filter((item) => item.result && 'void' in item.result).length;
  assert.equal(nov16Settled, 764);
  assert.equal(nov16Voids, 32);
  const nov17 = parseLedger(readFileSync('data/pick-ledger/2026-11-17.json', 'utf8'));
  const nov18 = parseLedger(readFileSync('data/pick-ledger/2026-11-18.json', 'utf8'));
  assert.equal(nov17.source, 'live');
  assert.equal(nov17.rows.filter((item) => item.result && !('void' in item.result) && item.result.actual !== (item.last ?? item.open).line).length, 482);
  assert.equal(nov18.source, 'live');
  assert.equal(nov18.rows.filter((item) => item.result).length, 0);
  assert.equal(splitTipDates(['2026-11-15']), null);
});

test('a map fitted after the tip grades raw, and a map fitted before the tip moves the probability', () => {
  const ledgerRow: LedgerRow = {
    e: 'e1',
    a: 'p1',
    m: 'pts',
    name: 'Player',
    team: 't',
    tip: '2026-11-16T18:00:00Z',
    book: 'DraftKings',
    model_hash: 'hash-1',
    open: { at: '2026-11-16T16:00:00Z', priced_at: '2026-11-16T15:00:00Z', line: 10.5, over: -110, under: -110, p: 0.8, play: 0.95, min: 30 },
    result: { actual: 20, min: 30 },
  };
  const file: LedgerFile = { schema_version: 1, date: '2026-11-16', source: 'live', rows: [ledgerRow] };
  const card = (fittedThrough: string): PropCalibrationCard => ({
    group: 'points',
    method: 'temperature',
    status: 'fitted',
    model_version: 'hash-1',
    fitted_through: fittedThrough,
    params: { method: 'temperature', temperature: 4 },
    w: 1,
  });
  const late = new Map([['points' as const, card('2026-11-17')]]);
  const early = new Map([['points' as const, card('2026-11-15')]]);
  const raw = gradeRow(ledgerRow, file.date, true)!;
  const after = gradeRow(ledgerRow, file.date, true, late)!;
  const before = gradeRow(ledgerRow, file.date, true, early)!;
  assert.equal(ledgerRow.open.p, 0.8);
  assert.equal(after.calibrated, false);
  assert.equal(after.claimed, raw.claimed);
  assert.equal(before.calibrated, true);
  assert.notEqual(before.claimed, raw.claimed);
  const uncalibrated = buildRecord([file], late);
  assert.equal(uncalibrated.settled, 1);
  assert.equal(uncalibrated.gradedUncalibrated, 1);
  assert.equal(buildRecord([file], early).gradedUncalibrated, 0);
  const without = { ...ledgerRow };
  delete without.model_hash;
  assert.equal(gradeRow(without, file.date, true, early)!.calibrated, false);
});

test('a player-game stays on one side of a date split, and clusters count keys', () => {
  const markets = ['pts', 'pra', 'pa', 'pr', 'reb', 'ast', 'ra'] as const;
  const same = markets.map((market) => row({ date: '2026-11-15', key: 'game:player', market, p: 0.4, y: 1 }));
  const other = row({ date: '2026-11-16', key: 'game:other', market: 'pts', p: 0.6, y: 0 });
  const split = splitChronological([...same, other], '2026-11-15');
  assert.equal(split.fit.length, 7);
  assert.equal(split.validation.length, 1);
  assert.equal(split.fit.some((item) => item.key === 'game:other'), false);
  assert.throws(() => splitChronological([row({ date: '2026-11-15', key: 'game:player', p: 0.4, y: 1 }), row({ date: '2026-11-16', key: 'game:player', p: 0.4, y: 0 })], '2026-11-15'));
  const metrics = calibrationMetrics(same, (item) => item.p);
  assert.equal(metrics.n, 7);
  assert.equal(metrics.clusters, 1);
});

test('voids and pushes contribute no calibration rows', () => {
  const base: LedgerRow = {
    e: 'e',
    a: 'a',
    m: 'pts',
    name: 'A',
    team: 't',
    tip: '2026-11-15T18:00:00Z',
    book: 'DraftKings',
    open: { at: '2026-11-15T16:00:00Z', priced_at: '2026-11-15T15:00:00Z', line: 10.5, over: -110, under: -110, p: 0.6, play: 0.9, min: 30 },
  };
  const file: LedgerFile = {
    schema_version: 1,
    date: '2026-11-15',
    source: 'live',
    rows: [
      { ...base, a: 'void', result: { void: 'dnp' } },
      { ...base, a: 'push', result: { actual: 10.5, min: 30 } },
      { ...base, a: 'win', result: { actual: 14, min: 30 } },
      { ...base, a: 'old', open: { ...base.open, at: '2026-11-15T16:40:00Z' }, result: { actual: 8, min: 20 } },
    ],
  };
  const before = JSON.stringify(file);
  const qualified = rowsFromLedger([file]);
  assert.equal(qualified.length, 2);
  assert.equal(JSON.stringify(file), before);
  assert.ok(qualified.some((item) => item.lineAgeMinutes > 30));
  assert.equal(rowsFromLedger([{ ...file, source: 'replay' }]).length, 0);
  const nov15 = parseLedger(readFileSync('data/pick-ledger/2026-11-15.json', 'utf8'));
  assert.equal(nov15.rows.length, 790);
  assert.equal(rowsFromLedger([nov15]).length, 735);
});

test('the blend is the weighted average, a flat curve keeps 0.2, and a sloped curve keeps the argmin', () => {
  assert.equal(blendWithMarket(0.6, 0.5, 0), 0.5);
  assert.equal(blendWithMarket(0.6, 0.5, 1), 0.6);
  assert.throws(() => blendWithMarket(0.6, 0.5, -0.1));
  assert.throws(() => blendWithMarket(0.6, 0.5, 1.1));
  const flat = datedRows(40, 14, () => ({ p: 0.55, y: 1 }));
  assert.equal(fitBlendWeight(flat, (item) => item.noVig), 0.2);
  const sloped = Array.from({ length: 40 }, (_, index) => row({ key: `e:${index}`, y: index < 20 ? 1 : 0, noVig: 0.5, p: 0.5 }));
  assert.equal(fitBlendWeight(sloped, (item) => (item.y === 1 ? 0.85 : 0.15)), 1);
});

test('each fitted map is non-decreasing, and isotonic collapses at least two inputs', () => {
  const rows = datedRows(1200, 15, (rng) => {
    const p = 0.05 + 0.9 * rng();
    return { p, y: rng() < p ? 1 : 0 };
  });
  const support = { lo: Math.min(...rows.map((item) => item.p)), hi: Math.max(...rows.map((item) => item.p)) };
  const maps: PropCalibrationParams[] = [
    { method: 'platt', platt: fitPlatt(rows), support },
    { method: 'beta', beta: fitBeta(rows), support },
    { method: 'temperature', temperature: fitTemperature(rows), support },
  ];
  const knots = fitIsotonic(rows);
  assert.ok(knots);
  maps.push({ method: 'isotonic', isotonic: knots, support });
  assert.equal(fitIsotonic(rows.slice(0, 500)), null);
  for (const params of maps) assertMonotone(params);
  const outputs = grid().map((p) => applyCalibration(maps[3], p));
  assert.ok(new Set(outputs.map((value) => value.toFixed(6))).size < outputs.length);
});

test('listing still reads pooled tiers while live pools are measured beside them', () => {
  const record = buildRecord(loadLedgers());
  assert.ok(record.tiersLive.length > 0);
  assert.equal(Math.max(...record.tiersLive.map((tier) => tier.pooled)), 784);
  assert.ok(record.tiersLive.some((tier) => tier.pooled >= MIN_TIER_LEANS));
  const under = tierFor(record, 'under', 0.16)!;
  assert.equal(under.edge, 0.044);
  assert.equal(under.pooled, 373);
  const weaker = tierFor(record, 'under', 0.07)!;
  assert.equal(weaker.edge, 0.0085);
  const lean: Lean = {
    event_id: 'e',
    athlete_id: 'a',
    name: 'Under',
    matchup: 'A @ B',
    tip: '2026-11-18T00:00:00Z',
    market: 'pts',
    line: 10.5,
    over_odds: -110,
    under_odds: -110,
    book: 'DraftKings',
    priced_at: '2026-11-18T00:00:00Z',
    side: 'under',
    model: 0.4,
    need: 0.52,
    claimed: 0.16,
    projection: 12,
    minutes: 30,
    play: 0.95,
  };
  assert.equal(listed(lean, record), true);
  assert.equal(listed({ ...lean, claimed: 0.07 }, record), false);
});

test('the release gate uses the 10-bin ECE fields, and the Nov 15 raw ECE is above 0.03', () => {
  const rows = rowsFromLedger([parseLedger(readFileSync('data/pick-ledger/2026-11-15.json', 'utf8'))]);
  const width5 = expectedCalibrationError(rows, (item) => item.p, 5, 'width');
  const width10 = expectedCalibrationError(rows, (item) => item.p, 10, 'width');
  const width20 = expectedCalibrationError(rows, (item) => item.p, 20, 'width');
  const metrics = calibrationMetrics(rows, (item) => item.p);
  assert.equal(metrics.eceWidth10, width10);
  assert.equal(typeof metrics.eceFreq10, 'number');
  assert.ok(metrics.eceWidth10 > 0.03);
  assert.equal('eceWidth5' in metrics, false);
  assert.equal('eceWidth20' in metrics, false);
  assert.ok(Number.isFinite(width5) && Number.isFinite(width20));
  assert.equal(PROP_POLICY.calibrated, false);
});

test('mean-bias correction recovers a low projection, and ledger rows have no projection', () => {
  const rng = mulberry32(16);
  const made: { projection: number; actual: number; tier: string; date: string }[] = [];
  for (let day = 1; day <= 20; day += 1) {
    for (let index = 0; index < 40; index += 1) {
      const actual = 12 + rng() * 16;
      made.push({ projection: actual * 0.943 + (rng() - 0.5) * 0.2, actual, tier: 'top2', date: `2026-04-${String(day).padStart(2, '0')}` });
    }
  }
  const fitted = meanBiasCorrection(made).get('top2');
  assert.ok(fitted);
  assert.ok(fitted.beta >= 1.04 && fitted.beta <= 1.08, `beta ${fitted.beta}`);
  const fresh = mulberry32(17);
  let gap = 0;
  let actualSum = 0;
  for (let index = 0; index < 400; index += 1) {
    const actual = 12 + fresh() * 16;
    const projection = actual * 0.943 + (fresh() - 0.5) * 0.2;
    gap += fitted.alpha + fitted.beta * projection - actual;
    actualSum += actual;
  }
  assert.ok(Math.abs(gap / actualSum) <= 0.01, `bias ${gap / actualSum}`);
  const sample = rowsFromLedger([parseLedger(readFileSync('data/pick-ledger/2026-11-15.json', 'utf8'))])[0];
  assert.equal('projection' in sample, false);
});

test('the fit refuses this ledger and writes no group file', () => {
  const files = loadLedgers();
  const replay = files.find((file) => file.source === 'replay');
  assert.ok(replay);
  assert.throws(() => refuseNonLive([replay]), /replay/);
  const live = files.filter((file) => file.source === 'live');
  const dir = mkdtempSync(join(tmpdir(), 'prop-cal-'));
  const result = executeCalibration(live, { outDir: dir, directory: files });
  assert.equal(result.action, 'refused');
  assert.deepEqual(result.artifacts, []);
  assert.equal(readdirSync(dir).some((name) => name.endsWith('.json')), false);
  const report = readFileSync(result.reportPath, 'utf8');
  assert.match(report, /1,986/);
  assert.match(report, /calibrated stays false/);
  assert.match(report, /Mean-bias checks were not run/);
  assert.match(report, /No map was fitted/);
  assert.doesNotMatch(report, /The gap is material/);
  assert.equal(result.settledNonPush, 1986);
  assert.equal(result.qualifying, 1879);
});

test('drift is red above ECE 0.05 and green when every signal is inside its bound', () => {
  assert.equal(
    driftAction({ eceWidth10: 0.06, eceFreq10: 0.02, slopeLo: 0.8, slopeHi: 1.2, interceptLo: -0.02, interceptHi: 0.02, tierEdge: 0.01 }),
    'red',
  );
  assert.equal(
    driftAction({ eceWidth10: 0.02, eceFreq10: 0.02, slopeLo: 0.8, slopeHi: 1.2, interceptLo: -0.02, interceptHi: 0.02, tierEdge: 0.01 }),
    'green',
  );
});

test('a logged model hash survives the ledger file and is absent unless it was provided', () => {
  const row: LedgerRow = {
    e: 'e',
    a: 'a',
    m: 'pts',
    name: 'A',
    team: 't',
    tip: '2026-11-16T18:00:00Z',
    book: 'DraftKings',
    model_hash: 'abc',
    open: { at: '2026-11-16T16:00:00Z', priced_at: '2026-11-16T15:00:00Z', line: 10.5, over: -110, under: -110, p: 0.55, play: 0.9, min: 28 },
  };
  const parsed = parseLedger(serializeLedger({ schema_version: 1, date: '2026-11-16', source: 'live', rows: [row] }));
  assert.equal(parsed.rows[0].model_hash, 'abc');
  const plain = { ...row };
  delete plain.model_hash;
  const stripped = parseLedger(serializeLedger({ schema_version: 1, date: '2026-11-16', source: 'live', rows: [plain] }));
  assert.equal(stripped.rows[0].model_hash, undefined);
});
