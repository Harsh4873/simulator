import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProductionShrink, fitVarianceScale, productionRatio, selectShrinkage, shrunkPointsPerMinute, type BoxAppearance, type ScoredAppearance } from '../src/sim-v2.ts';
import { samplePointsGivenMinutes } from '../src/simulate.ts';
import type { RatePlayer } from '../src/types.ts';

const steady = (points: number, count: number): BoxAppearance[] => Array.from({ length: count }, () => ({ minutes: 30, points }));

test('an infinite prior keeps the older season rate and drops the recent window', () => {
  const history = [...steady(15, 12), ...steady(30, 8)];
  assert.equal(shrunkPointsPerMinute(history, Number.POSITIVE_INFINITY), 0.5);
  assert.equal(shrunkPointsPerMinute(history, 0), 1);
  const mid = shrunkPointsPerMinute(history, 240);
  assert.ok(mid !== null && mid > 0.5 && mid < 1);
  assert.equal(productionRatio(history, Number.POSITIVE_INFINITY), 1);
});

test('the fit keeps the stronger season pull when recent form does not repeat', () => {
  const rows: ScoredAppearance[] = [];
  for (let i = 16; i < 36; i += 1) {
    const history = [...steady(18, i - 8), ...steady(36, 8)];
    rows.push({ history, minutes: 30, points: 18 });
  }
  const fit = selectShrinkage(rows);
  assert.ok(fit);
  assert.equal(fit.kMinutes, null);
  assert.ok(fit.byK.length >= 2);
  const recentOnly = fit.byK.find((row) => row.kMinutes === 0);
  assert.ok(recentOnly && recentOnly.mae > fit.mae);
});

test('the fit follows the recent rate when that rate is what happens next', () => {
  const rows: ScoredAppearance[] = [];
  for (let i = 16; i < 36; i += 1) {
    const history = [...steady(15, i - 8), ...steady(30, 8)];
    rows.push({ history, minutes: 30, points: 30 });
  }
  const fit = selectShrinkage(rows);
  assert.ok(fit);
  assert.equal(fit.kMinutes, 0);
});

test('variance stays at v1 when played games are as wide, and tightens when they are not', () => {
  const wide = fitVarianceScale(5, 4);
  assert.equal(wide.scale, 1);
  assert.equal(wide.tightened, false);
  const tight = fitVarianceScale(2, 4);
  assert.equal(tight.scale, 0.55);
  assert.equal(tight.tightened, true);
  const missing = fitVarianceScale(Number.NaN, 4);
  assert.equal(missing.scale, 1);
});

test('applying v2 copies the player and leaves the v1 rates in place', () => {
  const player = { fga_per_min: 0.4, fta_per_min: 0.1 };
  const next = applyProductionShrink(player, 1.25, 0.8);
  assert.equal(player.fga_per_min, 0.4);
  assert.equal(next.fga_per_min, 0.5);
  assert.equal(next.fta_per_min, 0.125);
  assert.equal(next.sim_v2_variance_scale, 0.8);
  const same = applyProductionShrink(player, 1, 1);
  assert.equal(same.sim_v2_variance_scale, undefined);
});

function volumePlayer(scale?: number): RatePlayer {
  return {
    athlete_id: 'volume',
    name: 'Volume',
    team_id: 't',
    position: 'G',
    position_group: 'Guard',
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
    games_2026: 0,
    games_2027: 40,
    games: 40,
    shooting_games: 40,
    thin_sample: false,
    minutes_mean: 32,
    fga_per_min: 0.62,
    fta_per_min: 0.16,
    tpa_given_fga: 0.4,
    fg2_pct: 0.52,
    tp_pct: 0.37,
    ft_pct: 0.8,
    reb_per_min: 0.15,
    ast_per_min: 0.12,
    ...(scale !== undefined ? { sim_v2_variance_scale: scale } : {}),
  };
}

function sd(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

test('a variance scale below 1 tightens drawStats, and a missing scale matches 1', () => {
  const open = samplePointsGivenMinutes(volumePlayer(), 32, 600, 11);
  const marked = samplePointsGivenMinutes(volumePlayer(1), 32, 600, 11);
  const tight = samplePointsGivenMinutes(volumePlayer(0.55), 32, 600, 11);
  assert.deepEqual(open, marked);
  assert.ok(sd(tight) < sd(open) * 0.92);
});
