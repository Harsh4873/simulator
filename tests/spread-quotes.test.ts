import test from 'node:test';
import assert from 'node:assert/strict';
import { gamesFromScoreboard, slateWithSpreadQuotes } from '../scripts/build-rate-card.ts';
import type { Slate } from '../src/types.ts';

const captured = '2026-11-25T20:00:00Z';
const tip = '2026-11-25T22:00:00Z';
const side = (line: string, odds: string) => ({close: {line, odds}, open: {line: '0', odds: '-110'}});
const quote = {provider: {name: 'DraftKings'}, pointSpread: {home: side('-1.5', '-106'), away: side('+1.5', '-114')}};
function scoreboard(offers: unknown[], state = 'pre', date = tip) {
  const competitors = ['home', 'away'].map((homeAway, index) => ({homeAway, team: {id: String(index + 1)}}));
  return {events: [{id: '401909317', date, competitions: [{status: {type: {state, completed: state === 'post'}}, competitors, odds: offers}]}]};
}
const date = '2026-11-25';
const games = gamesFromScoreboard(scoreboard([quote]), date, []);
const slate: Slate = {schema_version: 1, generated_at: captured, date, timezone: 'America/Chicago', games};
const published = (offers: unknown[], at = captured, state = 'pre', start = tip) =>
  slateWithSpreadQuotes(slate, scoreboard(offers, state, start), at).games[0].spread_quotes;

test('public spreads preserve each book, handicap, price and observation time separately from model games', () => {
  const other = {provider: {name: 'Second book'}, pointSpread: {home: side('0', '+100'), away: side('0', '-112')}};
  assert.deepEqual(published([quote, other]), [
    {source: 'ESPN scoreboard', book: 'DraftKings', captured_at: captured, home_spread: -1.5, home_odds: -106, away_odds: -114},
    {source: 'ESPN scoreboard', book: 'Second book', captured_at: captured, home_spread: 0, home_odds: 100, away_odds: -112},
  ]);
  assert.deepEqual(games, gamesFromScoreboard(scoreboard([other]), date, []));
  assert.equal(slate.games[0].spread_quotes, undefined);
});

test('a missing current side, inconsistent handicap, invalid price or unavailable event cannot yield a spread offer', () => {
  for (const invalid of [
    {provider: {name: '  '}, pointSpread: quote.pointSpread},
    {...quote, pointSpread: {...quote.pointSpread, home: {open: {line: '-1.5', odds: '-106'}}}},
    {...quote, pointSpread: {...quote.pointSpread, away: side('1.5', '')}},
    {...quote, pointSpread: {...quote.pointSpread, away: side('1.5', '-80')}},
    {...quote, pointSpread: {...quote.pointSpread, away: side('2.5', '-110')}},
    {...quote, pointSpread: {home: side('-1.25', '-110'), away: side('1.25', '-110')}},
    {...quote, pointSpread: {home: side('0', '-110'), away: {close: {line: false, odds: 100}}}},
    {provider: {name: 'Book'}, spread: -1.5},
  ]) assert.equal(published([invalid]), undefined);
  assert.equal(published([quote], tip), undefined);
  assert.equal(published([quote], 'invalid date'), undefined);
  assert.equal(published([quote], captured, 'in'), undefined);
  assert.equal(published([quote], captured, 'post'), undefined);
  assert.equal(published([quote], captured, 'pre', '2026-11-26T00:00:00Z'), undefined);
});

test('a pick\'em line and an even price are read as the numbers books mean by them', () => {
  const pk = {provider: {name: 'DraftKings'}, pointSpread: {home: side('PK', 'EVEN'), away: side('pk', '-120')}};
  assert.deepEqual(published([pk]), [{source: 'ESPN scoreboard', book: 'DraftKings', captured_at: captured, home_spread: 0, home_odds: 100, away_odds: -120}]);
  assert.equal(published([{provider: {name: 'DraftKings'}, pointSpread: {home: side('PK', 'EVENS'), away: side('PK', '-120')}}]), undefined);
});
