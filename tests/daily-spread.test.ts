import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dailySpreadForGame } from '../src/daily-spread.ts';
import { currentDailyPrice } from '../src/daily-price.ts';
import type { RateCard, Slate, SpreadQuote } from '../src/types.ts';

const fixture = 'tests/fixtures/generation-2026-11-02';
const card: RateCard = JSON.parse(readFileSync(join(fixture, 'rate-card.json'), 'utf8'));
const slate: Slate = JSON.parse(readFileSync(join(fixture, 'slate.json'), 'utf8'));
const now = new Date('2026-11-02T22:30:00Z');
const quote: SpreadQuote = { source: 'ESPN scoreboard', book: 'Book A', captured_at: '2026-11-02T22:15:00Z', home_spread: -3, home_odds: -110, away_odds: -110 };
const game = { ...slate.games[0], status_state: 'pre', completed: false, date: '2026-11-02', start_time: '2026-11-03T00:00:00Z', spread_quotes: [quote] };
const pregameCard = { ...card, generated_at: '2026-11-02T22:00:00Z' };
const sim = { margins: [...Array(550).fill(5), ...Array(400).fill(2), ...Array(50).fill(3)], awayTotals: [], homeTotals: [] };

test('spread ranking compares the actual price, counts pushes as refunds, and uses the correct handicap for either team', () => {
  const better = { ...quote, book: 'Book B', home_odds: 110 };
  const winner = dailySpreadForGame({ ...game, spread_quotes: [better, quote] }, pregameCard, sim, now);
  assert.ok(winner);
  assert.equal(winner.book, 'Book B');
  assert.equal(winner.title, game.home.name + ' -3');
  // No graded record and no released margins: the best spread is an unproven edge, never a lean.
  assert.equal(winner.grade, 'EDGE');
  assert.match(winner.evidence ?? '', /^Not a qualified pick: spread leans are not graded against results yet/);
  assert.equal(winner.modelProbability, 550 / 950);
  assert.ok(Math.abs(winner.expectedReturn - 0.205) < 1e-10);
  assert.equal(winner.breakEven, 100 / 210);
  assert.deepEqual(winner.settle, { kind: 'spread', side: 'home', home_spread: -3, home: game.home.abbreviation, away: game.away.abbreviation });
  const away = dailySpreadForGame(game, pregameCard, { ...sim, margins: [...Array(620).fill(-1), ...Array(380).fill(8)] }, now);
  assert.equal(away?.title, game.away.name + ' +3');
  assert.equal(away?.modelProbability, 0.62);
  assert.deepEqual(away?.settle, { kind: 'spread', side: 'away', home_spread: -3, home: game.home.abbreviation, away: game.away.abbreviation });
  assert.equal(dailySpreadForGame(game, pregameCard, { ...sim, margins: Array(1000).fill(3) }, now), null);
});

test('a daily spread requires a pregame card, current offer and positive edge outside the noise', () => {
  assert.equal(dailySpreadForGame({ ...game, status_state: 'in' }, pregameCard, sim, now), null);
  assert.equal(dailySpreadForGame(game, { ...pregameCard, generated_at: game.start_time }, sim, now), null);
  assert.equal(dailySpreadForGame({ ...game, date: '2026-11-01' }, pregameCard, sim, now), null);
  assert.equal(dailySpreadForGame({ ...game, spread_quotes: [] }, pregameCard, sim, now), null);
  assert.equal(dailySpreadForGame(game, pregameCard, { ...sim, margins: [...Array(500).fill(1), ...Array(500).fill(7)] }, now), null);
  // The prop feed is checked a few times a day, so a price stays current as long as a card does: six hours.
  assert.equal(currentDailyPrice('2026-11-02T16:30:00Z', game.start_time, now), true);
  assert.equal(currentDailyPrice('2026-11-02T16:29:59Z', game.start_time, now), false);
  assert.equal(currentDailyPrice('2026-11-02T22:30:01Z', game.start_time, now), false);
  assert.equal(currentDailyPrice('not a time', game.start_time, now), false);
  assert.equal(currentDailyPrice(quote.captured_at, game.start_time, new Date(game.start_time)), false);
});

test('released margin calibration lets a spread be a lean or a bet instead of an unproven edge', () => {
  const released = { model_version: card.model_version ?? '', input_hash: 'a'.repeat(64), training_cutoff: '2026-10-01', evaluated_through: '2026-10-30',
    games: 600, settled_markets: 2200, margin_bias: 0, total_bias: 0, coverage80: 0.8, coverage90: 0.9, ece: 0.01,
    baseline_improvement: true, market_noninferiority: true, markets: ['spread'], status: 'passed' as const };
  const releasedCard = { ...pregameCard, calibration: released, source_cutoff: pregameCard.generated_at };
  // 550 of 950 decided draws (57.9%) at -110 clears the lean bar of 3 points but not the bet bar of 8.
  const lean = dailySpreadForGame(game, releasedCard, sim, now)!;
  assert.equal(lean.grade, 'LEAN');
  assert.equal(lean.evidence, 'The simulated margins have passed their release checks against settled games.');
  const bet = dailySpreadForGame(game, releasedCard, { ...sim, margins: [...Array(620).fill(5), ...Array(380).fill(1)] }, now)!;
  assert.equal(bet.grade, 'BET');
  assert.equal(dailySpreadForGame(game, { ...releasedCard, calibration: { ...released, markets: ['total'] } }, sim, now)?.grade, 'EDGE');
});
