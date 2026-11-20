import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_GAMES } from '../src/esports/config.ts';
import {
  cargoCount,
  cs2PerMapMean,
  earlierMean,
  esportsDocument,
  formatStat,
  meanOf,
  parseEsportsDocument,
  renderEsports,
  resultText,
  type EsportsTitle,
} from '../src/esports/props.ts';
import { csResult, likelyLineup } from '../scripts/build-esports-slate.ts';

test('the mean uses earlier games and leaves the displayed game out', () => {
  const earlier = Array.from({ length: MIN_GAMES }, (_, index) => ({ id: `m${index}`, start: index + 1, value: 2 }));
  const rows = [...earlier, { id: 'shown', start: 100, value: 50 }, { id: 'later', start: 200, value: 50 }];
  assert.equal(earlierMean(rows, 'shown', 100), 2);
  assert.equal(meanOf(earlier.map((row) => row.value)), 2);
  const oneMissing = earlier.map((row, index) => (index === 0 ? { ...row, value: null } : row));
  assert.equal(earlierMean([...oneMissing, { id: 'shown', start: 100, value: 9 }], 'shown', 100), null);
  const short = earlier.slice(0, MIN_GAMES - 1);
  assert.equal(earlierMean([...short, { id: 'shown', start: 100, value: 50 }], 'shown', 100), null);
});

test('a CS2 series contributes its total divided by its map count', () => {
  const rows = [
    ...Array.from({ length: MIN_GAMES - 1 }, (_, index) => ({ id: `s${index}`, start: index + 1, total: 10, maps: 1 })),
    { id: 'long', start: MIN_GAMES, total: 40, maps: 2 },
    { id: 'unplayed', start: MIN_GAMES + 1, total: 100, maps: 0 },
    { id: 'shown', start: 100, total: 90, maps: 3 },
  ];
  assert.equal(cs2PerMapMean(rows, 'shown', 100), 11.25);
  assert.equal(cs2PerMapMean(rows.filter((row) => row.id !== 'long'), 'shown', 100), null);
});

test('cargo CS keeps a zero and drops an empty string', () => {
  assert.equal(cargoCount(''), null);
  assert.equal(cargoCount('0'), 0);
  assert.equal(cargoCount('247'), 247);
  const present = ['1', '2', '3', '4', '5', '6', '7', ''].map((value) => cargoCount(value));
  assert.equal(meanOf(present), null);
  const withZero = ['1', '2', '3', '4', '5', '6', '7', '0'].map((value) => cargoCount(value));
  assert.equal(meanOf(withZero), 3.5);
});

test('fewer than 8 earlier values is null and renders with no digit', () => {
  const short = Array.from({ length: MIN_GAMES - 1 }, (_, index) => index + 1);
  assert.equal(meanOf(short), null);
  assert.equal(meanOf([...short, 8]), 4.5);
  assert.equal(formatStat(null), 'not fitted');
  assert.equal(/\d/.test(formatStat(null)), false);
  assert.equal(formatStat(11.25), '11.3');
});

function title(mean: number | null, start: string): EsportsTitle {
  return {
    title: 'Dota 2',
    source: 'OpenDota',
    matches: [{
      id: 'm1',
      start_time: start,
      teams: ['Alpha', 'Beta'],
      competition: 'League',
      players: [{ name: 'ace', team: 'Alpha', props: [{ stat: 'kills', mean }, { stat: 'deaths', mean: null }] }],
    }],
  };
}

test('a price or a win chance is rejected', () => {
  const now = new Date('2026-11-20T18:00:00Z');
  const doc = esportsDocument([title(11.25, '2026-11-20T18:00:00Z')], now);
  assert.equal(doc.model.name, 'esports-player-projections-v1');
  assert.ok(parseEsportsDocument(JSON.stringify({ ...doc, model: { ...doc.model, name: 'esports-player-means-v1' } })), 'files from before projections still parse');
  assert.equal(doc.model.fitted, true);
  assert.match(doc.model.note, /own rate from his earlier games/);
  assert.match(doc.model.note, /kills and headshots per round over maps 1 and 2/);
  assert.match(doc.model.note, /calibrated/);
  assert.match(doc.model.note, /never part of its own projection/);
  assert.match(doc.model.note, /match winner/);
  assert.match(doc.model.note, /posted line/);
  const raw = JSON.stringify(doc);
  const parsed = parseEsportsDocument(raw);
  assert.ok(parsed);
  assert.equal(parsed.titles[0]?.matches[0]?.players[0]?.props[0]?.mean, 11.25);
  const html = renderEsports(parsed, now);
  assert.match(html, /11\.3/);
  assert.match(html, />not fitted</);
  assert.equal(/\d/.test(formatStat(null)), false);
  const old = renderEsports(parseEsportsDocument(JSON.stringify(esportsDocument([title(null, '2026-01-05T18:00:00Z')], now)))!, now);
  assert.equal(/Today/.test(old), false);
  assert.match(old, /Jan/);
  assert.equal(esportsDocument([title(null, now.toISOString())], now).model.fitted, false);
  for (const key of ['price', 'away_win', 'home_win', 'odds', 'spread', 'moneyline', 'line']) {
    const priced = JSON.parse(raw) as { titles: Record<string, unknown>[] };
    priced.titles[0]![key] = key === 'away_win' || key === 'home_win' ? 0.5 : -110;
    assert.equal(parseEsportsDocument(JSON.stringify(priced)), null, key);
  }
});

test('a CS2 lineup is the five who played most recently, and a result names the winner by team id', () => {
  const roster = ['coach', 'a', 'b', 'c', 'd', 'e', 'bench'].map((slug) => ({ slug, name: slug }));
  const last: Record<string, number> = { a: 50, b: 40, c: 30, d: 20, e: 10, bench: 1, coach: Number.NEGATIVE_INFINITY };
  assert.deepEqual(likelyLineup(roster, (slug) => last[slug]!).map((player) => player.slug), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(likelyLineup(roster.slice(0, 3), (slug) => last[slug]!).length, 3);
  const teams: [{ name: string; slug: string; id: number | null }, { name: string; slug: string; id: number | null }] = [
    { name: 'GamerLegion', slug: 'gl', id: 7 },
    { name: 'BIG', slug: 'big', id: 9 },
  ];
  assert.deepEqual(csResult({ status: 'finished', teams, score: [1, 2], winnerId: 9 }), { status: 'finished', winner: 'BIG', score: [1, 2] });
  assert.deepEqual(csResult({ status: 'current', teams, score: [1, 0], winnerId: null }), { status: 'live', winner: null, score: [1, 0] });
  assert.deepEqual(csResult({ status: 'upcoming', teams, score: null, winnerId: null }), { status: 'upcoming', winner: null, score: null });
  assert.equal(csResult({ status: 'finished', teams, score: [2, 0], winnerId: 12 }).winner, null);
  // The card shows players, not a team result: a status word and nothing about who won.
  assert.equal(resultText({ status: 'finished' }), 'Final');
  assert.equal(resultText({ status: 'live' }), 'Live');
  assert.equal(resultText({ status: 'upcoming' }), 'Upcoming');
  assert.equal(resultText({}), null);
});
