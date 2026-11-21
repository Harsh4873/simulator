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

/*
 * Version 2: the opponent. A team's rating comes from its earlier results (Elo, each result counted once), and a
 * player's rate moves with how his side is expected to do against this opponent compared with how his side usually
 * did in the games behind his rate. How far it moves is fitted on every loaded player's earlier games, and the
 * adjustment ships only when it beats the rate alone on those games. Every check projects a game from the games
 * before it, so the reported error is what a projection made before the game would have had.
 */

/** One result: `score` is team a's share, 1 or 0 for a game, maps won over maps played for a CS2 series. */
export interface ResultRow {
  id: string;
  at: number;
  a: string;
  b: string;
  score: number;
}

export interface Ratings {
  /** Rating from results strictly before `at`; 1500 for a team with none. */
  before(team: string, at: number): number;
  /** Results strictly before `at`. */
  played(team: string, at: number): number;
}

export const ELO_K = 32;
export const ELO_BASE = 1500;

/** Walk-forward Elo. Each result id counts once, in time order. */
export function eloRatings(results: readonly ResultRow[], k = ELO_K): Ratings {
  const seen = new Set<string>();
  const ordered = [...results].filter((row) => Number.isFinite(row.at) && row.a !== row.b && row.score >= 0 && row.score <= 1).sort((x, y) => x.at - y.at || x.id.localeCompare(y.id));
  const current = new Map<string, number>();
  const history = new Map<string, { at: number; rating: number }[]>();
  const push = (team: string, at: number, rating: number) => {
    const list = history.get(team) ?? [];
    list.push({ at, rating });
    history.set(team, list);
  };
  for (const row of ordered) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const ra = current.get(row.a) ?? ELO_BASE;
    const rb = current.get(row.b) ?? ELO_BASE;
    const expected = winChance(ra, rb);
    const next = k * (row.score - expected);
    current.set(row.a, ra + next);
    current.set(row.b, rb - next);
    push(row.a, row.at, ra + next);
    push(row.b, row.at, rb - next);
  }
  const lastBefore = (team: string, at: number): number => {
    const list = history.get(team);
    if (!list?.length) return -1;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.at < at) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  return {
    before(team, at) {
      const index = lastBefore(team, at);
      return index < 0 ? ELO_BASE : history.get(team)![index]!.rating;
    },
    played(team, at) {
      return lastBefore(team, at) + 1;
    },
  };
}

/** Chance the first side wins a game, or its expected map share, from two ratings. */
export function winChance(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/** A player's earlier game: his count, its units, and how his side did (1 won, 0 lost, a map share for CS2). */
export interface OutcomeRow extends RateRow {
  outcome: number | null;
  /** His side's chance before the game, from ratings before it; null when a side is unknown. */
  expected: number | null;
  /** CS2: maps played. The check projects maps times the rounds a map expected before the series, not the rounds it ran. */
  maps?: number;
}

/** What the check multiplies a rate by: the units known before the game. */
export type PredictUnits = (row: OutcomeRow) => number;

/** Recency-weighted outcome share over the rows behind a rate, so the adjustment compares like with like. */
export function usualOutcome(rows: readonly OutcomeRow[], before: number, excludeId: string | null): number | null {
  const earlier = rows.filter((row) => row.start < before && row.id !== excludeId && row.units > 0 && row.outcome !== null).sort((a, b) => b.start - a.start);
  let total = 0;
  let weight = 0;
  earlier.forEach((row, index) => {
    const w = 0.5 ** (index / HALF_LIFE);
    total += w * (row.outcome as number);
    weight += w;
  });
  return weight > 0 ? total / weight : null;
}

/** The adjusted mean per unit: the rate scaled by how much better or worse this game is expected to go. */
export function adjustedRate(rate: number, sensitivity: number, expected: number | null, usual: number | null): number {
  if (expected === null || usual === null || !(sensitivity > 0)) return rate;
  return rate * Math.max(0.35, 1 + sensitivity * (expected - usual));
}

export interface OpponentFit {
  /** Fitted sensitivity of a count to the side's result share; 0 when the adjustment did not help. */
  sensitivity: number;
  calibration: StatCalibration;
  /** Plain mean of the player's last ten earlier games, per unit, on the same rows. */
  baselineMae: number;
  /** The rate alone, without the opponent, on the same rows. */
  rateMae: number;
}

const SENSITIVITIES = [0, 0.1, 0.2, 0.3, 0.45, 0.6, 0.8, 1, 1.25, 1.5];
const BASELINE_GAMES = 10;

interface WalkRow {
  rate: number;
  usual: number | null;
  expected: number | null;
  units: number;
  actual: number;
  baseline: number;
}

/** Plain mean of the last ten earlier games, on the game's own scale: per game, or per map for CS2. */
function plainBaseline(rows: readonly OutcomeRow[], row: OutcomeRow): number {
  const last = rows.filter((other) => other.start < row.start && other.id !== row.id && other.units > 0).sort((a, b) => b.start - a.start).slice(0, BASELINE_GAMES);
  if (row.maps !== undefined) {
    const perMap = last.filter((other) => (other.maps ?? 0) > 0);
    if (!perMap.length) return 0;
    return (perMap.reduce((sum, other) => sum + other.value / (other.maps as number), 0) / perMap.length) * row.maps;
  }
  return last.reduce((sum, other) => sum + other.value / other.units, 0) / Math.max(1, last.length) * row.units;
}

/**
 * Walk-forward fit for one stat. Every row with at least four earlier rows from the same player is projected from
 * those alone: the rate, the usual outcome behind it, and his side's chance from ratings before the game. Picks the
 * sensitivity with the smallest error, then the mean-bias scale and the smallest spread that puts 80% inside.
 */
export function fitOpponentModel(players: readonly (readonly OutcomeRow[])[], prior: number, priorUnits: number, predictUnits: PredictUnits = (row) => row.units): OpponentFit {
  const walk: WalkRow[] = [];
  for (const rows of players) {
    for (const row of rows) {
      const earlier = priorRate(rows, row.start, row.id, prior, priorUnits);
      if (earlier.n < MIN_EARLIER) continue;
      walk.push({ rate: earlier.rate, usual: usualOutcome(rows, row.start, row.id), expected: row.expected, units: predictUnits(row), actual: row.value, baseline: plainBaseline(rows, row) });
    }
  }
  const empty = { sensitivity: 0, calibration: { ...DEFAULT_STAT_CALIBRATION, rows: walk.length }, baselineMae: Number.NaN, rateMae: Number.NaN };
  if (walk.length < 40) return empty;
  const maeAt = (sensitivity: number, bias: number) => walk.reduce((sum, row) => sum + Math.abs(adjustedRate(row.rate, sensitivity, row.expected, row.usual) * row.units * bias - row.actual), 0) / walk.length;
  const biasAt = (sensitivity: number) => {
    const predicted = walk.reduce((sum, row) => sum + adjustedRate(row.rate, sensitivity, row.expected, row.usual) * row.units, 0);
    const actual = walk.reduce((sum, row) => sum + row.actual, 0);
    const raw = predicted > 0 ? actual / predicted : 1;
    return Number((1 + (raw - 1) * (walk.length / (walk.length + 200))).toFixed(4));
  };
  let best = { sensitivity: 0, bias: biasAt(0), mae: Number.POSITIVE_INFINITY };
  for (const sensitivity of SENSITIVITIES) {
    const bias = biasAt(sensitivity);
    const mae = maeAt(sensitivity, bias);
    if (mae < best.mae - 1e-9) best = { sensitivity, bias, mae };
  }
  const rateMae = maeAt(0, biasAt(0));
  let chosen = DISPERSIONS[DISPERSIONS.length - 1]!;
  let coverage = 0;
  for (const dispersion of DISPERSIONS) {
    let inside = 0;
    for (const row of walk) {
      const { lo, hi } = countInterval(adjustedRate(row.rate, best.sensitivity, row.expected, row.usual) * row.units * best.bias, dispersion);
      if (row.actual >= lo && row.actual <= hi) inside += 1;
    }
    coverage = inside / walk.length;
    chosen = dispersion;
    if (coverage >= 0.8) break;
  }
  const baselineMae = walk.reduce((sum, row) => sum + Math.abs(row.baseline - row.actual), 0) / walk.length;
  return {
    sensitivity: best.sensitivity,
    calibration: { dispersion: chosen, bias: best.bias, coverage: Number(coverage.toFixed(3)), rows: walk.length, mae: Number(best.mae.toFixed(2)) },
    baselineMae: Number(baselineMae.toFixed(2)),
    rateMae: Number(rateMae.toFixed(2)),
  };
}

/** Draws of a count with the given mean per unit over `units`, calibrated. */
export function countBand(meanPerUnit: number, units: number, calibration: StatCalibration, seed: number): ProjectionBand {
  const rng = mulberry32(seed);
  const draws = new Float64Array(DRAWS);
  for (let draw = 0; draw < DRAWS; draw += 1) draws[draw] = overdispersedCount(meanPerUnit * units * calibration.bias, calibration.dispersion, rng);
  return bandOf(draws);
}

/** CS2 rounds a map: the pool's average, a little longer when the two sides are close. */
export interface RoundsModel {
  /** Rounds a map in an even matchup. */
  even: number;
  /** Rounds lost a map per unit of distance from an even expected map share. */
  slope: number;
}

/** Least squares of rounds a map on how lopsided the matchup was expected to be, from ratings before each series. */
export function fitRounds(rows: readonly { roundsPerMap: number; expected: number | null }[]): RoundsModel {
  const kept = rows.filter((row) => row.expected !== null && Number.isFinite(row.roundsPerMap) && row.roundsPerMap >= 13);
  if (kept.length < 30) return { even: CS2_ROUNDS_PER_MAP.mean, slope: 0 };
  const xs = kept.map((row) => Math.abs((row.expected as number) - 0.5));
  const ys = kept.map((row) => row.roundsPerMap);
  const mx = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const my = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index]! - mx) * (ys[index]! - my);
    sxx += (xs[index]! - mx) ** 2;
  }
  const slope = sxx > 0 ? Math.max(0, Math.min(20, -sxy / sxx)) : 0;
  return { even: Number((my + slope * mx).toFixed(2)), slope: Number(slope.toFixed(2)) };
}

export function roundsPerMap(model: RoundsModel, expected: number | null): number {
  if (expected === null) return model.even - model.slope * 0.12;
  return Math.max(16, model.even - model.slope * Math.abs(expected - 0.5));
}
