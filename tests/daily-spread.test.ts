import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dailySpreadForGame } from '../src/daily-spread.ts';
import { currentDailyPrice, dailyPanelState, type DailyCandidates, type DailyPicks } from '../src/daily-price.ts';
import { buildRecord } from '../src/picks.ts';
import { publishSims } from '../scripts/publish-sims.ts';
import { fetchPublishedSlate } from '../src/published-sim.ts';
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
  assert.equal(winner.grade, 'LEAN');
  assert.equal(winner.modelProbability, 550 / 950);
  assert.ok(Math.abs(winner.expectedReturn - 0.205) < 1e-10);
  assert.equal(winner.breakEven, 100 / 210);
  const away = dailySpreadForGame(game, pregameCard, { ...sim, margins: [...Array(620).fill(-1), ...Array(380).fill(8)] }, now);
  assert.equal(away?.title, game.away.name + ' +3');
  assert.equal(away?.modelProbability, 0.62);
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

test('the board drops tipped games and expired prices and rejects a different slate or prop snapshot', () => {
  const offer = dailySpreadForGame(game, pregameCard, sim, now)!;
  const early = { ...game, event_id: '100', start_time: '2026-11-02T22:35:00Z' };
  const later = { ...offer, eventId: early.event_id, tip: early.start_time, expectedReturn: 0.2 };
  const day = { ...slate, date: game.date, games: [game, early] };
  const file: DailyCandidates = { date: game.date, slateHash: 'a'.repeat(64), picksBuiltAt: quote.captured_at, props: [offer], spreads: [later, offer] };
  const picksBuilt = (built: string): DailyPicks => ({ built_at: built, lines: {}, record: buildRecord([]) });
  const state = (time: Date, hash = file.slateHash, built = file.picksBuiltAt!) => dailyPanelState(day, file, hash, picksBuilt(built), time, false);
  assert.equal(state(now).spread?.eventId, early.event_id);
  assert.equal(state(new Date(early.start_time)).spread?.eventId, offer.eventId);
  assert.equal(state(now, 'different').status, 'unavailable');
  assert.equal(state(now, undefined, 'different').prop, null);
  assert.equal(state(new Date(game.start_time)).status, 'finished');
  // A price older than six hours leaves the board even while its game is still to play.
  const aging = { ...file, spreads: [{ ...offer, pricedAt: '2026-11-02T17:00:00Z' }] };
  const at = (time: string) => dailyPanelState(day, aging, file.slateHash, picksBuilt(file.picksBuiltAt!), new Date(time), false).spread;
  assert.equal(at('2026-11-02T23:00:00Z')?.eventId, offer.eventId);
  assert.equal(at('2026-11-02T23:00:01Z'), null);
});

test('an empty category says why: no current price, no live-graded support, or no offer clearing the checks', () => {
  const record = buildRecord([]);
  const lines = { [game.event_id]: [['1', 'pts', 15.5, -110, -110, quote.captured_at]] } as DailyPicks['lines'];
  const priced: DailyPicks = { built_at: 'built', lines, record };
  const file: DailyCandidates = { date: game.date, slateHash: 'b'.repeat(64), picksBuiltAt: 'built', props: [], spreads: [] };
  const day = { ...slate, date: game.date, games: [game] };
  const state = (picks: DailyPicks | null, games = day.games, candidates = file) =>
    dailyPanelState({ ...day, games }, candidates, file.slateHash, picks, now, false);

  assert.equal(state(null).propNote, 'No current player prop price for today’s remaining games.');
  assert.equal(state({ ...priced, lines: {} }).propNote, 'No current player prop price for today’s remaining games.');
  assert.equal(state({ ...priced, built_at: 'later' }).propNote, 'Player prop prices changed after today’s picks were made. They return with the next update.');
  assert.equal(state(priced).propNote, 'Prop leans have no live-graded record yet, so none qualifies.');
  const tier = { side: 'over' as const, lo: 0.06, hi: 0.1, n: 400, wins: 200, need: 0.52, units: -14, edge: -0.02, pooled: 900 };
  const losing = { ...record, live: { ...record.live, from: '2026-11-15', over: { n: 3125, wins: 1537, need: 0.5236, units: -196.71 }, under: { n: 3042, wins: 1551, need: 0.5342, units: -140.65 } }, tiersLive: [tier] };
  assert.equal(state({ ...priced, record: losing }).propNote,
    'Live-graded prop leans have settled short of the posted price at every strength (6,167 graded since Nov 15), so none qualifies yet.');
  const winning = { ...losing, tiersLive: [{ ...tier, edge: 0.02 }] };
  assert.equal(state({ ...priced, record: winning }).propNote, 'No current player prop clears the model’s price, noise and evidence checks.');

  assert.equal(state(priced).spreadNote, 'No spread clears the model’s edge and noise checks at the current price.');
  assert.equal(state(priced, [{ ...game, spread_quotes: [] }]).spreadNote, 'No current spread price for today’s remaining games.');
  assert.equal(state(priced, [{ ...game, spread_quotes: [{ ...quote, captured_at: '2026-11-02T16:00:00Z' }] }]).spreadNote,
    'No current spread price for today’s remaining games.');
  // A shown offer carries no note in its place.
  const spread = dailySpreadForGame(game, pregameCard, sim, now)!;
  const shown = state(priced, day.games, { ...file, spreads: [spread] });
  assert.equal(shown.spread?.eventId, game.event_id);
  assert.equal(shown.spreadNote, undefined);
  assert.match(shown.spread?.evidence ?? '', /not graded against results yet/);
});

test('the deployment publishes the daily slate identity and the reader rejects it with another generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-daily-'));
  try {
    const slateText = JSON.stringify({ ...slate, date: game.date, games: [game] });
    const small = { ...pregameCard, games: [card.games.find(g => g.event_id === game.event_id)!] };
    writeFileSync(join(dir, 'slate.json'), slateText);
    writeFileSync(join(dir, 'rate-card.json'), JSON.stringify(small));
    publishSims({ dataDir: dir, iterations: 300, now, log: () => {} });
    const get = async (path: string) => readFileSync(join(dir, path), 'utf8');
    const expected = { generated_at: small.generated_at, input_hash: small.input_hash ?? null, model_hash: small.model_hash ?? null, iterations: 300 };
    const published = await fetchPublishedSlate(get, expected);
    assert.equal(published.daily?.slateHash, createHash('sha256').update(slateText).digest('hex'));
    assert.deepEqual([...published.events], [game.event_id]);
    assert.equal((await fetchPublishedSlate(get, { ...expected, iterations: 400 })).daily, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
