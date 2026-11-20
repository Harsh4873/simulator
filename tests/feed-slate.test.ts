import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import { parseFeedSlate, renderFeedSlate, type FeedSlate } from '../src/feed.ts';

function slate(now: Date, sport: 'nfl' | 'esports'): FeedSlate {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  return {
    sport,
    source: sport === 'nfl' ? 'ESPN NFL scoreboard' : 'Liquipedia',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    games: [
      {
        id: 'g1',
        start_time: new Date(now.getTime() + 3_600_000).toISOString(),
        status: 'scheduled',
        listed: sport === 'esports',
        away: { name: 'Indianapolis Colts', abbreviation: 'IND', score: null, logo_url: null, color: null, alternate_color: null },
        home: { name: 'Houston Texans', abbreviation: 'HOU', score: null, logo_url: null, color: '#03202f', alternate_color: null },
        venue: sport === 'nfl' ? 'NRG Stadium' : null,
        neutral_site: sport === 'esports',
        competition: sport === 'esports' ? 'Stake Ranked Episode 6 · Bo3' : null,
        projection: null,
        projection_note: 'Projection is not fitted.',
      },
    ],
    later: sport === 'esports'
      ? [
          {
            id: 'later',
            start_time: new Date(now.getTime() + 5 * 86_400_000).toISOString(),
            status: 'scheduled',
            listed: true,
            away: { name: 'FaZe Clan', abbreviation: 'FaZe', score: null, logo_url: null, color: null, alternate_color: null },
            home: { name: 'Team Vitality', abbreviation: 'VIT', score: null, logo_url: null, color: null, alternate_color: null },
            venue: null,
            neutral_site: true,
            competition: 'PGL Major Singapore 2026 · Bo3',
            projection: { kind: 'series', away_win: 0.55, home_win: 0.45, summary: 'FaZe Clan 55.0% · Team Vitality 45.0%' },
            projection_note: 'Series chance if every map is an independent draw at the global Glicko-2 map chance. Not calibrated.',
          },
        ]
      : [],
    model: { fitted: false, name: 'none', note: 'Projection is not fitted.', holdout_games: null, holdout_brier: null },
  };
}

test('published feed files parse when they are present', () => {
  for (const sport of ['nfl', 'esports'] as const) {
    const path = `public/data/${sport}.json`;
    if (!existsSync(path)) continue;
    const parsed = parseFeedSlate(readFileSync(path, 'utf8'), sport);
    assert.ok(parsed, path);
    assert.equal(/"(odds|spread|moneyline|price|total)"\s*:/.test(readFileSync(path, 'utf8')), false);
  }
});

test('a feed slate round-trips and rejects a price', () => {
  const now = new Date();
  const parsed = parseFeedSlate(JSON.stringify(slate(now, 'nfl')), 'nfl');
  assert.ok(parsed);
  assert.equal(parsed.games[0]?.projection_note, 'Projection is not fitted.');
  const priced = JSON.parse(JSON.stringify(slate(now, 'nfl'))) as { games: { odds: number }[] };
  priced.games[0]!.odds = -110;
  assert.equal(parseFeedSlate(JSON.stringify(priced), 'nfl'), null);
  assert.equal(parseFeedSlate(JSON.stringify(slate(now, 'nfl')), 'esports'), null);
});

test('the feed page shows the schedule, an unfitted projection, and no line', () => {
  const now = new Date();
  const html = renderFeedSlate(slate(now, 'esports'), now);
  assert.match(html, /Indianapolis Colts/);
  assert.match(html, /Projection is not fitted\./);
  assert.match(html, /Tier-1 outside this window/);
  assert.match(html, /FaZe Clan 55\.0%/);
  assert.match(html, /Not calibrated/);
  assert.equal(/data-event=/.test(html), false);
  assert.equal(/lean|spread|moneyline|odds/i.test(html), false);
  const stale = renderFeedSlate(slate(now, 'nfl'), new Date(now.getTime() + 3 * 86_400_000));
  assert.match(stale, /not the current Chicago window/);
  const empty = slate(now, 'nfl');
  empty.games = [];
  assert.match(renderFeedSlate(empty, now), /No NFL matches in this window/);
});
