import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { columnSums, nextBoxSort, orderPlayers, renderBoxScore, renderPlayerPanel } from '../src/boxscore.ts';
import { nextPanelAthlete, typicalityBucket } from '../src/display.ts';
import type { MarginalRead, Simulation, SimulatedPlayer } from '../src/simulate.ts';
import type { RatePlayer, SlateGame } from '../src/types.ts';

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

const now = new Date('2026-10-28T12:00:00Z');

function read(percent: number, constant = false): MarginalRead {
  return { percent, constant, bucket: typicalityBucket(percent, constant) };
}

function reads(overrides: Partial<SimulatedPlayer['reads']> = {}): SimulatedPlayer['reads'] {
  const base = read(71);
  return { min: base, tpm: base, pts: base, reb: base, ast: base, ...overrides };
}

function player(overrides: Partial<SimulatedPlayer> = {}): SimulatedPlayer {
  return {
    athlete_id: '1',
    name: 'Regular Player',
    team_id: '17',
    injury_status: 'healthy',
    minutes_weight: 1,
    thin_sample: false,
    games: 40,
    games_2026: 37,
    games_2027: 3,
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
    band: { p05: 4, p10: 8, p50: 17, p90: 22, p95: 28 },
    reads: reads(),
    ...overrides,
  };
}

function score(overtime: boolean): Simulation {
  const awayPlayers = [
    player({
      athlete_id: '2',
      name: 'Thin Player',
      thin_sample: true,
      games: 3,
      shooting_games: 1,
      min: 18,
      pts: 9,
      fgm: 3,
      fga: 8,
      tpm: 1,
      tpa: 3,
      ftm: 2,
      fta: 2,
    }),
    player({
      athlete_id: '1',
      name: 'Regular Player',
      min: 30,
      reads: reads({ min: read(100, true) }),
    }),
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
  const homePlayers = [
    player({
      athlete_id: '9',
      name: 'Home Player',
      team_id: '2',
      min: 24,
      pts: 11,
      fgm: 4,
      fga: 9,
      tpm: 1,
      tpa: 2,
      ftm: 2,
      fta: 2,
      reb: 3,
      ast: 2,
    }),
  ];
  const awayPts = awayPlayers.reduce((sum, item) => sum + item.pts, 0);
  const homePts = homePlayers.reduce((sum, item) => sum + item.pts, 0);
  const away = {
    team_id: '17',
    pts: awayPts,
    band: { p05: 80, p10: 90, p50: 108, p90: 124, p95: 140 },
    volumeShock: 1.25,
    pointsRead: read(64),
    players: awayPlayers,
  };
  const home = {
    team_id: '2',
    pts: homePts,
    band: { p05: 70, p10: 88, p50: 104, p90: 120, p95: 130 },
    volumeShock: 0.5,
    pointsRead: read(12),
    players: homePlayers,
  };
  const view = {
    overtime,
    budget: overtime ? 265 : 240,
    overtimePeriods: overtime ? 1 : 0,
    regulationAwayPts: awayPts,
    regulationHomePts: homePts,
    away,
    home,
  };
  return {
    ...view,
    index: 0,
    upsideIndex: 0,
    missingShootingAthleteIds: [],
    combinedTotals: [awayPts + homePts],
    awayTotals: [awayPts],
    homeTotals: [homePts],
    wins: { away: 2500, tie: 0, home: 7500 },
    upside: view,
  };
}

function cardRow(overrides: Partial<RatePlayer> = {}): RatePlayer {
  return {
    athlete_id: '1',
    name: 'Regular Player',
    team_id: '17',
    position: 'PG',
    position_group: 'Guard',
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
    games_2026: 10,
    games_2027: 10,
    games: 20,
    shooting_games: 20,
    thin_sample: false,
    minutes_mean: 32.04,
    fga_per_min: 0.5,
    fta_per_min: 0.14,
    tpa_given_fga: 0.4,
    fg2_pct: 0.48,
    tp_pct: 0.37,
    ft_pct: 0.84,
    reb_per_min: 0.12,
    ast_per_min: 0.22,
    ...overrides,
  };
}

function rates() {
  return {
    event_id: '1',
    away_team_id: '17',
    home_team_id: '2',
    players: [
      cardRow({
        athlete_id: '1',
        games_2026: 0,
        games_2027: 7,
        games: 7,
        shooting_games: 5,
      }),
      cardRow({
        athlete_id: '3',
        name: 'Out Player',
        minutes_weight: 0,
        injury_status: 'out',
        questionable_widen: false,
        position: 'SF',
        position_group: 'Forward',
      }),
      cardRow({
        athlete_id: '9',
        name: 'Home Player',
        team_id: '2',
        games_2026: 0,
        games_2027: 8,
        games: 8,
        shooting_games: 8,
        injury_status: 'questionable',
        questionable_widen: true,
        position: 'C',
        position_group: 'Center',
      }),
    ],
  };
}

function rowFor(html: string, athleteId: string): string {
  const marker = `data-athlete="${athleteId}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0);
  const trStart = html.lastIndexOf('<tr', start);
  const trEnd = html.indexOf('</tr>', start);
  return html.slice(trStart, trEnd);
}

test('stat toggles reorder each team and leave players who did not play at the bottom', () => {
  const model = score(false);
  const minutes = orderPlayers(model.away.players);
  assert.deepEqual(minutes.map((item) => item.athlete_id), ['1', '2', '3']);
  const points = orderPlayers(model.away.players, nextBoxSort({ key: 'min', direction: 'desc' }, 'pts'));
  assert.deepEqual(points.map((item) => item.athlete_id), ['1', '2', '3']);
  const fewestPoints = orderPlayers(model.away.players, { key: 'pts', direction: 'asc' });
  assert.deepEqual(fewestPoints.map((item) => item.athlete_id), ['2', '1', '3']);
  assert.deepEqual(nextBoxSort({ key: 'reb', direction: 'desc' }, 'reb'), { key: 'reb', direction: 'asc' });
  model.home.players.push(player({
    athlete_id: '8',
    name: 'Bench Player',
    team_id: '2',
    min: 10,
    pts: 30,
    reb: 12,
  }));
  const html = renderBoxScore(game, null, model, now, {
    away: { key: 'min', direction: 'desc' },
    home: { key: 'pts', direction: 'desc' },
  });
  assert.match(html, /aria-label="Sort Away Name"/);
  assert.match(html, /aria-label="Sort Home Name"/);
  const away = html.split('<section class="team-box" data-side="away">')[1]?.split('<section class="team-box" data-side="home">')[0] ?? '';
  const home = html.split('<section class="team-box" data-side="home">')[1] ?? '';
  assert.match(away, /data-sort="min" aria-pressed="true"/);
  assert.match(home, /data-sort="pts" aria-pressed="true"/);
  assert.match(away, /data-sort="pts" aria-pressed="false"/);
  assert.equal(away.includes('data-side="home"'), false);
  assert.ok(away.indexOf('data-athlete="1"') < away.indexOf('data-athlete="2"'));
  assert.ok(away.indexOf('data-athlete="2"') < away.indexOf('data-athlete="3"'));
  assert.ok(home.indexOf('data-athlete="8"') < home.indexOf('data-athlete="9"'));
});

test('the scoreboard shows the median-nearest game and its interval', () => {
  const model = score(false);
  const html = renderBoxScore(game, null, model, now);
  assert.match(html, /Away Name/);
  assert.match(html, /Home Name/);
  assert.match(html, /<p class="score away">26<\/p>/);
  assert.match(html, /<p class="score home">11<\/p>/);
  assert.match(html, /Nearest the median combined score/);
  assert.match(html, /Upside scenario: the 95th percentile of the combined score\. Not the forecast\./);
  assert.equal(html.includes('95th percentile of 10,000 games'), false);
  assert.match(html, /5th to 95th percentile/);
  assert.match(html, /<p class="interval away">80–140<\/p>/);
  assert.match(html, /<p class="interval home">70–130<\/p>/);
  assert.equal(html.includes('One simulated game'), false);
  assert.equal(html.includes('Random draw'), false);
  assert.equal(html.includes('Median of 10,000 games'), false);
  assert.match(html, /Away wins 25\.0%\. Tie 0\.0%\. Home wins 75\.0%/);
  assert.match(html, /Tie 0\.0%/);
  assert.match(html, /flex-grow: 2500/);
  assert.match(html, /flex-grow: 0/);
  assert.match(html, /flex-grow: 7500/);
  assert.match(html, /class="team-pct away tone" data-bucket="1">64%</);
  assert.match(html, /class="team-pct home tone" data-bucket="4">12%</);
  const away = html.split('data-footer="away"')[1]?.split('</tr>')[0] ?? '';
  const sums = columnSums(model.away.players);
  for (const key of ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'reb', 'ast'] as const) {
    assert.match(away, new RegExp(`data-col="${key}">${sums[key]}<`));
  }
  assert.match(away, new RegExp(`data-col="pts" data-bucket="1"><span class="stat">${sums.pts}</span><span class="pct">64%</span>`));
  const regular = rowFor(html, '1');
  assert.match(regular, /data-col="min" data-bucket="0"><span class="stat">30<\/span><\/td>/);
  assert.match(regular, /data-col="fga">12</);
  assert.match(regular, /data-col="pts" data-bucket="2"><span class="stat">17<\/span><span class="pct">71%<\/span>/);
  assert.match(regular, /<button type="button" class="player-btn" data-athlete="1">/);
  const held = rowFor(html, '3');
  assert.equal(held.includes('data-bucket'), false);
  assert.match(held, />out</);
  assert.equal(html.includes('10th'), false);
  assert.equal(html.includes('90–'), false);
  assert.equal(html.includes('p10'), false);
  assert.equal(html.includes('p90'), false);
  assert.equal(html.includes('class="band"'), false);
  assert.equal(/data-col="(?:fgm|fga|tpa|ftm|fta)"[^>]*data-bucket/.test(regular), false);
  assert.equal(html.includes('undefined'), false);
  assert.equal(html.includes('<a '), false);
  assert.equal(html.includes('title='), false);
  assert.match(html, /This box score is the simulated game nearest the median combined score\./);
  assert.equal(html.includes('This box score is the simulated game at the 95th percentile of the combined score.'), false);
  assert.match(html, /The minutes column totals team-minutes: five players on the floor at once\. Regulation is 240 \(5 × 48\)\. Overtime is 265 \(5 × 53\)\. It is not the length of the game\./);
  assert.match(html, /240 team-minutes · 5 × 48/);
  assert.equal(html.includes('not a five-man lineup'), false);
  assert.equal(html.includes('265 minutes'), false);
  assert.equal(html.includes('265 team-minutes'), false);
  const tableAt = html.indexOf('<table');
  const noteAt = html.indexOf('This box score is the simulated game nearest the median combined score');
  assert.ok(tableAt >= 0 && noteAt > tableAt);
  assert.match(html, /Brighter blue means that number is further from this player's middle in the 10,000 games\./);
  assert.match(html, /<span class="pct">/);
  assert.match(html, /data-bucket=/);
  const colorsAt = html.indexOf('Probability colors');
  assert.ok(colorsAt >= 0 && tableAt >= 0 && colorsAt < tableAt);
  assert.match(html, /<input type="checkbox" data-probability-colors>/);
  assert.equal(/<input\b[^>]*\bchecked\b/.test(html), false);
  assert.equal(html.includes('>OT<'), false);
  assert.equal(html.includes('This line is one random draw'), false);
});

test('the upside control labels the 95th percentile scenario', () => {
  const model = score(false);
  const html = renderBoxScore(game, null, model, now, undefined, 'upside');
  assert.match(html, /Upside scenario: the 95th percentile of the combined score\. Not the forecast\./);
  assert.match(html, /<input type="checkbox" data-upside-scenario checked>/);
  assert.equal(html.includes('Nearest the median combined score'), false);
  assert.equal(html.includes('This box score is the simulated game nearest the median combined score.'), false);
  assert.match(html, /<p class="score away">26<\/p>/);
  assert.match(html, /<p class="score home">11<\/p>/);
  assert.match(html, /Win rate in 10,000 games/);
  const panel = renderPlayerPanel(game, rates(), model, '1', 'upside');
  assert.match(panel, /This line is from the upside scenario: the 95th percentile of the combined score\. Not the forecast\./);
  assert.equal(panel.includes('nearest the median combined score'), false);
});

test('an empty abbreviation falls back to the team name', () => {
  const blank: SlateGame = {
    ...game,
    away: { team_id: '17', name: 'Away Name', abbreviation: '' },
    home: { team_id: '2', name: 'Home Name', abbreviation: '' },
  };
  const html = renderBoxScore(blank, null, score(false), now);
  assert.match(html, /class="abbr away">Away Name</);
  assert.match(html, /class="abbr home">Home Name</);
  assert.match(html, /class="score away">26</);
  assert.match(html, /class="score home">11</);
  assert.equal(html.includes('undefined'), false);
});

test('OT is labeled only on an overtime draw', () => {
  const regulation = renderBoxScore(game, null, score(false), now);
  const overtime = renderBoxScore(game, null, score(true), now);
  assert.equal(regulation.includes('>OT<'), false);
  assert.match(regulation, /240 team-minutes · 5 × 48/);
  assert.match(overtime, />OT</);
  assert.match(overtime, /265 team-minutes · 5 × 53/);
  assert.equal(regulation.includes('265 minutes'), false);
  assert.equal(overtime.includes('265 minutes'), false);
  assert.equal(regulation.includes('265 team-minutes'), false);
  assert.equal(overtime.includes('240 team-minutes'), false);
});

test('the panel opens, swaps, and closes from the player button', () => {
  const model = score(false);
  const card = rates();
  const page = renderBoxScore(game, card, model, now);
  assert.match(page, /data-athlete="1"/);
  assert.equal(page.includes('data-panel'), false);
  const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(shell, /data-region="games"/);
  assert.match(shell, /data-region="stage"/);
  assert.match(shell, /data-region="player"/);
  assert.match(shell, /data-panel/);
  assert.equal(nextPanelAthlete(null, '1'), '1');
  const open = renderPlayerPanel(game, card, model, '1');
  assert.match(open, /type="button" data-close/);
  assert.match(open, /Regular Player/);
  assert.match(open, /<span class="stat">17<\/span>/);
  assert.match(open, /Away Name/);
  assert.match(open, /PG/);
  assert.match(open, /Guard/);
  assert.match(open, /This line is from the simulated game nearest the median combined score\./);
  assert.equal(open.includes('<a '), false);
  assert.equal(open.includes('title='), false);
  const swapped = renderPlayerPanel(game, card, model, '9');
  assert.match(swapped, /Home Player/);
  assert.equal(swapped.includes('Regular Player'), false);
  assert.equal(nextPanelAthlete('1', '9'), '9');
  assert.equal(nextPanelAthlete('1', '1'), null);
  assert.equal(nextPanelAthlete('1', null), null);
  const imgAt = open.indexOf('<img');
  const nameAt = open.indexOf('who-name');
  assert.ok(imgAt >= 0 && nameAt >= 0 && imgAt < nameAt);
  assert.match(open, /<img class="headshot" alt="Regular Player" src="https:\/\/a\.espncdn\.com\/i\/headshots\/nba\/players\/full\/1\.png"/);
});

test('a missing photo shows a monogram and says the photo is not in the data', () => {
  const model = score(false);
  model.away.players[1] = player({ athlete_id: 'player-x', name: 'Ghost Player' });
  const bare = renderPlayerPanel(game, { event_id: '1', players: [] }, model, 'player-x');
  assert.equal(bare.includes('<img'), false);
  assert.match(bare, /class="mono">G</);
  assert.match(bare, /Photo is not in the data\./);
  assert.equal(bare.includes('<a '), false);
  assert.equal(bare.includes('title='), false);
});

test('thin sample follows the 2026 and 2027 counts', () => {
  const model = score(false);
  const card = rates();
  const thin = renderPlayerPanel(game, card, model, '1');
  assert.match(thin, /Prior season \(2026\): 0 games\. This season \(2027\): 7 games\./);
  assert.match(thin, /Thin sample: no games in 2026 and fewer than 8 in 2027\./);
  assert.match(thin, /Shooting sample: 5 games\./);
  assert.match(thin, /No absence flag on the card\./);
  assert.equal(thin.includes('Shot rates are the team and position prior.'), false);
  assert.match(thin, /Shrunk minutes rate: 32\.0\./);
  assert.match(thin, /scaled to 240 team-minutes \(5 × 48\)/);
  assert.match(thin, /Team volume shock this draw: 1\.25\./);
  assert.equal(thin.includes('265 minutes'), false);
  assert.equal(thin.includes('265 team-minutes'), false);
  assert.equal(thin.includes('Overtime. This draw used 265 minutes.'), false);
  const eight = renderPlayerPanel(game, card, model, '9');
  assert.match(eight, /Prior season \(2026\): 0 games\. This season \(2027\): 8 games\./);
  assert.equal(eight.includes('Thin sample: no games in 2026 and fewer than 8 in 2027.'), false);
  assert.match(eight, /Questionable\. Minutes stay centered on the shrunk rate, with a wider draw\./);
  assert.equal(eight.includes('No absence flag on the card.'), false);
  const out = renderPlayerPanel(game, card, model, '3');
  assert.match(out, /Out of the rotation \(out\)\./);
  assert.equal(out.includes('data-bucket'), false);
  const overtime = renderPlayerPanel(game, card, score(true), '1');
  assert.match(overtime, /This draw used 265 team-minutes \(5 × 53\)\./);
  assert.match(overtime, /scaled to 265 team-minutes \(5 × 53\)/);
  assert.equal(overtime.includes('265 minutes'), false);
  assert.equal(overtime.includes('scaled to 240 team-minutes'), false);
});

test('a player with no shooting sample is told the shot rates are the prior', () => {
  const model = score(false);
  const flagged = renderPlayerPanel(
    game,
    {
      event_id: '1',
      players: [cardRow({ athlete_id: '2', name: 'Thin Player', shooting_games: 0, games: 1, missing_shooting: true })],
    },
    model,
    '2',
  );
  assert.match(flagged, /Shot rates are the team and position prior\./);
  const unlabeled = renderPlayerPanel(
    game,
    {
      event_id: '1',
      players: [cardRow({ athlete_id: '2', name: 'Thin Player', shooting_games: 0, games: 1 })],
    },
    model,
    '2',
  );
  assert.match(unlabeled, /Shot rates are the team and position prior\./);
});

test('missing optional fields do not throw', () => {
  const model = score(false);
  model.away.volumeShock = Number.NaN;
  const row: Partial<RatePlayer> = {
    athlete_id: '1',
    team_id: '17',
    minutes_weight: 1,
    questionable_widen: false,
    games_2027: 3,
    position: '',
  };
  const card = { event_id: '1', players: [row] };
  let html = '';
  assert.doesNotThrow(() => {
    html = renderPlayerPanel(game, card, model, '1');
  });
  assert.match(html, /Regular Player/);
  assert.match(html, /<span class="stat">17<\/span>/);
  assert.match(html, /Injury status is not in the data\./);
  assert.match(html, /Position is not in the data\./);
  assert.match(html, /Shrunk minutes rate: not in the data\./);
  assert.match(html, /Field-goal attempts per minute: not in the data/);
  assert.match(html, /Team volume shock is not in the data\./);
  assert.equal(html.includes('Thin sample:'), false);
  assert.equal(html.includes('undefined'), false);
  const missing = renderPlayerPanel(game, { players: [] }, model, '1');
  assert.match(missing, /This player is not on the rate card\./);
  assert.match(missing, /Regular Player/);
});

test('the layout colors stay on the blue scale', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const hex of ['#1e3344', '#1a4d68', '#1a6a8c', '#2f8eb0', '#5eabc4', '#a9d4e4', '#e7f5fb', '#4da6ff', '#5a7085', '#00e5a0']) {
    assert.ok(css.includes(hex), hex);
  }
  for (const hex of ['#1e3344', '#1a4d68', '#1a6a8c', '#2f8eb0', '#5eabc4', '#a9d4e4', '#e7f5fb']) {
    const at = css.indexOf(hex);
    assert.match(css.slice(Math.max(0, at - 240), at), /\[data-colors="on"\]/);
  }
  assert.match(css, /\.seg-away \{ background: #4da6ff; \}/);
  assert.equal(css.includes('.desk[data-colors="on"] .seg-away'), false);
  assert.match(css, /90rem/);
  assert.match(css, /4\.5rem/);
  assert.match(css, /22rem/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) 22rem/);
  assert.match(css, /max-width:\s*800px/);
  assert.match(css, /150ms/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.equal(css.includes('880px'), false);
});
