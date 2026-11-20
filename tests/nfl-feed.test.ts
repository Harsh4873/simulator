import assert from 'node:assert/strict';
import test from 'node:test';
import { laterGames } from '../scripts/build-nfl-slate.ts';
import { applyElo, expectedHomeWin, fitElo, marginMultiplier } from '../src/nfl/elo.ts';
import { espnRegularWeeks, espnSeasonType, historyWeeks, parseEspnScoreboard } from '../src/nfl/espn.ts';

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

test('the scoreboard keeps each team\'s overall record and drops a malformed one', () => {
  const games = parseEspnScoreboard({
    events: [
      {
        id: '501',
        date: '2026-11-22T18:00:00Z',
        season: { year: 2026, type: 2 },
        competitions: [
          {
            status: { type: { state: 'pre', completed: false } },
            competitors: [
              { homeAway: 'away', team: { displayName: 'Miami Dolphins', abbreviation: 'MIA' }, records: [{ type: 'total', summary: '1-8' }, { type: 'road', summary: '1-4' }] },
              { homeAway: 'home', team: { displayName: 'Buffalo Bills', abbreviation: 'BUF' }, records: [{ type: 'total', summary: 'eight and one' }] },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(games[0]?.away.record, '1-8');
  assert.equal(games[0]?.home.record, null);
});

test('history covers every regular-season week once the playoffs restart the week count', () => {
  assert.deepEqual(historyWeeks(2, 3).map((slot) => `${slot.seasonType}:${slot.week}`), ['2:1', '2:2', '2:3']);
  const playoffs = historyWeeks(3, 2);
  assert.equal(playoffs.filter((slot) => slot.seasonType === 2).length, 18);
  assert.deepEqual(playoffs.filter((slot) => slot.seasonType === 3).map((slot) => slot.week), [1, 2]);
  assert.deepEqual(historyWeeks(1, 3), []);
  assert.equal(historyWeeks(2, 30).length, 18);
  assert.equal(espnSeasonType({ season: { type: 3, year: 2026 } }), 3);
  assert.equal(espnSeasonType({ leagues: [{ season: { type: { type: 2 } } }] }), 2);
  assert.equal(espnRegularWeeks({ leagues: [{ calendar: [{ label: 'Preseason', entries: [{}] }, { label: 'Regular Season', entries: Array(17).fill({}) }] }] }), 17);
  assert.equal(espnRegularWeeks({}), 18);
});

test('later games are this week\'s games after the Chicago window, earliest first', () => {
  const at = (id: string, start: string) => ({ id, start_time: start }) as Parameters<typeof laterGames>[0][number];
  const week = [at('mon', '2026-11-24T01:15:00.000Z'), at('thu', '2026-11-20T01:15:00.000Z'), at('sun', '2026-11-22T18:00:00.000Z'), at('sun', '2026-11-22T18:00:00.000Z'), at('tonight', '2026-11-20T23:00:00.000Z')];
  assert.deepEqual(laterGames(week, new Set(['thu']), '2026-11-20').map((game) => game.id), ['sun', 'mon']);
});

test('a blowout moves ratings more than a field goal, and a favourite\'s win counts for less', () => {
  assert.ok(marginMultiplier(28, 0) > marginMultiplier(3, 0));
  assert.ok(marginMultiplier(14, 200) < marginMultiplier(14, -200));
  assert.equal(marginMultiplier(0, 0), 1);
  const win = applyElo(1500, 1500, 0, 38, 3, 20, true);
  const close = applyElo(1500, 1500, 0, 20, 17, 20, true);
  assert.ok(win.home - 1500 > close.home - 1500);
  assert.equal(applyElo(1500, 1500, 0, 24, 17).home, 1510);
});

test('Elo settings are chosen after the warm-up, and the holdout is the latest 30% untouched', () => {
  const teams = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
  const strength: Record<string, number> = { AAA: 14, BBB: 7, CCC: 3, DDD: -3, EEE: -7, FFF: -14 };
  const games = [];
  for (let i = 0; i < 120; i += 1) {
    const home = teams[i % 6]!;
    const away = teams[(i * 5 + 1) % 6]!;
    if (home === away) continue;
    const gap = strength[home]! - strength[away]! + ((i * 7) % 11) - 5;
    games.push({ id: `g${i}`, start_time: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(), home, away, home_score: 20 + Math.max(0, gap), away_score: 20 + Math.max(0, -gap) + (gap === 0 ? 1 : 0), neutral: false });
  }
  const fit = fitElo(games)!;
  assert.ok(fit);
  assert.equal(fit.holdout_games, games.length - Math.floor(games.length * 0.7));
  assert.ok([10, 15, 20, 25, 30, 35, 40, 50, 60].includes(fit.k));
  assert.equal(typeof fit.margin, 'boolean');
  assert.ok(fit.holdout_brier < 0.25, `holdout ${fit.holdout_brier}`);
  assert.ok((fit.ratings.get('AAA') ?? 0) > (fit.ratings.get('FFF') ?? 0));
  // Too few games to warm up, choose and hold out: no fit.
  assert.equal(fitElo(games.slice(0, 60)), null);
});
