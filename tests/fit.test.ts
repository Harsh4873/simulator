import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  K_FT,
  assignInjury,
  fitPlayers,
  isThinSample,
  positionGroup,
  shrinkRate,
} from '../src/fit.ts';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const shrink = JSON.parse(readFileSync(join(fixtureDir, 'fixtures/shrink-ft.json'), 'utf8')) as {
  k: number;
  league: { s: number; e: number };
  team: { s: number; e: number };
  position: { s: number; e: number };
  player: { s: number; e: number };
  expected: number;
};

test('free-throw shrinkage matches the locked case', () => {
  assert.equal(shrink.k, K_FT);
  const fitted = shrinkRate({
    k: shrink.k,
    league: shrink.league,
    team: shrink.team,
    position: shrink.position,
    player: shrink.player,
    blendPosition: true,
  });
  assert.ok(fitted !== null);
  assert.ok(Math.abs(fitted - shrink.expected) < 1e-9);
});

test('an empty position skips the position blend', () => {
  assert.equal(positionGroup(''), '');
  assert.equal(positionGroup('UTIL'), '');
  const blended = shrinkRate({
    k: shrink.k,
    league: shrink.league,
    team: shrink.team,
    position: shrink.position,
    player: shrink.player,
    blendPosition: true,
  });
  const skipped = shrinkRate({
    k: shrink.k,
    league: shrink.league,
    team: shrink.team,
    position: shrink.position,
    player: shrink.player,
    blendPosition: positionGroup('') !== '',
  });
  const leagueRate = shrink.league.s / shrink.league.e;
  const teamRate = (shrink.team.s + shrink.k * leagueRate) / (shrink.team.e + shrink.k);
  const teamOnly = (shrink.player.s + shrink.k * teamRate) / (shrink.player.e + shrink.k);
  assert.ok(skipped !== null && blended !== null);
  assert.ok(Math.abs(skipped - teamOnly) < 1e-9);
  assert.ok(Math.abs(blended - skipped) > 1e-4);
});

test('injury weights follow the out and questionable rules', () => {
  for (const status of ['out', 'Out', 'injured reserve', 'suspension']) {
    const assigned = assignInjury(status);
    assert.equal(assigned.minutes_weight, 0);
    assert.equal(assigned.questionable_widen, false);
  }
  assert.equal(assignInjury('doubtful').questionable_widen,true);
  assert.equal(assignInjury('day-to-day').questionable_widen,true);
  assert.deepEqual(assignInjury('questionable'), {
    injury_status: 'questionable',
    minutes_weight: 1,
    questionable_widen: true,
  });
  assert.deepEqual(assignInjury('probable'), {
    injury_status: 'probable',
    minutes_weight: 1,
    questionable_widen: false,
  });
  assert.deepEqual(assignInjury(''), {
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
  });
  assert.deepEqual(assignInjury('   '), {
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
  });
});

test('thin sample is only a player with no 2026 games and fewer than 8 in 2027', () => {
  assert.equal(isThinSample(0, 0), true);
  assert.equal(isThinSample(0, 7), true);
  assert.equal(isThinSample(0, 8), false);
  assert.equal(isThinSample(1, 0), false);
  assert.equal(isThinSample(1, 3), false);
});

test('rates use shooting attempts and gzip rebounds, and an id injury wins', () => {
  const fitted = fitPlayers({
    roster: [
      {
        athlete_id: '1',
        name: 'Alpha Player',
        team_id: '2',
        position: 'SF',
        headshot_url: 'https://a.espncdn.com/i/headshots/nba/players/full/1.png',
      },
      { athlete_id: '2', name: 'Beta Player', team_id: '2', position: '' },
    ],
    injuries: [
      { athlete_id: '1', name: 'Someone Else', status: 'out' },
      { name: 'Alpha-Player', status: 'questionable' },
      { name: 'Beta Player', status: 'questionable' },
    ],
    outcomes: [
      {
        season: 2026,
        athlete_id: '1',
        team_id: '2',
        event_id: '10',
        stat_key: 'points',
        actual: 20,
        minutes: 30,
      },
      {
        season: 2026,
        athlete_id: '1',
        team_id: '2',
        event_id: '10',
        stat_key: 'totalRebounds',
        actual: 10,
        minutes: 30,
      },
      {
        season: 2026,
        athlete_id: '1',
        team_id: '2',
        event_id: '10',
        stat_key: 'assists',
        actual: 4,
        minutes: 30,
      },
    ],
    shooting: [
      {
        athlete_id: '1',
        team_id: '2',
        season: 2026,
        games: 2,
        minutes: 20,
        fgm: 5,
        fga: 10,
        tpm: 1,
        tpa: 4,
        ftm: 8,
        fta: 10,
        reb: 99,
        ast: 99,
        pts: 16,
      },
    ],
  });
  assert.equal(fitted.publish, true);
  const alpha = fitted.players.find((player) => player.athlete_id === '1');
  const beta = fitted.players.find((player) => player.athlete_id === '2');
  assert.ok(alpha && beta);
  assert.equal(alpha.injury_status, 'out');
  assert.equal(alpha.minutes_weight, 0);
  assert.equal(alpha.questionable_widen, false);
  assert.equal(alpha.games, 1);
  assert.equal(alpha.games_2026, 1);
  assert.equal(alpha.shooting_games, 2);
  assert.equal(alpha.thin_sample, false);
  assert.equal(alpha.position_group, 'Forward');
  assert.equal(alpha.headshot_url, 'https://a.espncdn.com/i/headshots/nba/players/full/1.png');
  assert.equal(Object.hasOwn(beta, 'headshot_url'), false);
  assert.ok(Math.abs(alpha.fga_per_min / alpha.points_scale! - 0.5) < 1e-9);
  assert.ok(Math.abs(alpha.ft_pct - 0.8) < 1e-9);
  assert.ok(Math.abs(alpha.reb_per_min - 1 / 3) < 1e-9);
  assert.equal(beta.injury_status, 'questionable');
  assert.equal(beta.minutes_weight, 1);
  assert.equal(beta.questionable_widen, true);
  assert.equal(beta.position_group, '');
  assert.equal(beta.games, 0);
  assert.equal(beta.thin_sample, true);
  assert.ok(Math.abs(beta.ft_pct - 0.8) < 1e-9);
  assert.ok(Math.abs(beta.minutes_mean - 30) < 1e-9);
});

test('zero-minute DNP rows do not count as zero-stat games', () => {
  const roster = [{ athlete_id: '1', name: 'Alpha Player', team_id: '2', position: 'SF' }];
  const shooting = [{
    athlete_id: '1', team_id: '2', season: 2026, games: 2, minutes: 20,
    fgm: 5, fga: 10, tpm: 1, tpa: 4, ftm: 8, fta: 10, reb: 8, ast: 4, pts: 16,
  }];
  const outcomes = [
    { season: 2026, athlete_id: '1', team_id: '2', event_id: '10', stat_key: 'points' as const, actual: 20, minutes: 30 },
    { season: 2026, athlete_id: '1', team_id: '2', event_id: '10', stat_key: 'totalRebounds' as const, actual: 10, minutes: 30 },
  ];
  const base = fitPlayers({ roster, injuries: [], shooting, outcomes }).players[0];
  const withDnp = fitPlayers({
    roster,
    injuries: [],
    shooting: [...shooting, {
      athlete_id: '1', team_id: '2', season: 2026, games: 1, minutes: 0,
      fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, reb: 0, ast: 0, pts: 0,
    }],
    outcomes: [
      ...outcomes,
      { season: 2026, athlete_id: '1', team_id: '2', event_id: '11', stat_key: 'points', actual: 0, minutes: 0 },
      { season: 2026, athlete_id: '1', team_id: '2', event_id: '11', stat_key: 'totalRebounds', actual: 0, minutes: 0 },
    ],
  }).players[0];
  assert.equal(withDnp.shooting_games, base.shooting_games);
  assert.equal(withDnp.games, base.games);
  assert.equal(withDnp.games_2026, base.games_2026);
  assert.equal(withDnp.minutes_mean, base.minutes_mean);
  assert.equal(withDnp.fga_per_min, base.fga_per_min);
  assert.equal(withDnp.reb_per_min, base.reb_per_min);
});
