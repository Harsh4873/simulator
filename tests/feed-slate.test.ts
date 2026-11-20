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
  assert.match(renderFeedSlate(empty, now), /No NFL matches in this window/);
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
