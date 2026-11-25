import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import { parseEsportsDocument, renderEsports } from '../src/esports/props.ts';
import { parseFeedSlate, renderFeedSlate, type FeedSlate } from '../src/feed.ts';

function slate(now: Date): FeedSlate {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  return {
    sport: 'nfl',
    source: 'ESPN NFL scoreboard',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    games: [
      {
        id: 'g1',
        start_time: new Date(now.getTime() + 3_600_000).toISOString(),
        status: 'scheduled',
        listed: false,
        away: { name: 'Indianapolis Colts', abbreviation: 'IND', score: null, logo_url: null, color: null, alternate_color: null },
        home: { name: 'Houston Texans', abbreviation: 'HOU', score: null, logo_url: null, color: '#03202f', alternate_color: null },
        venue: 'NRG Stadium',
        neutral_site: false,
        competition: null,
        projection: null,
        projection_note: 'Projection is not fitted.',
      },
    ],
    later: [],
    model: { fitted: false, name: 'none', note: 'Projection is not fitted.', holdout_games: null, holdout_brier: null },
  };
}

function esportsFixture(now: Date): string {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  return JSON.stringify({
    sport: 'esports',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    model: {
      name: 'esports-player-means-v1',
      fitted: true,
      note: 'Each number is the player mean on earlier games. Fewer than 8 earlier games is not fitted. No match winner and no posted line were used.',
    },
    titles: [{
      title: 'CS2',
      source: 'BO3.gg',
      matches: [{
        id: 'm1',
        start_time: new Date(now.getTime() + 3_600_000).toISOString(),
        teams: ['GamerLegion', 'BIG'],
        competition: 'Stake Ranked Episode 6',
        players: [{
          name: 'volt',
          team: 'GamerLegion',
          props: [
            { stat: 'kills', mean: 18.2 },
            { stat: 'deaths', mean: null },
          ],
        }],
      }],
    }],
  });
}

test('published feed files parse when they are present', () => {
  const nfl = 'public/data/nfl.json';
  if (existsSync(nfl)) {
    const raw = readFileSync(nfl, 'utf8');
    const parsed = parseFeedSlate(raw, 'nfl');
    assert.ok(parsed, nfl);
    assert.equal(parsed.sport, 'nfl');
    assert.equal(/"(odds|spread|moneyline|price|total)"\s*:/.test(raw), false);
  }
  const esports = 'public/data/esports.json';
  if (existsSync(esports)) {
    const raw = readFileSync(esports, 'utf8');
    assert.ok(parseEsportsDocument(raw), esports);
    assert.equal(parseFeedSlate(raw, 'nfl'), null);
    assert.equal(/"(odds|spread|moneyline|price|line|away_win|home_win)"\s*:/.test(raw), false);
  }
});

test('a feed slate round-trips and rejects a price', () => {
  const now = new Date();
  const parsed = parseFeedSlate(JSON.stringify(slate(now)), 'nfl');
  assert.ok(parsed);
  assert.equal(parsed.games[0]?.projection_note, 'Projection is not fitted.');
  const priced = JSON.parse(JSON.stringify(slate(now))) as { games: { odds: number }[] };
  priced.games[0]!.odds = -110;
  assert.equal(parseFeedSlate(JSON.stringify(priced), 'nfl'), null);
});

test('the feed page shows the schedule, an unfitted projection, and no line', () => {
  const now = new Date();
  const html = renderFeedSlate(slate(now), now);
  assert.match(html, /Indianapolis Colts/);
  assert.match(html, /Projection is not fitted\./);
  assert.equal(/data-event=/.test(html), false);
  assert.equal(/lean|spread|moneyline|odds/i.test(html), false);
  const stale = renderFeedSlate(slate(now), new Date(now.getTime() + 3 * 86_400_000));
  assert.match(stale, /not the current Chicago window/);
  const empty = slate(now);
  empty.games = [];
  assert.match(renderFeedSlate(empty, now), /No NFL games today or yesterday\.<\/p>/);
});

test('the rest of the week shows under its own days, with records, after an empty window', () => {
  const now = new Date('2026-11-20T20:00:00Z');
  const week = slate(now);
  const game = week.games[0]!;
  week.games = [];
  week.later = [
    { ...game, id: 'mon', start_time: '2026-11-24T01:15:00Z' },
    { ...game, id: 'sun', start_time: '2026-11-22T18:00:00Z', away: { ...game.away, record: '1-8' }, home: { ...game.home, record: '5-3-1' } },
    // Already today in Chicago: not "later".
    { ...game, id: 'today', start_time: '2026-11-20T23:00:00Z', away: { ...game.away, name: 'Earlier Team' } },
  ];
  const html = renderFeedSlate(parseFeedSlate(JSON.stringify(week), 'nfl')!, now);
  assert.match(html, /No NFL games today or yesterday\. Upcoming games are below\./);
  assert.ok(html.indexOf('Sunday, Nov 22') < html.indexOf('Monday, Nov 23'), html);
  assert.match(html, /data-record>1-8</);
  assert.match(html, /data-record>5-3-1</);
  assert.doesNotMatch(html, /Earlier Team/);
  // A record that is not wins-losses(-ties) fails the file; a file without records still parses.
  const bad = JSON.parse(JSON.stringify(week)) as FeedSlate;
  bad.later[1]!.away.record = '1 and 8';
  assert.equal(parseFeedSlate(JSON.stringify(bad), 'nfl'), null);
  assert.ok(parseFeedSlate(JSON.stringify(slate(now)), 'nfl'));
});

test('upcoming NFL games move into the Chicago window before the next refresh', () => {
  const week = slate(new Date('2026-11-25T02:00:00Z'));
  const game = week.games[0]!;
  week.games = [{ ...game, start_time: '2026-11-24T01:15:00Z', away: { ...game.away, name: 'Monday Team' } }];
  week.later = [
    { ...game, id: 'wed', start_time: '2026-11-26T01:00:00Z', away: { ...game.away, name: 'Wednesday Team' } },
    { ...game, id: 'thu', start_time: '2026-11-26T18:00:00Z', away: { ...game.away, name: 'Thursday Team' } },
  ];
  const html = renderFeedSlate(week, new Date('2026-11-26T06:05:00Z'));
  assert.match(html, /not the current Chicago window/);
  assert.match(html, /NFL · 2 games · next kickoff Thu, Nov 26/);
  assert.match(html, />Today<.*?Thursday Team.*?>Yesterday<.*?Wednesday Team/s);
  assert.doesNotMatch(html, /Monday Team|No NFL games today/);
});

test('a finished esports game shows each player\'s projection and what he did, and no team result', () => {
  const now = new Date();
  const doc = JSON.parse(esportsFixture(now)) as { titles: { matches: Record<string, unknown>[] }[] };
  const match = doc.titles[0]!.matches[0]!;
  Object.assign(match, { status: 'finished', winner: 'BIG', score: [1, 2] });
  (match.players as { props: Record<string, unknown>[] }[])[0]!.props[0]!.actual = 21.5;
  (match.players as { props: Record<string, unknown>[] }[])[0]!.props[0]!.projection = { scope: 'maps12', mean: 36.4, p10: 26, p50: 36, p90: 47 };
  const parsed = parseEsportsDocument(JSON.stringify(doc));
  assert.ok(parsed);
  const html = renderEsports(parsed, now);
  // One table a match: the projected median, its range and the plain average in one cell, players under their team.
  assert.match(html, /<th scope="col">Kills<span class="th-sub">maps 1-2<\/span><\/th>/);
  assert.match(html, /title="Plain average 18\.2 a map"><span class="stat">36<\/span><span class="pct">26–47<\/span>/);
  assert.match(html, /<tr class="team-row"><th colspan="3" scope="rowgroup">GamerLegion<\/th><\/tr>/);
  assert.doesNotMatch(html, /How these projections work/);
  // An older file's maps 1-2 number does not read against a map's average, so the result carries no over or under.
  assert.match(html, /<span class="pct" data-actual>Played 21\.5<\/span>/);
  assert.match(html, /data-result>Final</);
  assert.doesNotMatch(html, /won/);
  const badProjection = JSON.parse(JSON.stringify(doc));
  badProjection.titles[0].matches[0].players[0].props[0].projection.p10 = 50;
  assert.equal(parseEsportsDocument(JSON.stringify(badProjection)), null);
  const wrongWinner = JSON.parse(JSON.stringify(doc));
  wrongWinner.titles[0].matches[0].winner = 'Somebody Else';
  assert.equal(parseEsportsDocument(JSON.stringify(wrongWinner)), null);
  const badScore = JSON.parse(JSON.stringify(doc));
  badScore.titles[0].matches[0].score = [1.5, 2];
  assert.equal(parseEsportsDocument(JSON.stringify(badScore)), null);
  const badActual = JSON.parse(JSON.stringify(doc));
  badActual.titles[0].matches[0].players[0].props[0].actual = -1;
  assert.equal(parseEsportsDocument(JSON.stringify(badActual)), null);
  // Files from before the result fields still parse and show no result line.
  assert.doesNotMatch(renderEsports(parseEsportsDocument(esportsFixture(now))!, now), /data-result/);
});

test('the esports fixture is a player-mean document', () => {
  const now = new Date();
  const raw = esportsFixture(now);
  assert.equal(parseFeedSlate(raw, 'nfl'), null);
  const parsed = parseEsportsDocument(raw);
  assert.ok(parsed);
  const html = renderEsports(parsed, now);
  assert.match(html, /GamerLegion/);
  assert.match(html, /volt/);
  assert.match(html, /18\.2/);
  assert.match(html, /not fitted/);
  assert.equal(/away_win|home_win|55\.0%/.test(html), false);
});
