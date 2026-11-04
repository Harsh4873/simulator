import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { personnelFactor, PERSONNEL_FACTOR_MIN, PERSONNEL_FACTOR_MAX } from '../src/personnel.ts';
import { simulate } from '../src/simulate.ts';
import type { RateCard, RatePlayer, TeamProfile } from '../src/types.ts';

const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
const profile = (offense = 1.12): TeamProfile => ({
  pace: 100,
  offense,
  defense: 1.12,
  turnover_rate: 0.13,
  offensive_rebound_rate: 0.27,
  assist_rate: 0.6,
  ft_trip_rate: 0.2,
  games: 10,
  rest_days: 2,
});

function line(overrides: Partial<RatePlayer>): RatePlayer {
  return {
    athlete_id: 'a',
    name: 'A',
    team_id: 't',
    position: 'G',
    position_group: 'Guard',
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
    games_2026: 40,
    games_2027: 5,
    games: 45,
    shooting_games: 45,
    thin_sample: false,
    minutes_mean: 32,
    fga_per_min: 0.2,
    fta_per_min: 0.06,
    tpa_given_fga: 0.4,
    fg2_pct: 0.52,
    tp_pct: 0.36,
    ft_pct: 0.8,
    reb_per_min: 0.12,
    ast_per_min: 0.08,
    ...overrides,
  };
}

test('a star sitting below role minutes lowers personnel factor; a full-strength rotation stays near 1', () => {
  const star = line({ athlete_id: 'star', minutes_mean: 38, fga_per_min: 0.45, fg2_pct: 0.62, tp_pct: 0.41, fta_per_min: 0.12 });
  const role = [38, 30, 26, 22, 18, 14, 12, 10, 8, 8];
  const players = [
    star,
    ...role.slice(1).map((minutes, i) => line({
      athlete_id: `b${i}`,
      minutes_mean: minutes,
      fga_per_min: 0.14,
      fg2_pct: 0.44,
      tp_pct: 0.31,
      fta_per_min: 0.04,
    })),
  ];
  const fullMinutes = players.map(p => p.minutes_mean);
  const full = personnelFactor(players, fullMinutes, profile(), undefined, 100);
  assert.ok(Math.abs(full - 1) < 0.02, `full-strength factor ${full}`);
  const withoutStar = players.map(p => (p.athlete_id === 'star' ? 0 : p.minutes_mean));
  const budget = fullMinutes.reduce((a, b) => a + b, 0);
  const used = withoutStar.reduce((a, b) => a + b, 0);
  const tonight = withoutStar.map(m => m * budget / used);
  const missing = personnelFactor(players, tonight, profile(), undefined, 100);
  assert.ok(missing < 0.94, `Tatum-style absence should weaken the team, got ${missing}`);
  assert.ok(missing >= PERSONNEL_FACTOR_MIN && missing <= PERSONNEL_FACTOR_MAX);
  assert.ok(missing < full);
});

test('an official OUT star reduces the simulated team more than sitting a replacement-level bench player', { timeout: 120_000 }, () => {
  const game = structuredClone(card.games[0]);
  game.context!.fouls = undefined;
  game.context!.rotation_state = undefined;
  const template = game.players.find(p => p.minutes_weight === 1 && p.shooting_games > 0)!;
  const homeId = game.home_team_id;
  const away = game.players.filter(p => p.team_id !== homeId);
  const star = {
    ...template,
    athlete_id: 'star',
    name: 'Star',
    team_id: homeId,
    injury_status: 'healthy',
    minutes_weight: 1 as const,
    play_probability: 1,
    minutes_mean: 38,
    fga_per_min: 0.42,
    fta_per_min: 0.12,
    fg2_pct: 0.6,
    tp_pct: 0.4,
    starter_rate: 1,
    closing_rate: 1,
    minutes_restriction: null,
    replacement_level: undefined,
  };
  const others = Array.from({ length: 8 }, (_, i) => ({
    ...template,
    athlete_id: `home-${i}`,
    name: `Bench ${i}`,
    team_id: homeId,
    injury_status: 'healthy',
    minutes_weight: 1 as const,
    play_probability: 1,
    minutes_mean: i < 5 ? 20 : 10,
    fga_per_min: 0.13,
    fta_per_min: 0.04,
    fg2_pct: 0.44,
    tp_pct: 0.31,
    starter_rate: i < 5 ? 1 : 0,
    closing_rate: 0,
    minutes_restriction: null,
    replacement_level: undefined,
  }));
  game.players = [...away, star, ...others];
  const mark = (athlete: string) => {
    const g = structuredClone(game);
    for (const p of g.players) {
      if (p.athlete_id !== athlete) continue;
      p.injury_status = 'out';
      p.minutes_weight = 0;
      p.play_probability = 0;
    }
    return g;
  };
  const baseline = simulate(game, 11, 200);
  const withoutStar = simulate(mark('star'), 11, 200);
  const withoutBench = simulate(mark('home-7'), 11, 200);
  const homeMean = (r: typeof baseline) => r.forecast!.homeMean;
  const starDrop = homeMean(baseline) - homeMean(withoutStar);
  const benchDrop = homeMean(baseline) - homeMean(withoutBench);
  assert.ok(starDrop > benchDrop + 2, `star drop ${starDrop.toFixed(2)} vs bench drop ${benchDrop.toFixed(2)}`);
});
