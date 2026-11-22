/**
 * Sim v2 is an experiment beside possessions-v9. The published card stays on v1.
 * Recent points per minute shrink toward the older season rate. A variance scale
 * is applied only when played games are tighter than v1's counting draws.
 */

export const SIM_V2_VERSION = 'possessions-v9-sim-v2';
export const RECENT_GAMES = 8;
/** Prior minutes of the older season rate. Infinity keeps that rate and ignores the recent window. */
export const SHRINK_MINUTE_GRID = [0, 80, 160, 320, 640, Number.POSITIVE_INFINITY] as const;
const PER_MINUTE_CAP = 1.5;

export interface BoxAppearance {
  minutes: number;
  points: number;
}

export interface ScoredAppearance {
  history: readonly BoxAppearance[];
  minutes: number;
  points: number;
}

export interface ShrinkageFit {
  /** Null means the older season rate, with no weight on the recent window. */
  kMinutes: number | null;
  mae: number;
  rows: number;
  byK: { kMinutes: number | null; mae: number }[];
}

export interface VarianceFit {
  scale: number;
  tightened: boolean;
  empiricalSd: number;
  modelSd: number;
  reason: string;
}

function played(history: readonly BoxAppearance[]): BoxAppearance[] {
  return history.filter((row) => row.minutes > 0 && row.points >= 0 && Number.isFinite(row.points) && Number.isFinite(row.minutes));
}

function totals(rows: readonly BoxAppearance[]): { points: number; minutes: number } {
  let points = 0;
  let minutes = 0;
  for (const row of rows) {
    points += row.points;
    minutes += row.minutes;
  }
  return { points, minutes };
}

/**
 * Points per minute. The recent window is the last `recentGames` appearances.
 * The season rate is the appearances before that window. With no older sample,
 * every strength returns the only rate those appearances support.
 */
export function shrunkPointsPerMinute(history: readonly BoxAppearance[], kMinutes: number, recentGames = RECENT_GAMES): number | null {
  const rows = played(history);
  if (!rows.length || (!Number.isFinite(kMinutes) && kMinutes !== Number.POSITIVE_INFINITY)) return null;
  const recentCount = Math.min(recentGames, rows.length);
  const older = rows.slice(0, rows.length - recentCount);
  const recent = rows.slice(rows.length - recentCount);
  const seasonRows = older.length ? older : rows;
  const season = totals(seasonRows);
  if (!(season.minutes > 0)) return null;
  const seasonRate = season.points / season.minutes;
  if (!older.length || !Number.isFinite(kMinutes)) return seasonRate;
  const recentTotals = totals(recent);
  if (!(recentTotals.minutes > 0)) return seasonRate;
  return (recentTotals.points + kMinutes * seasonRate) / (recentTotals.minutes + kMinutes);
}

/** How far v1's per-minute rates should move. 1 leaves fga and fta where v1 fitted them. */
export function productionRatio(history: readonly BoxAppearance[], kMinutes: number, recentGames = RECENT_GAMES): number {
  const season = shrunkPointsPerMinute(history, Number.POSITIVE_INFINITY, recentGames);
  const shrunk = shrunkPointsPerMinute(history, kMinutes, recentGames);
  if (season === null || shrunk === null || !(season > 0)) return 1;
  const ratio = shrunk / season;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function shrinkageMae(rows: readonly ScoredAppearance[], kMinutes: number): { mae: number; rows: number } | null {
  let n = 0;
  let abs = 0;
  for (const row of rows) {
    if (!(row.minutes > 0)) continue;
    const rate = shrunkPointsPerMinute(row.history, kMinutes);
    if (rate === null) continue;
    abs += Math.abs(rate * row.minutes - row.points);
    n += 1;
  }
  return n ? { mae: abs / n, rows: n } : null;
}

/** Lowest given-minutes points error. Equal errors keep the stronger pull toward the season rate. */
export function selectShrinkage(rows: readonly ScoredAppearance[], grid: readonly number[] = SHRINK_MINUTE_GRID): ShrinkageFit | null {
  let best: ShrinkageFit | null = null;
  const byK: ShrinkageFit['byK'] = [];
  for (const kMinutes of grid) {
    const scored = shrinkageMae(rows, kMinutes);
    if (!scored) continue;
    const stored = Number.isFinite(kMinutes) ? kMinutes : null;
    byK.push({ kMinutes: stored, mae: scored.mae });
    const stronger = best !== null && Math.abs(scored.mae - best.mae) <= 1e-9 && (stored === null || (best.kMinutes !== null && stored > best.kMinutes));
    if (!best || scored.mae < best.mae - 1e-9 || stronger) best = { kMinutes: stored, mae: scored.mae, rows: scored.rows, byK };
  }
  if (best) best.byK = byK;
  return best;
}

export function kMinutesOf(fit: ShrinkageFit): number {
  return fit.kMinutes === null ? Number.POSITIVE_INFINITY : fit.kMinutes;
}

/**
 * `scale` multiplies the spread of v1's counting draws. A result at least as wide as v1 stays at 1.
 * The gamma draws cannot go all the way to zero, so the scale stops at 0.55.
 */
export function fitVarianceScale(empiricalSd: number, modelSd: number): VarianceFit {
  if (!(empiricalSd > 0) || !(modelSd > 0) || !Number.isFinite(empiricalSd) || !Number.isFinite(modelSd)) {
    return { scale: 1, tightened: false, empiricalSd, modelSd, reason: 'The spread could not be measured, so v1 variance is unchanged.' };
  }
  const ratio = empiricalSd / modelSd;
  if (ratio >= 0.98) {
    return {
      scale: 1,
      tightened: false,
      empiricalSd,
      modelSd,
      reason: 'Played games are at least as wide as v1, so the variance is not shrunk.',
    };
  }
  const scale = Math.max(0.55, Math.min(1, ratio));
  return {
    scale,
    tightened: scale < 1,
    empiricalSd,
    modelSd,
    reason: `Played games are tighter than v1. The gamma volume draws use scale ${scale.toFixed(3)}.`,
  };
}

function clampPerMinute(value: number): number {
  return Math.min(PER_MINUTE_CAP, Math.max(0, value));
}

/** Copy a player with the shrunk shot and free-throw rates. The input player is left as v1 fitted it. */
export function applyProductionShrink<T extends { fga_per_min: number; fta_per_min: number }>(
  player: T,
  ratio: number,
  varianceScale = 1,
): T & { sim_v2_variance_scale?: number } {
  const next: T & { sim_v2_variance_scale?: number } = { ...player };
  if (Number.isFinite(ratio) && ratio > 0 && ratio !== 1) {
    next.fga_per_min = clampPerMinute(player.fga_per_min * ratio);
    next.fta_per_min = clampPerMinute(player.fta_per_min * ratio);
  }
  if (varianceScale > 0 && varianceScale < 1) next.sim_v2_variance_scale = varianceScale;
  else delete next.sim_v2_variance_scale;
  return next;
}
