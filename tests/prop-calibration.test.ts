import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseLedger, serializeLedger } from '../src/pick-ledger.ts';
import { buildRecord, gradeRow, listed, MIN_MEASURED_EDGE, MIN_PLAY_SHARE, MIN_TIER_LEANS, type Lean, type LedgerFile, type LedgerRow, type PickRecord } from '../src/picks.ts';
import {
  LEGACY_LEDGER_FAMILY,
  MAP_MAX_AGE_DAYS,
  MAX_WALK_FORWARD_FOLDS,
  applyCalibration,
  blendWithMarket,
  calibrationMetrics,
  driftAction,
  eceNoise,
  expectedCalibrationError,
  fitBeta,
  fitBlendWeight,
  fitIsotonic,
  fitPlatt,
  fitTemperature,
  groupOf,
  mapIsCurrent,
  meanBiasCorrection,
  previousHeldOutBest,
  recordHeldOutBest,
  rowsFromLedger,
  selectMethod,
  selectWalkForward,
  shippingCheck,
  splitChronological,
  splitTipDates,
  walkForwardFolds,
  type PropCalibrationArtifact,
  type PropCalibrationCard,
  type PropCalibrationMetrics,
  type PropCalibrationParams,
  type PropCalibrationRow,
} from '../src/prop-calibration.ts';
import { executeCalibration, refuseNonLive } from '../scripts/fit-prop-calibration.ts';
import { loadCalibration } from '../scripts/build-picks.ts';
import { renderPropResults } from '../src/boxscore.ts';
import { calibrationStatusHtml } from '../src/projections.ts';
import type { Simulation } from '../src/simulate.ts';
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

function sampleLean(): Lean {
  return {
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
}

function withUnderTier(record: PickRecord, patch: { pooled?: number; edge?: number }, table: 'tiers' | 'tiersLive' = 'tiers'): PickRecord {
  const next = record[table].map((tier) => (tier.side === 'under' && tier.lo === 0.15 ? { ...tier, ...patch } : tier));
  return table === 'tiersLive' ? { ...record, tiersLive: next } : { ...record, tiers: next };
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

test('Nov 15 through Nov 17 keep their settled counts, and Nov 18 stays a live file', () => {
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
  assert.ok(nov18.rows.length > 0);
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
    open: { at: '2026-11-16T16:00:00Z', priced_at: '2026-11-16T15:00:00Z', line: 10.5, over: -110, under: -110, p: 0.8, play: 0.95, min: 30, v: 'fam-1' },
    result: { actual: 20, min: 30 },
  };
  const file: LedgerFile = { schema_version: 1, date: '2026-11-16', source: 'live', rows: [ledgerRow] };
  const card = (fittedThrough: string, family = 'fam-1'): PropCalibrationCard => ({
    group: 'points',
    method: 'temperature',
    status: 'fitted',
    model_version: family,
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
  // The map grades only snapshots its own family made. The card hash plays no part.
  const otherFamily = { ...ledgerRow, open: { ...ledgerRow.open, v: 'fam-2' } };
  assert.equal(gradeRow(otherFamily, file.date, true, early)!.calibrated, false);
  const otherHash = { ...ledgerRow, model_hash: 'hash-2' };
  assert.equal(gradeRow(otherHash, file.date, true, early)!.calibrated, true);
  // A snapshot from before the family was stamped belongs to possessions-v9.
  const legacy = { ...ledgerRow, open: { ...ledgerRow.open } };
  delete legacy.open.v;
  assert.equal(gradeRow(legacy, file.date, true, early)!.calibrated, false);
  assert.equal(gradeRow(legacy, file.date, true, new Map([['points' as const, card('2026-11-15', LEGACY_LEDGER_FAMILY)]]))!.calibrated, true);
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

test('listing reads the live tier, and a passing pooled tier does not list on its own', () => {
  const record = buildRecord(loadLedgers());
  assert.equal(record.gradedUncalibrated, record.settled);
  assert.ok(record.tiersLive.length > 0);
  const lean = sampleLean();
  const pooledOnly = {
    ...withUnderTier(record, { pooled: MIN_TIER_LEANS, edge: MIN_MEASURED_EDGE }),
    tiersLive: record.tiersLive.map((tier) => ({ ...tier, pooled: 0, edge: -1 })),
  };
  assert.equal(listed(lean, pooledOnly), false);
  const liveOnly = withUnderTier(
    { ...record, tiers: record.tiers.map((tier) => (tier.side === 'under' && tier.lo === 0.15 ? { ...tier, pooled: 0, edge: -1 } : tier)) },
    { pooled: MIN_TIER_LEANS, edge: MIN_MEASURED_EDGE },
    'tiersLive',
  );
  assert.equal(listed(lean, liveOnly), true);
  assert.equal(listed(lean, withUnderTier(liveOnly, { edge: MIN_MEASURED_EDGE - 0.001 }, 'tiersLive')), false);
  assert.equal(listed({ ...lean, play: MIN_PLAY_SHARE - 0.01 }, liveOnly), false);
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

test('the live ledger fit refuses replay files, needs a family, and writes a status that matches its reason', () => {
  const files = loadLedgers();
  const replay = files.find((file) => file.source === 'replay');
  assert.ok(replay);
  assert.throws(() => refuseNonLive([replay]), /replay/);
  const live = files.filter((file) => file.source === 'live');
  const unkeyed = mkdtempSync(join(tmpdir(), 'prop-cal-'));
  const refused = executeCalibration(live, { outDir: unkeyed, directory: files });
  assert.equal(refused.action, 'refused');
  assert.equal(readdirSync(unkeyed).filter((name) => name.endsWith('.json')).length, 0);
  assert.match(readFileSync(refused.reportPath, 'utf8'), /model_version/);
  // Later days only add rows: the note check is a report line and never blocks the fit.
  const dir = mkdtempSync(join(tmpdir(), 'prop-cal-'));
  const result = executeCalibration(live, { outDir: dir, directory: files, modelVersion: LEGACY_LEDGER_FAMILY });
  const json = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(json.length, result.artifacts.length);
  const report = readFileSync(result.reportPath, 'utf8');
  assert.match(report, /Release note through 2026-11-17: 1,986/);
  assert.match(report, /It reproduces the note/);
  for (const name of json) {
    const artifact = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PropCalibrationArtifact;
    assert.equal(artifact.model_version, LEGACY_LEDGER_FAMILY);
    assert.equal(artifact.status === 'fitted', artifact.reason === null);
    assert.ok(artifact.fitted_through < artifact.validated_through);
    assertMonotone(artifact.params);
    assert.ok(artifact.notes?.some((note) => /Mean-bias/.test(note)));
  }
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

/** A live ledger from an overconfident model: the simulated chance is the truth pushed three times as far from even. */
function syntheticLedger(days: number, perDay: number, seed: number, family?: string): LedgerFile[] {
  const rng = mulberry32(seed);
  const files: LedgerFile[] = [];
  for (let day = 1; day <= days; day += 1) {
    const date = `2026-03-${String(day).padStart(2, '0')}`;
    const rows: LedgerRow[] = [];
    for (let index = 0; index < perDay; index += 1) {
      for (const m of ['pts', 'reb', 'tpm'] as const) {
        const truth = 0.3 + 0.4 * rng();
        const p = Number(sigmoid(3 * logit(truth)).toFixed(4));
        const over = rng() < truth;
        rows.push({
          e: `${date}-g${Math.floor(index / 10)}`,
          a: `p${index}`,
          m,
          name: `Player ${index}`,
          team: 't',
          tip: `${date}T23:00:00Z`,
          book: 'DraftKings',
          open: { at: `${date}T18:00:00Z`, priced_at: `${date}T17:00:00Z`, line: 10.5, over: -110, under: -110, p, play: 0.95, min: 30, ...(family ? { v: family } : {}) },
          result: { actual: over ? 12 : 9, min: 30 },
        });
      }
    }
    files.push({ schema_version: 1, date, source: 'live', rows });
  }
  return files;
}

test('a fit on an overconfident ledger ships maps that pull the chance toward even, and the picks step loads them', () => {
  const files = syntheticLedger(6, 120, 41, 'fam-1');
  const root = mkdtempSync(join(tmpdir(), 'prop-fit-'));
  const outDir = join(root, 'data/prop-calibration');
  const result = executeCalibration(files, { outDir, modelVersion: 'fam-1', now: new Date('2026-03-07T18:00:00Z') });
  assert.equal(result.action, 'written');
  assert.equal(result.artifacts.length, 3);
  for (const path of result.artifacts) {
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as PropCalibrationArtifact;
    assert.equal(artifact.status, 'fitted', `${artifact.group}: ${artifact.reason}`);
    // 120 rows a day: days 1-3 are the first 300 earlier rows, so days 4-6 are scored, and the shipped map is fitted
    // through day 5 and scored on day 6.
    assert.equal(artifact.validated_from, '2026-03-04');
    assert.equal(artifact.fitted_through, '2026-03-05');
    assert.equal(artifact.validated_through, '2026-03-06');
    assert.equal(artifact.rows_fit, 600);
    assert.equal(artifact.rows_validated, 360);
    assert.ok(artifact.metrics_validated.logLoss < artifact.metrics_raw!.logLoss);
    const high = applyCalibration(artifact.params, 0.8);
    assert.ok(high > 0.5 && high < 0.75, `${artifact.group} 0.8 -> ${high}`);
    assert.ok(artifact.w >= 0 && artifact.w <= 0.25);
    assert.equal(artifact.held_out_best?.length, 1);
    assert.equal(artifact.held_out_best?.[0].validated_through, '2026-03-06');
  }
  assert.match(readFileSync(result.reportPath, 'utf8'), /map applied/);
  assert.equal(loadCalibration(root, 'fam-1', '2026-03-07').size, 3);
  assert.equal(loadCalibration(root, 'fam-2', '2026-03-07').size, 0);
  assert.equal(loadCalibration(root, 'fam-1', '2026-03-20').size, 0);
  // Snapshots from another family are left out of the fit, so too few rows remain and the fit refuses.
  const other = executeCalibration(files, { outDir: mkdtempSync(join(tmpdir(), 'prop-fit-')), modelVersion: 'fam-2' });
  assert.equal(other.action, 'refused');
  assert.equal(other.qualifying, 0);
});

test('a model that is already calibrated keeps its raw chances: the map does not beat it on later games', () => {
  const rng = mulberry32(5);
  const files: LedgerFile[] = syntheticLedger(6, 120, 43).map((file) => ({
    ...file,
    rows: file.rows.map((item) => {
      const p = 0.3 + 0.4 * rng();
      return { ...item, open: { ...item.open, p: Number(p.toFixed(4)) }, result: { actual: rng() < p ? 12 : 9, min: 30 } };
    }),
  }));
  const outDir = mkdtempSync(join(tmpdir(), 'prop-fit-'));
  const result = executeCalibration(files, { outDir, modelVersion: LEGACY_LEDGER_FAMILY, now: new Date('2026-03-07T18:00:00Z') });
  assert.equal(result.action, 'written');
  for (const path of result.artifacts) {
    const artifact = JSON.parse(readFileSync(path, 'utf8')) as PropCalibrationArtifact;
    // Whatever ships here has to stay close to the identity; whatever is withheld says why.
    if (artifact.status === 'fitted') assert.ok(Math.abs(applyCalibration(artifact.params, 0.65) - 0.65) < 0.05);
    else assert.ok(artifact.reason && artifact.reason.length > 0);
  }
});

function metrics(patch: Partial<PropCalibrationMetrics>): PropCalibrationMetrics {
  return {
    n: 700, clusters: 200, eceWidth10: 0.03, eceFreq10: 0.05, mce: 0.1, brier: 0.249, brierNovig: 0.249, logLoss: 0.692, logLossNovig: 0.692,
    slope: 1, intercept: 0, slopeLo: 0.4, slopeHi: 1.8, interceptLo: -0.2, interceptHi: 0.2, reliability: 0.001, resolution: 0.001,
    ...patch,
  };
}

test('the shipping check withholds a map that loses to the raw simulation, and the 0.03 bar is a release note', () => {
  const noise = { width95: 0.04, width99: 0.05, freq95: 0.066, freq99: 0.08 };
  const raw = metrics({ logLoss: 0.708, brier: 0.2567, eceWidth10: 0.087, eceFreq10: 0.0915 });
  const calibrated = metrics({ logLoss: 0.6923, brier: 0.2496, eceWidth10: 0.0296, eceFreq10: 0.0542 });
  const blended = metrics({ logLoss: 0.6918, logLossNovig: 0.6918, brier: 0.2493, brierNovig: 0.2493 });
  const ok = shippingCheck({ raw, calibrated, blended, noise, validationRows: 742 });
  assert.deepEqual(ok.issues, []);
  assert.notEqual(ok.drift, 'red');
  assert.ok(ok.notes.some((note) => /0\.03 release bar/.test(note)));
  assert.ok(ok.notes.some((note) => /Brier/.test(note)));
  assert.match(shippingCheck({ raw, calibrated: { ...calibrated, logLoss: 0.71 }, blended, noise, validationRows: 742 }).issues.join(' '), /log loss/);
  assert.match(shippingCheck({ raw, calibrated: { ...calibrated, brier: 0.26 }, blended, noise, validationRows: 742 }).issues.join(' '), /Brier/);
  assert.match(shippingCheck({ raw, calibrated, blended: { ...blended, logLoss: 0.7 }, noise, validationRows: 742 }).issues.join(' '), /no-vig/);
  // A Cox interval miss is shared by the raw simulation, so it is a release note and the better map still ships.
  const cox = shippingCheck({ raw, calibrated: { ...calibrated, interceptLo: -0.57, interceptHi: -0.03 }, blended, noise, validationRows: 742 });
  assert.deepEqual(cox.issues, []);
  assert.match(cox.notes.join(' '), /Cox/);
  // Red drift keeps a map that still beats the raw numbers, and says listing stops.
  const red = shippingCheck({ raw: { ...raw, eceFreq10: 0.2 }, calibrated: { ...calibrated, eceFreq10: 0.12 }, blended, noise, validationRows: 742 });
  assert.equal(red.drift, 'red');
  assert.deepEqual(red.issues, []);
  assert.match(red.notes.join(' '), /not listed/);
});

test('a red map still moves the chance, but none of its leans are listed', () => {
  const record = buildRecord(loadLedgers());
  const passing = withUnderTier(
    { ...record, tiers: record.tiers },
    { pooled: MIN_TIER_LEANS, edge: MIN_MEASURED_EDGE },
    'tiersLive',
  );
  const lean = sampleLean();
  assert.equal(listed(lean, passing), true);
  assert.equal(listed({ ...lean, drift: 'amber' }, passing), true);
  assert.equal(listed({ ...lean, drift: 'red' }, passing), false);
  const card = (drift: 'green' | 'red'): PropCalibrationCard => ({
    group: 'points', method: 'temperature', status: 'fitted', model_version: LEGACY_LEDGER_FAMILY, fitted_through: '2026-11-10',
    params: { method: 'temperature', temperature: 2 }, w: 0.2, drift,
  });
  const ledgerRow: LedgerRow = {
    e: 'e1', a: 'p1', m: 'pts', name: 'Player', team: 't', tip: '2026-11-16T18:00:00Z', book: 'DraftKings',
    open: { at: '2026-11-16T16:00:00Z', priced_at: '2026-11-16T15:00:00Z', line: 10.5, over: -110, under: -110, p: 0.8, play: 0.95, min: 30 },
    result: { actual: 20, min: 30 },
  };
  const graded = gradeRow(ledgerRow, '2026-11-16', true, new Map([['points' as const, card('red')]]))!;
  assert.equal(graded.calibrated, true);
});

test('sampling noise alone puts 10-bin ECE above 0.03 on a few hundred lines near even', () => {
  const rng = mulberry32(8);
  const probabilities = Array.from({ length: 700 }, () => 0.45 + 0.1 * rng());
  const noise = eceNoise(probabilities);
  assert.ok(noise.freq95 > 0.03, `freq95 ${noise.freq95}`);
  assert.ok(noise.freq99 >= noise.freq95 && noise.width99 >= noise.width95);
  // A forecaster that is calibrated by construction lands under the 99th percentile in most samples.
  let under = 0;
  for (let sample = 0; sample < 20; sample += 1) {
    const rows = probabilities.map((p, index) => row({ key: `e:${index}`, p, y: rng() < p ? 1 : 0 }));
    if (expectedCalibrationError(rows, (item) => item.p, 10, 'frequency') <= noise.freq99) under += 1;
  }
  assert.ok(under >= 17, `${under} of 20`);
  // With a floor above the fixed bars, ECE 0.06 is amber, not red. Without one the fixed bars apply.
  const signal = { eceWidth10: 0.02, eceFreq10: 0.06, slopeLo: 0.8, slopeHi: 1.2, interceptLo: -0.02, interceptHi: 0.02, tierEdge: Number.NaN };
  assert.equal(driftAction(signal), 'red');
  assert.equal(driftAction(signal, { width95: 0.04, width99: 0.05, freq95: 0.066, freq99: 0.08 }), 'green');
  assert.equal(driftAction({ ...signal, eceFreq10: 0.07 }, { width95: 0.04, width99: 0.05, freq95: 0.066, freq99: 0.08 }), 'amber');
});

test('rows from another simulation family are never fitted, and unstamped rows are possessions-v9', () => {
  const [file] = syntheticLedger(1, 10, 3);
  const mixed: LedgerFile = { ...file, rows: file.rows.map((item, index) => (index % 2 ? { ...item, open: { ...item.open, v: 'possessions-v10' } } : item)) };
  const all = rowsFromLedger([mixed]);
  const legacy = rowsFromLedger([mixed], LEGACY_LEDGER_FAMILY);
  const next = rowsFromLedger([mixed], 'possessions-v10');
  assert.equal(all.length, 30);
  assert.equal(legacy.length + next.length, 30);
  assert.equal(legacy.length, 15);
  // A refreshed `last` decides the family, the same way it decides the probability.
  const refreshed: LedgerFile = { ...file, rows: file.rows.map((item) => ({ ...item, last: { ...item.open, at: `${file.date}T19:00:00Z`, v: 'possessions-v10' } })) };
  assert.equal(rowsFromLedger([refreshed], LEGACY_LEDGER_FAMILY).length, 0);
});

test('a map applies only to its family, only while fitted, and only for a week after its check', () => {
  const card = { status: 'fitted' as const, model_version: 'fam-1', validated_through: '2026-11-18' };
  assert.equal(mapIsCurrent(card, 'fam-1', '2026-11-19'), true);
  assert.equal(mapIsCurrent(card, 'fam-1', `2026-11-${18 + MAP_MAX_AGE_DAYS}`), true);
  assert.equal(mapIsCurrent(card, 'fam-1', `2026-11-${19 + MAP_MAX_AGE_DAYS}`), false);
  assert.equal(mapIsCurrent(card, 'fam-2', '2026-11-19'), false);
  assert.equal(mapIsCurrent(card, null, '2026-11-19'), false);
  assert.equal(mapIsCurrent({ ...card, status: 'rejected' }, 'fam-1', '2026-11-19'), false);
});

test('isotonic ships only after winning two different held-out blocks', () => {
  // A step the logit maps cannot follow: chances under 0.5 hit 30%, chances over 0.5 hit 70%.
  const draw = (rng: () => number) => {
    const p = 0.05 + 0.9 * rng();
    return { p, y: (rng() < (p < 0.5 ? 0.3 : 0.7) ? 1 : 0) as 0 | 1 };
  };
  const fit = datedRows(1600, 21, draw);
  const validation = datedRows(800, 22, draw).map((item) => ({ ...item, date: '2026-04-01', key: `v:${item.key}` }));
  const first = selectMethod(fit, validation, null);
  assert.equal(first.heldOutBest, 'isotonic');
  assert.notEqual(first.method, 'isotonic');
  const second = selectMethod(fit, validation, 'isotonic');
  assert.equal(second.method, 'isotonic');
  assertMonotone(second.params);
  // A refit on the same block is not a second win; an earlier block is.
  const history = recordHeldOutBest([], '2026-04-01', 'isotonic');
  assert.equal(previousHeldOutBest(history, '2026-04-01'), null);
  assert.equal(previousHeldOutBest(history, '2026-04-03'), 'isotonic');
  const replaced = recordHeldOutBest(history, '2026-04-01', 'temperature');
  assert.deepEqual(replaced, [{ validated_through: '2026-04-01', method: 'temperature' }]);
  let long = replaced;
  for (let day = 2; day <= 8; day += 1) long = recordHeldOutBest(long, `2026-04-0${day}`, 'platt');
  assert.equal(long.length, 5);
  assert.equal(long[4].validated_through, '2026-04-08');
});

test('the prop panel says when a chance is calibrated, and the leans panel says which stats are', () => {
  const artifact = (group: 'points' | 'rebAst', status: 'fitted' | 'rejected'): PropCalibrationArtifact => ({
    schema_version: 1, group, method: 'temperature', model_version: LEGACY_LEDGER_FAMILY, input_hash: 'a'.repeat(64),
    fitted_through: '2026-11-16', validated_through: '2026-11-18', rows_fit: 732, rows_validated: 742, clusters_fit: 211,
    params: { method: 'temperature', temperature: 2 }, w: 0.2,
    metrics_fit: metrics({}), metrics_validated: metrics({ logLoss: 0.6923 }), metrics_raw: metrics({ logLoss: 0.708 }),
    status, reason: status === 'fitted' ? null : 'Held-out log loss is not better than the raw simulation.',
  });
  const none = calibrationStatusHtml({ artifacts: [], family: LEGACY_LEDGER_FAMILY });
  assert.match(none, /raw simulation/);
  const some = calibrationStatusHtml({ artifacts: [artifact('points', 'fitted'), artifact('rebAst', 'rejected')], family: LEGACY_LEDGER_FAMILY });
  assert.match(some, /points and point combos calibrated \(checked on 742 later lines, log loss 0\.708 to 0\.692\)/);
  assert.match(some, /rebounds, assists and R\+A raw until enough lines settle/);
  assert.match(some, /threes raw/);
  assert.match(some, /20% against the no-vig price/);
  assert.match(calibrationStatusHtml({ artifacts: [artifact('points', 'fitted')], family: 'possessions-v10' }), /raw simulation/);
  assert.equal(calibrationStatusHtml(null), '');

  const draws = new Map([['p', { min: Array(2000).fill(30), pts: Array.from({ length: 2000 }, (_, i) => (i % 10 < 7 ? 20 : 10)) }]]);
  const score = { playerDraws: draws } as unknown as Simulation;
  const form = { market: 'pts' as const, side: 'over' as const, line: '17.5', style: 'american' as const, odds: '-110', opposite: '-110' };
  const panel = { table: new Map([['points' as const, artifact('points', 'fitted')]]), modelVersion: LEGACY_LEDGER_FAMILY, tipDate: '2026-11-20', artifacts: [artifact('points', 'fitted')], cutoff: '2026-11-20' };
  const html = renderPropResults(score, 'p', form, { minutes_weight: 1, shooting_games: 20, thin_sample: false }, null, panel);
  assert.match(html, /data-calibrated/);
  assert.match(html, /simulations alone put this side at 70%/);
  assert.doesNotMatch(renderPropResults(score, 'p', form, { minutes_weight: 1, shooting_games: 20, thin_sample: false }, null, null), /data-calibrated/);
  // A page-only release changes the card hash, not the family, so the map keeps applying.
  assert.match(renderPropResults(score, 'p', form, { minutes_weight: 1, shooting_games: 20, thin_sample: false }, null, { ...panel, modelVersion: 'possessions-v10' }), /^(?![\s\S]*data-calibrated)/);
});

test('walk-forward scores each day only with maps fitted on earlier days, and keeps the last ten days', () => {
  const rows = rowsFromLedger(syntheticLedger(14, 40, 51)).filter((item) => item.group === 'points');
  const folds = walkForwardFolds(rows, 300);
  // 40 rows a day: the first day with 300 earlier rows is day 9, and every later day is a fold.
  assert.deepEqual(folds.map((fold) => fold.day), ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14']);
  for (const fold of folds) {
    assert.ok(fold.fit.every((item) => item.date < fold.day));
    assert.ok(fold.validation.every((item) => item.date === fold.day));
  }
  assert.equal(walkForwardFolds(rows, 40).length, MAX_WALK_FORWARD_FOLDS);
  const selected = selectWalkForward(folds, null);
  assert.equal(selected.heldOut.length, 6 * 40);
  assert.deepEqual(selected.fit, folds[folds.length - 1].fit);
  // A day-9 row is scored by the map fitted on days 1-8, not by the shipped map that has seen day 9.
  const early = folds[0].validation[0];
  const foldMap = selectMethod(folds[0].fit, folds[0].validation).params;
  const fromFold = selected.method === 'temperature' ? applyCalibration({ method: 'temperature', temperature: fitTemperature(folds[0].fit), support: foldMap.support }, early.p) : null;
  if (fromFold !== null) assert.ok(Math.abs(selected.predicted.get(early)! - fromFold) < 1e-12);
  assert.ok(selected.metrics.logLoss < calibrationMetrics(selected.heldOut, (item) => item.p).logLoss);
});

test('the blend weight keeps its prior when the weights the page can use score alike', () => {
  // The calibrated chance leans a quarter point the wrong way: the curve rises about 0.0013 up to the cap and about
  // 0.005 by a weight of 1, so only the uncapped curve can tell the weights apart.
  const rows = Array.from({ length: 400 }, (_, index) => row({ key: `e:${index}`, y: (index % 2) as 0 | 1, noVig: 0.5, p: 0.5 }));
  const wrongWay = (item: PropCalibrationRow) => (item.y ? 0.4975 : 0.5025);
  assert.equal(fitBlendWeight(rows, wrongWay, 0.25), 0.2);
  assert.equal(fitBlendWeight(rows, wrongWay), 0);
});
