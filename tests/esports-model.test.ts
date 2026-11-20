import assert from 'node:assert/strict';
import test from 'node:test';
import { GLICKO_INITIAL, decayDeviation, expectedScore, updateGlicko } from '../src/esports/glicko2.ts';
import { isPlaceholderTeam, mapResultsFrom, parseTicker, parseTournamentPage, selectTournamentTitles } from '../src/esports/liquipedia.ts';
import { mapBrier, projectionFor, ratingsBefore } from '../src/esports/ratings.ts';
import { overTwoAndAHalf, seriesFormat, seriesWinProbability } from '../src/esports/series.ts';

test('glicko-2 matches Glickman\'s worked example', () => {
  const next = updateGlicko(
    { r: 1500, rd: 200, sigma: 0.06 },
    [
      { opponent: { r: 1400, rd: 30, sigma: 0.06 }, score: 1 },
      { opponent: { r: 1550, rd: 100, sigma: 0.06 }, score: 0 },
      { opponent: { r: 1700, rd: 300, sigma: 0.06 }, score: 0 },
    ],
  );
  assert.ok(Math.abs(next.r - 1464.06) < 0.02, String(next.r));
  assert.ok(Math.abs(next.rd - 151.52) < 0.02, String(next.rd));
});

test('an idle period widens the deviation and leaves the rating', () => {
  const next = decayDeviation({ r: 1600, rd: 80, sigma: 0.06 });
  assert.equal(next.r, 1600);
  assert.ok(next.rd > 80);
  assert.ok(next.rd <= 350);
});

test('a bo3 series matches the published arithmetic', () => {
  const p1 = 0.3869;
  const p2 = 0.6788;
  const p3 = 0.5359;
  const series = seriesWinProbability([p1, p2, p3], 2);
  assert.ok(Math.abs(series - 0.5523) < 0.0002, String(series));
  assert.ok(Math.abs(overTwoAndAHalf(p1, p2) - 0.5405) < 0.0002);
  assert.equal(seriesWinProbability([0.4], 1), 0.4);
  assert.equal(seriesFormat('Round 1 - Bo1')?.maps, 1);
  assert.equal(seriesFormat('Bo5')?.wins, 3);
  const even = seriesWinProbability([0.5, 0.5, 0.5, 0.5, 0.5], 3);
  assert.ok(Math.abs(even - 0.5) < 1e-12);
});

test('ratings move only after the map is played, and a short sample is not a projection', () => {
  const results = [
    { day: '2026-11-01', map: 'Mirage', winner: 'Alpha', loser: 'Beta' },
    { day: '2026-11-02', map: 'Mirage', winner: 'Alpha', loser: 'Beta' },
    { day: '2026-11-03', map: 'Inferno', winner: 'Alpha', loser: 'Beta' },
  ];
  assert.equal(ratingsBefore(results, '2026-11-01').size, 0);
  const early = ratingsBefore(results.slice(0, 2), '2026-11-03');
  assert.equal(projectionFor('Alpha', early.get('Alpha'), 'Beta', early.get('Beta'), 'Bo3'), null);
  const after = ratingsBefore(results, '2026-11-04');
  const alpha = after.get('Alpha');
  const beta = after.get('Beta');
  assert.ok(alpha && beta);
  assert.ok(alpha.global.r > GLICKO_INITIAL.r);
  assert.ok(beta.global.r < GLICKO_INITIAL.r);
  assert.equal(alpha.mapCount, 3);
  const projection = projectionFor('Alpha', alpha, 'Beta', beta, 'Bo1');
  assert.ok(projection);
  assert.equal(projection.kind, 'series');
  assert.ok(projection.away_win > 0.5);
  assert.ok(Math.abs(projection.away_win + projection.home_win - 1) < 1e-9);
  const later = ratingsBefore(results, '2026-12-01').get('Alpha');
  assert.ok(later && later.global.rd > alpha.global.rd);
});

test('equal teams stay at a coin flip, which the brier records', () => {
  const results = [];
  for (let i = 0; i < 8; i += 1) {
    const day = `2026-10-${String(i + 1).padStart(2, '0')}`;
    results.push({ day, map: 'Mirage', winner: i % 2 === 0 ? 'Alpha' : 'Beta', loser: i % 2 === 0 ? 'Beta' : 'Alpha' });
  }
  const scored = mapBrier(results);
  assert.ok(scored.games >= 1);
  assert.ok(scored.brier >= 0 && scored.brier <= 1);
  const ratings = ratingsBefore(results, '2026-10-09');
  const alpha = ratings.get('Alpha');
  const beta = ratings.get('Beta');
  assert.ok(alpha && beta);
  assert.ok(Math.abs(alpha.global.r + beta.global.r - 3000) < 0.01);
  const chance = expectedScore(alpha.global, beta.global);
  assert.ok(Math.abs(chance - 0.5) < 0.1);
});

const TICKER = `
<div class="match-ticker-card"><div class="match-ticker-card__header"><span class="match-info-countdown"><span class="timer-object" data-timestamp="1795118100">Nov 19</span></span><div>Bo3</div></div>
<div class="match-ticker-card__opponents"><div><span class="name"><a href="/counterstrike/GamerLegion"><div class="team-shortname">GL</div><div class="team-name">GamerLegion</div></a></span></div><div>0</div></div>
<div><span class="name"><a href="/counterstrike/BIG"><div class="team-shortname">BIG</div><div class="team-name">BIG</div></a></span></div><div>2</div></div>
<div class="match-ticker-card-tournament-name"><a href="/counterstrike/Stake_Ranked/Episode_6" title="Stake Ranked/Episode 6">Stake Ranked Episode 6</a></div>
</div>`;

test('the ticker keeps scores and drops a market field it never reads', () => {
  const now = new Date('2026-11-19T23:00:00Z');
  const matches = parseTicker(TICKER, now);
  assert.equal(matches.length, 1);
  const match = matches[0]!;
  assert.equal(match.away.name, 'GamerLegion');
  assert.equal(match.home.abbreviation, 'BIG');
  assert.equal(match.status, 'final');
  assert.equal(match.away_score, 0);
  assert.equal(match.home_score, 2);
  assert.equal(match.tournament, 'Stake Ranked Episode 6');
  assert.equal(match.tournament_title, 'Stake_Ranked/Episode_6');
  assert.equal(JSON.stringify(match).includes('odds'), false);
  assert.equal(isPlaceholderTeam('TBD'), true);
});

const POPUP = `
<div>Liquipedia Tier:</div><div><a href="/counterstrike/S-Tier_Tournaments">S-Tier</a></div>
<div class="brkts-match-info-popup"><span class="timer-object" data-timestamp="1794362400" data-finished="finished"></span>
<div class="match-info-header-opponent-left"><a href="/counterstrike/Legacy"><div class="team-name">Legacy</div></a></div>
<div class="match-info-header-scoreholder"><span>(Bo3)</span></div>
<div class="match-info-header-opponent"><a href="/counterstrike/FURIA"><div class="team-name">FURIA</div></a></div>
<div class="brkts-popup-body"><div class="brkts-popup-body-grid-row">
<div class="brkts-popup-body-detailed-scores-main-score">10</div><a href="/counterstrike/Inferno">Inferno</a>
<div class="brkts-popup-body-detailed-scores-main-score">13</div>
</div></div></div>`;

test('a tier-1 popup becomes one map result and a lower tier does not', () => {
  const page = parseTournamentPage(POPUP);
  assert.equal(page.tier, 'S-Tier');
  const results = mapResultsFrom(page, new Date('2026-11-19T00:00:00Z'));
  assert.deepEqual(results, [{ day: '2026-11-11', map: 'Inferno', winner: 'FURIA', loser: 'Legacy' }]);
  const lower = parseTournamentPage(POPUP.replace('>S-Tier</a>', '>A-Tier</a>'));
  assert.equal(mapResultsFrom(lower, new Date('2026-11-19T00:00:00Z')).length, 0);
});

test('tournament selection keeps 2026 s-tier pages and skips qualifiers', () => {
  const titles = selectTournamentTitles(
    ['Stake_Ranked/Episode_6', 'PGL/2026/Singapore/Stage_1'],
    ['User:Someone/2026', 'BLAST/Open/2026/Qualifier', 'Intel Extreme Masters/2026/Atlanta', 'ESL/Pro League/Season 24', 'ESL/Pro League/Season 26'],
    10,
  );
  assert.deepEqual(titles.slice(0, 2), ['Intel_Extreme_Masters/2026/Atlanta', 'ESL/Pro_League/Season_24']);
  assert.equal(titles.includes('BLAST/Open/2026/Qualifier'), false);
  assert.equal(titles.includes('User:Someone/2026'), false);
  assert.equal(titles.includes('ESL/Pro_League/Season_26'), false);
  assert.equal(titles.includes('PGL/2026/Singapore/Stage_1'), true);
});
