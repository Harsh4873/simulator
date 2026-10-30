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

test('count evidence blends continuously with shooting exposure', () => {
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
  assert.ok(star.fga_per_min>rookie.fga_per_min);
  assert.ok(star.points_scale!>1);
  assert.ok(priorPointsPerMinute(star)<24/32,'finite evidence is shrunk rather than fully trusted');
  assert.ok(priorPointsPerMinute(star)>priorPointsPerMinute(rookie));
  assert.equal(star.tp_pct,rookie.tp_pct);

});

test('points per minute combines both permitted seasons', () => {
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
