import { gamma, mulberry32, normal, poisson, type Rng } from '../rng.ts';

/**
 * Per-player esports projections. A player's rate is his recency-weighted count over earlier series (CS2: per round;
 * Dota 2 and League of Legends: per game), pulled toward the pool's rate when his sample is small. Counts are drawn
 * from a gamma-Poisson whose spread, and a mean-bias scale, are fitted walk-forward on the same players' earlier
 * series so that 8 in 10 results land inside the published 10th to 90th range.
 */

export interface RateRow {
  /** Series or game id. */
  id: string;
  start: number;
  /** Rounds for CS2, 1 for a game. */
  units: number;
  value: number;
}

export interface ProjectionBand {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface StatCalibration {
  /** Variance over mean of a count at a known number of units. 1 is Poisson. */
  dispersion: number;
  /** Recorded over predicted on earlier series, pulled toward 1. */
  bias: number;
  /** Share of earlier series inside the 10th to 90th range, after fitting. */
  coverage: number;
  rows: number;
  mae: number;
}

export const DEFAULT_STAT_CALIBRATION: StatCalibration = { dispersion: 1.5, bias: 1, coverage: Number.NaN, rows: 0, mae: Number.NaN };

/** Earlier series weigh half as much every eight series back. */
const HALF_LIFE = 8;
/** CS2 maps run 13 to about 30 rounds; this is a map's mean and spread across recent pro play. */
export const CS2_ROUNDS_PER_MAP = { mean: 21.5, sd: 4.2, min: 13 };
const DISPERSIONS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MIN_EARLIER = 4;
const DRAWS = 4000;

/** Weighted rate over rows strictly before `before`, newest first, shrunk toward `prior` with `priorUnits` of weight. */
export function priorRate(rows: readonly RateRow[], before: number, excludeId: string | null, prior: number, priorUnits: number): { rate: number; n: number } {
  const earlier = rows.filter((row) => row.start < before && row.id !== excludeId && row.units > 0).sort((a, b) => b.start - a.start);
  let value = 0;
  let units = 0;
  earlier.forEach((row, index) => {
    const weight = 0.5 ** (index / HALF_LIFE);
    value += weight * row.value;
    units += weight * row.units;
  });
  return { rate: (value + prior * priorUnits) / (units + priorUnits), n: earlier.length };
}

/** Pool rate: total count over total units. */
export function poolRate(players: readonly (readonly RateRow[])[], fallback: number): number {
  let value = 0;
  let units = 0;
  for (const rows of players) {
    for (const row of rows) {
      value += row.value;
      units += row.units;
    }
  }
  return units > 0 ? value / units : fallback;
}

/** A gamma-Poisson count with the given mean and variance-over-mean. */
export function overdispersedCount(mean: number, dispersion: number, rng: Rng): number {
  if (!(mean > 0)) return 0;
  if (dispersion <= 1.0001) return poisson(mean, rng);
  const shape = mean / (dispersion - 1);
  return poisson(gamma(shape, rng) * (dispersion - 1), rng);
}

function quantile(sorted: Float64Array, q: number): number {
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
}

export function bandOf(values: Float64Array): ProjectionBand {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const value of sorted) sum += value;
  return { mean: sum / Math.max(1, sorted.length), p10: quantile(sorted, 0.1), p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
}

/** Exact 10th and 90th percentiles of a gamma-Poisson count, by its probabilities, so the walk-forward fit is cheap. */
export function countInterval(mean: number, dispersion: number): { lo: number; hi: number } {
  if (!(mean > 0)) return { lo: 0, hi: 0 };
  const probabilities: number[] = [];
  if (dispersion <= 1.0001) {
    let p = Math.exp(-mean);
    for (let k = 0; k < 400; k += 1) {
      probabilities.push(p);
      p *= mean / (k + 1);
    }
  } else {
    // Negative binomial with r = mean/(d-1) and success chance 1/d.
    const r = mean / (dispersion - 1);
    const q = (dispersion - 1) / dispersion;
    let p = (1 / dispersion) ** r;
    for (let k = 0; k < 400; k += 1) {
      probabilities.push(p);
      p *= ((k + r) / (k + 1)) * q;
    }
  }
  let cumulative = 0;
  let lo = 0;
  let hi = probabilities.length - 1;
  let foundLo = false;
  for (let k = 0; k < probabilities.length; k += 1) {
    cumulative += probabilities[k]!;
    if (!foundLo && cumulative >= 0.1) {
      lo = k;
      foundLo = true;
    }
    if (cumulative >= 0.9) {
      hi = k;
      break;
    }
  }
  return { lo, hi };
}

/**
 * Walk-forward check for one stat: every row with at least four earlier rows from the same player is predicted from
 * those alone, at its own units. Fits the mean-bias scale, then the smallest spread that puts 80% of rows inside.
 */
export function fitStatCalibration(players: readonly (readonly RateRow[])[], prior: number, priorUnits: number): StatCalibration {
  const checks: { predicted: number; actual: number }[] = [];
  for (const rows of players) {
    for (const row of rows) {
      const earlier = priorRate(rows, row.start, row.id, prior, priorUnits);
      if (earlier.n < MIN_EARLIER) continue;
      checks.push({ predicted: earlier.rate * row.units, actual: row.value });
    }
  }
  if (checks.length < 40) return { ...DEFAULT_STAT_CALIBRATION, rows: checks.length };
  const predicted = checks.reduce((sum, row) => sum + row.predicted, 0);
  const actual = checks.reduce((sum, row) => sum + row.actual, 0);
  const raw = predicted > 0 ? actual / predicted : 1;
  const bias = Number((1 + (raw - 1) * (checks.length / (checks.length + 200))).toFixed(4));
  let chosen = DISPERSIONS[DISPERSIONS.length - 1]!;
  let coverage = 0;
  for (const dispersion of DISPERSIONS) {
    let inside = 0;
    for (const row of checks) {
      const { lo, hi } = countInterval(row.predicted * bias, dispersion);
      if (row.actual >= lo && row.actual <= hi) inside += 1;
    }
    coverage = inside / checks.length;
    chosen = dispersion;
    if (coverage >= 0.8) break;
  }
  const mae = checks.reduce((sum, row) => sum + Math.abs(row.predicted * bias - row.actual), 0) / checks.length;
  return { dispersion: chosen, bias, coverage: Number(coverage.toFixed(3)), rows: checks.length, mae: Number(mae.toFixed(2)) };
}

export interface Cs2Projection {
  kills: ProjectionBand;
  headshots: ProjectionBand;
  /** Per-map rates behind the maps 1-2 numbers. */
  killsPerMap: number;
  headshotsPerMap: number;
  earlier: number;
}

/**
 * Kills and headshots over maps 1 and 2. Each draw plays two maps of 13 to about 30 rounds, then counts kills at the
 * player's kills-per-round rate and headshots at his headshots-per-round rate, both calibrated.
 */
export function projectCs2(
  kills: readonly RateRow[],
  headshots: readonly RateRow[],
  before: number,
  excludeId: string | null,
  priors: { kpr: number; hspr: number },
  calibration: { kills: StatCalibration; headshots: StatCalibration },
  seed: number,
): Cs2Projection {
  const kpr = priorRate(kills, before, excludeId, priors.kpr, 120);
  const hspr = priorRate(headshots, before, excludeId, priors.hspr, 120);
  const rng = mulberry32(seed);
  const killDraws = new Float64Array(DRAWS);
  const hsDraws = new Float64Array(DRAWS);
  for (let draw = 0; draw < DRAWS; draw += 1) {
    let rounds = 0;
    for (let map = 0; map < 2; map += 1) rounds += Math.max(CS2_ROUNDS_PER_MAP.min, Math.round(CS2_ROUNDS_PER_MAP.mean + normal(rng) * CS2_ROUNDS_PER_MAP.sd));
    killDraws[draw] = overdispersedCount(kpr.rate * rounds * calibration.kills.bias, calibration.kills.dispersion, rng);
    hsDraws[draw] = overdispersedCount(hspr.rate * rounds * calibration.headshots.bias, calibration.headshots.dispersion, rng);
  }
  return {
    kills: bandOf(killDraws),
    headshots: bandOf(hsDraws),
    killsPerMap: kpr.rate * CS2_ROUNDS_PER_MAP.mean * calibration.kills.bias,
    headshotsPerMap: hspr.rate * CS2_ROUNDS_PER_MAP.mean * calibration.headshots.bias,
    earlier: kpr.n,
  };
}

/** One game's count at the player's calibrated per-game rate. */
export function projectGame(rows: readonly RateRow[], before: number, excludeId: string | null, prior: number, calibration: StatCalibration, seed: number): { band: ProjectionBand; earlier: number } {
  const rate = priorRate(rows, before, excludeId, prior, 3);
  const rng = mulberry32(seed);
  const draws = new Float64Array(DRAWS);
  for (let draw = 0; draw < DRAWS; draw += 1) draws[draw] = overdispersedCount(rate.rate * calibration.bias, calibration.dispersion, rng);
  return { band: bandOf(draws), earlier: rate.n };
}
