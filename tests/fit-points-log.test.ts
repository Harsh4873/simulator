import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPlayers, pointsLogPerMinute, priorPointsPerMinute } from '../src/fit.ts';
import type { OutcomeRow, ShootingRow } from '../src/types.ts';

function pointsRow(athleteId: string, eventId: string, actual: number, minutes: number, season = 2026): OutcomeRow {
  return {
    season,
    athlete_id: athleteId,
    team_id: '10',
    event_id: eventId,
    stat_key: 'points',
    actual,
    minutes,
  };
}

const shooting: ShootingRow[] = [
  {
    athlete_id: 'prior',
    team_id: '10',
    season: 2026,
    games: 8,
    minutes: 40,
    fgm: 4,
    fga: 10,
    tpm: 1,
    tpa: 2,
    ftm: 2,
    fta: 4,
    reb: 0,
    ast: 0,
    pts: 10,
  },
];

const outcomes: OutcomeRow[] = [
  pointsRow('prior', 'p1', 10, 40),
  pointsRow('prior', 'p2', 10, 40),
  pointsRow('prior', 'p3', 10, 40),
  pointsRow('star', 's1', 24, 32),
  pointsRow('star', 's2', 24, 32),
  pointsRow('star', 's3', 24, 32),
  pointsRow('rookie', 'r1', 2, 5),
];

test('a points log scales attempt rates only when the shooting sample is empty and the player has at least 3 games', () => {
  assert.equal(pointsLogPerMinute(outcomes, 'star'), 24 / 32);
  const fitted = fitPlayers({
    roster: [
      { athlete_id: 'prior', name: 'Prior Shooter', team_id: '10', position: 'SF' },
      { athlete_id: 'star', name: 'Star Forward', team_id: '10', position: 'SF' },
      { athlete_id: 'rookie', name: 'Rookie Wing', team_id: '10', position: 'SF' },
    ],
    injuries: [],
    outcomes,
    shooting,
  });
  const prior = fitted.players.find((player) => player.athlete_id === 'prior');
  const star = fitted.players.find((player) => player.athlete_id === 'star');
  const rookie = fitted.players.find((player) => player.athlete_id === 'rookie');
  assert.ok(prior && star && rookie);
  assert.equal(prior.missing_shooting, false);
  assert.equal(star.missing_shooting, true);
  assert.equal(rookie.missing_shooting, true);
  assert.equal(prior.shooting_games > 0, true);
  assert.equal(star.shooting_games, 0);
  assert.equal(rookie.shooting_games, 0);
  assert.ok(Math.abs(rookie.fga_per_min - prior.fga_per_min) < 1e-9, `rookie ${rookie.fga_per_min} prior ${prior.fga_per_min}`);
  assert.ok(Math.abs(rookie.fta_per_min - prior.fta_per_min) < 1e-9);
  assert.equal(star.tp_pct, rookie.tp_pct);
  assert.equal(star.fg2_pct, rookie.fg2_pct);
  assert.equal(star.tpa_given_fga, rookie.tpa_given_fga);
  assert.equal(star.ft_pct, rookie.ft_pct);
  assert.equal(star.reb_per_min, rookie.reb_per_min);
  assert.equal(star.ast_per_min, rookie.ast_per_min);
  assert.equal(prior.tp_pct, rookie.tp_pct);
  assert.equal(prior.fg2_pct, rookie.fg2_pct);
  assert.equal(prior.tpa_given_fga, rookie.tpa_given_fga);
  const priorPpm = priorPointsPerMinute(rookie);
  assert.ok(priorPpm > 0);
  const scale = (24 / 32) / priorPpm;
  const scaledFga = Math.min(1.5, Math.max(0, rookie.fga_per_min * scale));
  assert.ok(Math.abs(star.fga_per_min - scaledFga) < 1e-9, `star ${star.fga_per_min} scaled ${scaledFga}`);
  assert.ok(Math.abs(star.fga_per_min - rookie.fga_per_min) > 1e-4);
  assert.ok(Math.abs(star.fta_per_min - Math.min(1.5, rookie.fta_per_min * scale)) < 1e-9);
});

test('points per minute uses a full 2026 weight and a 0.35 weight for 2027', () => {
  const row = (season: number): OutcomeRow => ({
    season,
    athlete_id: 'log',
    team_id: '10',
    event_id: String(season),
    stat_key: 'points',
    actual: 24,
    minutes: 32,
  });
  const mixed = pointsLogPerMinute([row(2026), row(2027)], 'log');
  assert.ok(mixed !== null);
  assert.ok(Math.abs(mixed - (24 + 0.35 * 24) / (32 + 0.35 * 32)) < 1e-12);
  assert.equal(pointsLogPerMinute([row(2026), row(2026), row(2026)], 'log'), 24 / 32);
});
