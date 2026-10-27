import assert from 'node:assert/strict';
import test from 'node:test';
import { columnSums, renderBoxScore } from '../src/boxscore.ts';
import type { Simulation, SimulatedPlayer } from '../src/simulate.ts';
import type { SlateGame } from '../src/types.ts';

const game: SlateGame = {
  event_id: '1',
  date: '2026-10-27',
  start_time: '2026-10-27T23:30:00Z',
  season: 2027,
  season_type: 'regular',
  status_state: 'unknown',
  completed: null,
  away: { team_id: '17', name: 'Away Name', abbreviation: 'AWY' },
  home: { team_id: '2', name: 'Home Name', abbreviation: 'HOM' },
  spread_caption: null,
};

function player(overrides: Partial<SimulatedPlayer>): SimulatedPlayer {
  return {
    athlete_id: '1',
    name: 'Regular Player',
    team_id: '17',
    injury_status: 'healthy',
    minutes_weight: 1,
    thin_sample: false,
    games: 40,
    shooting_games: 40,
    min: 30,
    fgm: 6,
    fga: 12,
    tpm: 2,
    tpa: 5,
    ftm: 3,
    fta: 4,
    pts: 17,
    reb: 5,
    ast: 4,
    band: { p10: 8, p50: 17, p90: 22 },
    ...overrides,
  };
}

function score(overtime: boolean): Simulation {
  const awayPlayers = [
    player({ athlete_id: '2', name: 'Thin Player', thin_sample: true, games: 3, shooting_games: 1, min: 18, pts: 9, fgm: 3, fga: 8, tpm: 1, tpa: 3, ftm: 2, fta: 2 }),
    player({ athlete_id: '1', name: 'Regular Player', min: 30 }),
    player({
      athlete_id: '3',
      name: 'Out Player',
      minutes_weight: 0,
      injury_status: 'out',
      min: 0,
      fgm: 0,
      fga: 0,
      tpm: 0,
      tpa: 0,
      ftm: 0,
      fta: 0,
      pts: 0,
      reb: 0,
      ast: 0,
      games: 12,
      shooting_games: 12,
    }),
  ];
  const homePlayers = [player({ athlete_id: '9', name: 'Home Player', team_id: '2', min: 24, pts: 11, fgm: 4, fga: 9, tpm: 1, tpa: 2, ftm: 2, fta: 2, reb: 3, ast: 2 })];
  const awayPts = awayPlayers.reduce((sum, item) => sum + item.pts, 0);
  const homePts = homePlayers.reduce((sum, item) => sum + item.pts, 0);
  return {
    overtime,
    budget: overtime ? 265 : 240,
    index: 0,
    combinedTotals: [awayPts + homePts],
    away: { team_id: '17', pts: awayPts, band: { p10: 90, p50: 108, p90: 124 }, players: awayPlayers },
    home: { team_id: '2', pts: homePts, band: { p10: 88, p50: 104, p90: 120 }, players: homePlayers },
  };
}

test('the box score names the matchup, sums the footer, and labels thin rows', () => {
  const model = score(false);
  const html = renderBoxScore(game, model, new Date('2026-10-28T12:00:00Z'));
  assert.match(html, /Away Name @ Home Name/);
  const away = html.split('data-footer="away"')[1]?.split('</tr>')[0] ?? '';
  const sums = columnSums(model.away.players);
  for (const key of ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'reb', 'ast'] as const) {
    assert.match(away, new RegExp(`data-col="${key}">${sums[key]}<`));
  }
  assert.match(away, new RegExp(`data-col="pts"><span class="pts">${sums.pts}</span>`));
  assert.equal(html.match(/thin sample/g)?.length, 1);
  assert.match(html, /thin sample · 3 games/);
  assert.match(html, /shooting sample 1/);
  assert.equal(html.includes('>OT<'), false);
  assert.match(html, /10,000 simulated games\. This table is one of them\. The range under points is the 10th to 90th percentile\./);
  assert.match(html, /Minutes are a rotation draw, not a five-man lineup\./);
});

test('OT is labeled only on an overtime draw', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const regulation = renderBoxScore(game, score(false), now);
  const overtime = renderBoxScore(game, score(true), now);
  assert.equal(regulation.includes('OT'), false);
  assert.match(overtime, />OT</);
  assert.match(overtime, /265 minutes/);
  assert.equal(regulation.includes('265 minutes'), false);
});
