import assert from 'node:assert/strict';
import test from 'node:test';
import { applyElo, expectedHomeWin, fitElo } from '../src/nfl/elo.ts';
import { parseEspnScoreboard } from '../src/nfl/espn.ts';

test('elo gives a home win half of K and does not read a market', () => {
  const next = applyElo(1500, 1500, 0, 24, 17);
  assert.equal(next.expected, 0.5);
  assert.equal(next.home, 1510);
  assert.equal(next.away, 1490);
  assert.ok(expectedHomeWin(1600, 1500, 0) > 0.5);
  assert.ok(expectedHomeWin(1500, 1500, 65) > 0.5);
});

test('the scoreboard parser keeps the game and drops the odds object', () => {
  const payload = {
    events: [
      {
        id: '401',
        date: '2026-11-20T01:15:00Z',
        season: { year: 2026, type: 2 },
        competitions: [
          {
            neutralSite: false,
            venue: { fullName: 'NRG Stadium' },
            status: { type: { state: 'pre', completed: false } },
            odds: [{ provider: { name: 'book' }, spread: -3.5, overUnder: 44.5, homeTeamOdds: { moneyLine: -150 } }],
            competitors: [
              { homeAway: 'away', score: '0', team: { displayName: 'Indianapolis Colts', abbreviation: 'IND', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/ind.png', color: '002C5F' } },
              { homeAway: 'home', score: '0', team: { displayName: 'Houston Texans', abbreviation: 'HOU', logo: 'https://not-espn.example/hou.png', color: 'nope' } },
            ],
          },
        ],
      },
    ],
  };
  const games = parseEspnScoreboard(payload);
  assert.equal(games.length, 1);
  const game = games[0]!;
  assert.equal(game.status, 'scheduled');
  assert.equal(game.away.score, null);
  assert.equal(game.home.score, null);
  assert.equal(game.away.logo_url, 'https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/ind.png');
  assert.equal(game.home.logo_url, null);
  assert.equal(game.away.color, '#002c5f');
  assert.equal(game.home.color, null);
  assert.equal(game.venue, 'NRG Stadium');
  const text = JSON.stringify(games);
  assert.equal(text.includes('spread'), false);
  assert.equal(text.includes('moneyLine'), false);
  assert.equal(text.includes('overUnder'), false);
  assert.equal(text.includes('-3.5'), false);
  assert.equal(text.includes('-150'), false);
});

test('a final without a score is not given one', () => {
  const games = parseEspnScoreboard({
    events: [
      {
        id: '9',
        date: '2026-11-16T01:00:00Z',
        competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: [{ homeAway: 'away', team: { displayName: 'A', abbreviation: 'AAA' } }, { homeAway: 'home', score: 20, team: { displayName: 'B', abbreviation: 'BBB' } }] }],
      },
    ],
  });
  assert.equal(games.length, 0);
});

test('home advantage is fit on earlier games and the holdout is scored separately', () => {
  const games = [];
  for (let i = 0; i < 80; i += 1) {
    const homeWins = i % 5 !== 0;
    games.push({
      id: `g${i}`,
      start_time: new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString(),
      home: i % 2 === 0 ? 'HOM' : 'HOM',
      away: 'AWA',
      home_score: homeWins ? 24 : 14,
      away_score: homeWins ? 14 : 24,
      neutral: false,
    });
  }
  const fit = fitElo(games);
  assert.ok(fit);
  assert.equal(fit.holdout_games, 24);
  assert.ok(fit.hfa >= 0);
  assert.equal(fit.pregame_home_win.size, 80);
  assert.ok(fit.holdout_brier >= 0 && fit.holdout_brier <= 1);
});
