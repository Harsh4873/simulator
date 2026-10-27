import assert from 'node:assert/strict';
import test from 'node:test';
import { gamesFromScoreboard, parseOutcomeLines, spreadCaption } from '../scripts/build-rate-card.ts';
import { renderSlate, statusLabel } from '../src/slate.ts';
import type { RateCard, Slate, SlateGame } from '../src/types.ts';

function game(overrides: Partial<SlateGame> = {}): SlateGame {
  return {
    event_id: '401909877',
    date: '2026-10-27',
    start_time: '2026-10-27T23:30:00Z',
    season: 2027,
    season_type: 'regular',
    status_state: 'unknown',
    completed: null,
    away: { team_id: '17', name: 'Brooklyn Nets', abbreviation: 'BKN' },
    home: { team_id: '2', name: 'Boston Celtics', abbreviation: 'BOS' },
    spread_caption: null,
    ...overrides,
  };
}

test('status uses the stored ESPN state and the clock only for not started', () => {
  const now = new Date('2026-10-27T18:00:00Z');
  const later = new Date('2026-10-28T02:00:00Z');
  assert.equal(statusLabel(game({ completed: true, status_state: 'pre' }), now), 'final');
  assert.equal(statusLabel(game({ completed: false, status_state: 'post' }), now), 'final');
  assert.equal(statusLabel(game({ completed: false, status_state: 'in' }), now), 'in progress');
  assert.equal(statusLabel(game({ completed: false, status_state: 'pre' }), later), 'not started');
  assert.equal(statusLabel(game({ status_state: 'unknown' }), now), 'not started');
  assert.equal(statusLabel(game({ status_state: 'unknown' }), later), 'unknown');
});

test('a spread caption ignores moneylines and disagreeing rows', () => {
  const picks = [
    { pick: 'Celtics ML (Nets @ Celtics)', away_team: 'Nets', home_team: 'Celtics', predicted_spread: -575 },
    { pick: 'Celtics -19.9 (Nets @ Celtics)', away_team: 'Nets', home_team: 'Celtics', predicted_spread: 19.92 },
  ];
  assert.equal(spreadCaption(picks, 'Brooklyn Nets', 'Boston Celtics'), 'Celtics -19.9 (Nets @ Celtics)');
  assert.equal(
    spreadCaption(
      [
        ...picks,
        { pick: 'Nets +3 (Nets @ Celtics)', away_team: 'Nets', home_team: 'Celtics', predicted_spread: -3 },
      ],
      'Brooklyn Nets',
      'Boston Celtics',
    ),
    null,
  );
  assert.equal(
    spreadCaption(
      [{ pick: 'Hornets -3.5 (Hornets @ Celtics)', away_team: 'Nets', home_team: 'Celtics', predicted_spread: 3.5 }],
      'Charlotte Hornets',
      'Boston Celtics',
    ),
    null,
  );
  assert.equal(
    spreadCaption(
      [{ pick: 'Celtics -19.9 (Nets @ Celtics)', away_team: 'Nets', home_team: 'Celtics', predicted_spread: 19.92 }],
      'BKN',
      'BOS',
    ),
    'Celtics -19.9 (Nets @ Celtics)',
  );
});

test('a missing ESPN state stays unknown instead of guessing from the tip', () => {
  const games = gamesFromScoreboard(
    {
      events: [
        {
          id: '401909877',
          date: '2026-10-27T23:30Z',
          season: { year: 2027, type: 2 },
          competitions: [
            {
              competitors: [
                { homeAway: 'away', team: { id: '17', displayName: 'Brooklyn Nets', abbreviation: 'BKN' } },
                { homeAway: 'home', team: { id: '2', displayName: 'Boston Celtics', abbreviation: 'BOS' } },
              ],
            },
          ],
        },
      ],
    },
    '2026-10-27',
    [{ pick: 'Celtics -19.9 (Nets @ Celtics)', away_team: 'Nets', home_team: 'Celtics', predicted_spread: 19.92 }],
  );
  assert.equal(games.length, 1);
  assert.equal(games[0].status_state, 'unknown');
  assert.equal(games[0].completed, null);
  assert.equal(games[0].season_type, 'regular');
  assert.equal(games[0].season, 2027);
  assert.equal(games[0].start_time, '2026-10-27T23:30:00Z');
  assert.equal(games[0].spread_caption, 'Celtics -19.9 (Nets @ Celtics)');
  assert.equal(games[0].away.abbreviation, 'BKN');
});

test('outcome lines keep the NBA counting stats from 2026 and 2027', () => {
  const rows = parseOutcomeLines(
    [
      '{"sport":"NBA","season":2025,"athlete_id":"1","team_id":"2","event_id":"9","stat_key":"points","actual":10,"minutes":20}',
      '{"sport":"WNBA","season":2026,"athlete_id":"1","team_id":"2","event_id":"9","stat_key":"points","actual":10,"minutes":20}',
      '{"sport":"NBA","season":2026,"athlete_id":"1","team_id":"2","event_id":"9","stat_key":"points","actual":10,"minutes":20}',
      '{"sport":"NBA","season":2027,"athlete_id":"1","team_id":"2","event_id":"8","stat_key":"three_pointers_made","actual":2,"minutes":15}',
      'not-json',
    ].join('\n'),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.stat_key),
    ['points', 'three_pointers_made'],
  );
});

test('slate copy covers the placeholder, an off day, and a card without rates', () => {
  const placeholder: Slate = {
    schema_version: 1,
    generated_at: null,
    date: null,
    timezone: 'America/Chicago',
    games: [],
  };
  const card: RateCard = {
    schema_version: 1,
    generated_at: null,
    date: null,
    iterations: 10000,
    columns: ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'pts', 'reb', 'ast'],
    games: [],
  };
  assert.match(renderSlate(placeholder, card, new Date('2026-10-27T18:00:00Z')), /Today's slate has not been built yet\./);
  const offDay: Slate = { ...placeholder, generated_at: '2026-10-27T15:00:00Z', date: '2026-10-27' };
  assert.match(renderSlate(offDay, card, new Date('2026-10-27T18:00:00Z')), /No NBA games on 2026-10-27\./);
  const ready: Slate = { ...offDay, games: [game()] };
  const html = renderSlate(ready, card, new Date('2026-10-27T18:00:00Z'));
  assert.match(html, /Brooklyn Nets @ Boston Celtics/);
  assert.match(html, /Shooting rates are not ready/);
  assert.match(html, /disabled/);
  const withRates: RateCard = {
    ...card,
    generated_at: '2026-10-27T15:00:00Z',
    date: '2026-10-27',
    games: [{ event_id: '401909877', away_team_id: '17', home_team_id: '2', players: [] }],
  };
  const enabled = renderSlate(ready, withRates, new Date('2026-10-27T18:00:00Z'));
  assert.match(enabled, />Simulate</);
  assert.equal(enabled.includes('disabled'), false);
});
