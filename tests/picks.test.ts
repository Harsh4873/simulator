import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { buildPicks, serializePicks, type Draws } from '../scripts/build-picks.ts';
import { validateArtifact } from '../scripts/validate-artifact.mjs';
import { bookKey, currentLines, parseBookLines, postedLines, type BookLine } from '../src/book-lines.ts';
import { boxValue, emptyLedger, mergeOpen, openRows, parseLedger, refreshLast, serializeLedger, settle, updateClose } from '../src/pick-ledger.ts';
import {
  bucketOf,
  buildRecord,
  gameLeans,
  gradeRow,
  leanSide,
  linesByKey,
  listed,
  measuredEdges,
  MIN_MEASURED_EDGE,
  MIN_PLAY_SHARE,
  MIN_TIER_LEANS,
  overShare,
  parsePicksFile,
  rankLeans,
  tierFor,
  type Lean,
  type LedgerFile,
  type LedgerRow,
  type PicksFile,
} from '../src/picks.ts';
import { renderPropResults } from '../src/boxscore.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import { decideVerdict, quoteProp, type PlayerSample, type PropContext } from '../src/props.ts';
import type { Simulation } from '../src/simulate.ts';
import type { RateCard, Slate } from '../src/types.ts';

const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
const rate = card.games[0];
const game = slate.games.find((item) => item.event_id === rate.event_id)!;
const active = rate.players.filter((player) => player.minutes_weight === 1 && !player.replacement_level);
const [first, second] = active;
const ruledOut = rate.players.find((player) => player.minutes_weight === 0 && !player.replacement_level);

const feedRow = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    athlete_id: first.athlete_id,
    event_id: game.event_id,
    line: 17.5,
    market_format: 'total',
    over_odds: -118,
    under_odds: -104,
    pregame: true,
    provider: 'DraftKings',
    retrieved_at: '2026-11-02T20:05:40.184620Z',
    sport: 'NBA',
    start_time: '2026-11-03T00:00Z',
    stat_key: 'points',
    ...extra,
  });

/** A sample whose points alternate around a value, so the over share at a line is known exactly. */
function sample(points: number[], minutes = 30): PlayerSample {
  return { min: points.map(() => minutes), pts: points, reb: points.map(() => 5), ast: points.map(() => 4), tpm: points.map(() => 1), stl: points.map(() => 1), blk: points.map(() => 0), tov: points.map(() => 2) };
}

test('only two-sided pre-game totals are read from the price feed, and the latest capture is the current line', () => {
  const text = [
    feedRow(),
    feedRow({ market_format: 'milestone', under_odds: null }),
    feedRow({ sport: 'WNBA' }),
    feedRow({ under_odds: null }),
    feedRow({ over_odds: -50 }),
    feedRow({ line: 17.25 }),
    feedRow({ pregame: false }),
    feedRow({ stat_key: 'fantasy_points' }),
    feedRow({ athlete_id: 'abc' }),
    feedRow({ retrieved_at: '2026-11-03T00:00:01Z' }),
    '{not json',
    feedRow({ stat_key: 'points_rebounds_assists', line: 29.5, athlete_id: second.athlete_id }),
    feedRow({ line: 18.5, over_odds: 100, under_odds: -125, retrieved_at: '2026-11-02T22:10:00Z' }),
  ].join('\n');
  const lines = parseBookLines(text);
  assert.deepEqual(lines.map((line) => [line.athlete_id, line.market, line.line]), [
    [first.athlete_id, 'pts', 17.5],
    [second.athlete_id, 'pra', 29.5],
    [first.athlete_id, 'pts', 18.5],
  ]);
  assert.equal(lines[0].priced_at, '2026-11-02T20:05:40Z');
  assert.equal(lines[0].book, 'DraftKings');
  // The line moved from 17.5 to 18.5 at 22:10. A card built at 21:00 was compared with 17.5.
  const key = bookKey({ event_id: game.event_id, athlete_id: first.athlete_id, market: 'pts' });
  assert.equal(currentLines(lines).get(key)?.line, 18.5);
  assert.equal(currentLines(lines, '2026-11-02T21:00:00Z').get(key)?.line, 17.5);
  assert.equal(currentLines(lines, '2026-11-02T19:00:00Z').size, 0);
  assert.equal(lines[0].tip, '2026-11-03T00:00:00Z');

  // A price the feed stopped seeing is a pulled market. Captures at 12:40, 21:10 and 23:00; this game tips at 00:00.
  const tip = '2026-11-03T00:00:00Z';
  const at = (athleteId: string, pricedAt: string, line = 10.5, eventId = game.event_id, start = tip): BookLine => ({ event_id: eventId, athlete_id: athleteId, market: 'pts', line, over_odds: -110, under_odds: -110, priced_at: pricedAt, book: 'DraftKings', tip: start });
  const day = [
    at('1', '2026-11-02T12:40:00Z'), // seen in the morning only: pulled after the news
    at('2', '2026-11-02T21:10:00Z'), // missing from the last capture too
    at('3', '2026-11-02T21:10:00Z', 9.5),
    at('3', '2026-11-02T23:00:00Z', 11.5), // moved, and still posted
    at('4', '2026-11-02T22:58:30Z'), // the same capture, stamped a moment earlier
    at('5', '2026-11-02T21:10:00Z', 10.5, 'early', '2026-11-02T22:00:00Z'), // tipped before the last capture
    at('6', '2026-11-02T23:00:00Z', 10.5, 'early', '2026-11-02T22:00:00Z'), // a stamp after its own tip cannot be its price
  ];
  const posted = postedLines(day);
  assert.deepEqual([...posted.values()].map((line) => [line.athlete_id, line.line]).sort(), [['3', 11.5], ['4', 10.5], ['5', 10.5]]);
  // As of 22:00 the last capture was 21:10, so those rows were the posted ones then.
  assert.deepEqual([...postedLines(day, '2026-11-02T22:00:00Z').values()].map((line) => [line.athlete_id, line.line]).sort(), [['2', 10.5], ['3', 9.5], ['5', 10.5]]);
  assert.equal(postedLines(day, '2026-11-02T12:00:00Z').size, 0);
});

test('a lean is the side whose model chance clears its own price by more, among the games the player played', () => {
  // 6 of 10 played games over 17.5, two games sat out, and one push at a whole-number line.
  const draws = sample([20, 20, 20, 20, 20, 20, 10, 10, 10, 10, 0, 0]);
  (draws.min as number[])[10] = 0;
  (draws.min as number[])[11] = 0;
  assert.deepEqual(overShare(draws, 'pts', 17.5), { over: 0.6, decided: 10, played: 10 });
  assert.deepEqual(overShare(draws, 'pts', 20), { over: 0, decided: 4, played: 10 });
  assert.equal(overShare(sample([20]), 'pts', 20), null);
  const over = leanSide(0.6, { over_odds: -110, under_odds: -110 });
  assert.equal(over.side, 'over');
  assert.ok(Math.abs(over.claimed - (0.6 - 110 / 210)) < 1e-12);
  // The same 60% is an under lean when the over is priced past it and the under is cheap.
  const under = leanSide(0.6, { over_odds: -200, under_odds: 170 });
  assert.equal(under.side, 'under');
  assert.ok(Math.abs(under.claimed - (0.4 - 100 / 270)) < 1e-12);
  assert.equal(bucketOf(-0.01), -1);
  assert.equal(bucketOf(0.03), 1);
  assert.equal(bucketOf(0.22), 5);
  assert.equal(bucketOf(0.5), 6);

  const lines = new Map<string, BookLine>();
  const post = (athleteId: string, line: number): BookLine => ({ event_id: game.event_id, athlete_id: athleteId, market: 'pts', line, over_odds: -110, under_odds: -110, priced_at: '2026-11-02T20:00:00Z', book: 'DraftKings' });
  lines.set(`${game.event_id}:${first.athlete_id}:pts`, post(first.athlete_id, 17.5));
  lines.set(`other:${second.athlete_id}:pts`, { ...post(second.athlete_id, 9.5), event_id: 'other' });
  if (ruledOut) lines.set(`${game.event_id}:${ruledOut.athlete_id}:pts`, post(ruledOut.athlete_id, 12.5));
  const all = new Map<string, PlayerSample>(rate.players.map((player) => [player.athlete_id, draws]));
  const leans = gameLeans(game, rate, all, lines);
  // The other game's line and the ruled-out player are not compared.
  assert.deepEqual(leans.map((lean) => lean.athlete_id), [first.athlete_id]);
  assert.equal(leans[0].side, 'over');
  assert.equal(leans[0].projection, 16);
  assert.ok(Math.abs(leans[0].play - 10 / 12) < 1e-12);
});

function row(id: string, spec: { p: number; over?: number; under?: number; line?: number; actual?: number | null; void?: boolean; close?: LedgerRow['close'] }): LedgerRow {
  return {
    e: game.event_id,
    a: id,
    m: 'pts',
    name: `Player ${id}`,
    team: '1',
    tip: '2026-11-03T00:00:00Z',
    book: 'DraftKings',
    open: { at: '2026-11-02T22:00:00Z', priced_at: '2026-11-02T20:00:00Z', line: spec.line ?? 10.5, over: spec.over ?? -110, under: spec.under ?? -110, p: spec.p, play: 0.97, min: 30 },
    ...(spec.close ? { close: spec.close } : {}),
    ...(spec.void ? { result: { void: 'dnp' as const } } : spec.actual === null || spec.actual === undefined ? {} : { result: { actual: spec.actual, min: 30 } }),
  };
}

test('the ledger logs a line once before the tip, tracks the last posted price, and grades from the final box', () => {
  const draws = new Map<string, PlayerSample>(rate.players.map((player) => [player.athlete_id, sample([20, 20, 20, 10, 10])]));
  const lines = new Map<string, BookLine>();
  const post = (athleteId: string, line: number, pricedAt = '2026-11-02T20:00:00Z'): BookLine => ({ event_id: game.event_id, athlete_id: athleteId, market: 'pts', line, over_odds: -115, under_odds: -105, priced_at: pricedAt, book: 'DraftKings' });
  lines.set(`${game.event_id}:${first.athlete_id}:pts`, post(first.athlete_id, 17.5));
  lines.set(`${game.event_id}:${second.athlete_id}:pts`, post(second.athlete_id, 9.5));
  const pre = { ...game, start_time: '2026-11-03T00:00:00Z' };
  // A card built after the tip already knows who played, so it logs nothing.
  assert.deepEqual(openRows(pre, rate, draws, lines, '2026-11-03T00:30:00Z'), []);
  const opened = openRows(pre, rate, draws, lines, '2026-11-02T22:00:00Z');
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[0].open, { at: '2026-11-02T22:00:00Z', priced_at: '2026-11-02T20:00:00Z', line: 17.5, over: -115, under: -105, p: 0.6, play: 1, min: 30 });

  const ledger = emptyLedger('2026-11-02');
  assert.equal(mergeOpen(ledger, opened), 2);
  // A later card with a different model chance never rewrites the opening row.
  const later = opened.map((item) => ({ ...item, open: { ...item.open, at: '2026-11-02T23:00:00Z', line: 18.5, p: 0.1 } }));
  assert.equal(mergeOpen(ledger, later), 0);
  assert.equal(ledger.rows[0].open.p, 0.6);
  // It becomes the row's latest comparison instead, once, and only while the game has not started.
  assert.equal(refreshLast(ledger, later), 2);
  assert.deepEqual(ledger.rows[0].last, later[0].open);
  assert.equal(ledger.rows[0].open.line, 17.5);
  assert.equal(refreshLast(ledger, later), 0);
  assert.equal(refreshLast(ledger, [{ ...later[0], open: { ...later[0].open, at: '2026-11-02T22:30:00Z' } }]), 0);
  assert.equal(refreshLast(ledger, [{ ...later[0], open: { ...later[0].open, at: '2026-11-03T00:10:00Z' } }]), 0);
  assert.equal(refreshLast(ledger, [{ ...later[0], a: 'unknown' }]), 0);

  // The price moved before the tip: that is the close. A stamp after the tip, or an older one, is ignored.
  assert.equal(updateClose(ledger, [post(first.athlete_id, 18.5, '2026-11-02T23:10:00Z'), post(second.athlete_id, 9.5, '2026-11-03T00:10:00Z'), post(second.athlete_id, 8.5, '2026-11-02T19:00:00Z')]), 1);
  assert.deepEqual(ledger.rows[0].close, { priced_at: '2026-11-02T23:10:00Z', line: 18.5, over: -115, under: -105 });
  assert.equal(ledger.rows[1].close, undefined);

  const box = (athleteId: string, pts: number, minutes = 31): CompletedEvent['players'][number] => ({ athlete_id: athleteId, team_id: '1', minutes, fgm: 0, fga: 0, tpm: 2, tpa: 5, ftm: 0, fta: 0, reb: 6, ast: 4, pts, stl: 1, blk: 0 });
  const event = { event_id: game.event_id, players: [box(first.athlete_id, 21)] } as CompletedEvent;
  assert.equal(boxValue(box('x', 21), 'pra'), 31);
  assert.equal(boxValue({ ...box('x', 21), stl: undefined }, 'stl'), null);
  assert.equal(settle(ledger, new Map()), 0);
  assert.equal(settle(ledger, new Map([[game.event_id, event]])), 2);
  assert.deepEqual(ledger.rows[0].result, { actual: 21, min: 31 });
  // A settled row takes no later comparison.
  assert.equal(refreshLast(ledger, [{ ...later[0], open: { ...later[0].open, at: '2026-11-02T23:30:00Z' } }]), 0);
  // The second player is not in the final box, so his line is void.
  assert.deepEqual(ledger.rows[1].result, { void: 'dnp' });
  // A settled row is final: neither the close nor the result changes afterwards.
  assert.equal(updateClose(ledger, [post(first.athlete_id, 19.5, '2026-11-02T23:50:00Z')]), 0);
  assert.equal(settle(ledger, new Map([[game.event_id, { ...event, players: [box(first.athlete_id, 3)] } as CompletedEvent]])), 0);

  const text = serializeLedger(ledger);
  assert.equal(text.split('\n').length, 5);
  assert.deepEqual(parseLedger(text), { ...ledger, rows: [...ledger.rows].sort((a, b) => a.a.localeCompare(b.a)) });
  assert.equal(serializeLedger(parseLedger(text)), text);
  assert.throws(() => parseLedger(text.replace('"at":"2026-11-02T22:00:00Z"', '"at":"2026-11-03T02:00:00Z"')), /opened after the tip/);
  assert.throws(() => parseLedger(text.replace('"last":{"at":"2026-11-02T23:00:00Z"', '"last":{"at":"2026-11-03T02:00:00Z"')), /opened after the tip/);
  assert.throws(() => parseLedger(text.replace('"source":"live"', '"source":"guess"')), /Invalid pick ledger/);
  assert.equal(serializeLedger(emptyLedger('2026-11-02')), '{"schema_version":1,"date":"2026-11-02","source":"live","rows":[\n\n]}\n');
  assert.deepEqual(parseLedger(serializeLedger(emptyLedger('2026-11-02'))).rows, []);
});

function file(date: string, source: LedgerFile['source'], rows: LedgerRow[]): LedgerFile {
  return { schema_version: 1, date, source, rows };
}

test('the latest comparison is what grades a lean, and a stronger claim never scores worse than a weaker one', () => {
  // An under lean (model 30% over) at -110 that stayed under wins; a push and a sit-out are not graded.
  const win = gradeRow(row('1', { p: 0.3, actual: 8 }), '2026-11-02', true)!;
  assert.deepEqual({ side: win.side, win: win.win, odds: win.odds }, { side: 'under', win: true, odds: -110 });
  // The latest comparison decides it: the model chance flipped from an under lean to an over lean on a later card.
  const reversed = { ...row('5', { p: 0.3, actual: 13 }), last: { at: '2026-11-02T23:00:00Z', priced_at: '2026-11-02T22:50:00Z', line: 12.5, over: 100, under: -120, p: 0.8, play: 0.97, min: 30 } };
  const latest = gradeRow(reversed, '2026-11-02', true)!;
  assert.deepEqual({ side: latest.side, win: latest.win, odds: latest.odds }, { side: 'over', win: true, odds: 100 });
  assert.equal(gradeRow({ ...reversed, result: { actual: 12.5 === 12.5 ? 12 : 0, min: 30 } }, '2026-11-02', true)!.win, false);
  assert.equal(gradeRow(row('2', { p: 0.3, line: 10, actual: 10 }), '2026-11-02', true), null);
  assert.equal(gradeRow(row('3', { p: 0.3, void: true }), '2026-11-02', true), null);
  assert.equal(gradeRow(row('4', { p: 0.3 }), '2026-11-02', true), null);

  // Raw buckets: +2pp, -1pp, +6pp, +1pp. Pooling makes them 0.5, 0.5, 3.5, 3.5 before shrinking toward the side.
  const bucket = (n: number, edge: number) => ({ n, wins: n * (0.5 + edge), need: n * 0.5, units: 0 });
  const buckets = [bucket(100, 0.02), bucket(100, -0.01), bucket(100, 0.06), bucket(100, 0.01), bucket(0, 0), bucket(0, 0)];
  const side = { n: 400, wins: 400 * 0.52, need: 400 * 0.5, units: 0 };
  const measured = measuredEdges(buckets, side);
  assert.deepEqual(measured.map((item) => item.pooled), [200, 200, 200, 200, 200, 200]);
  const expected = (sum: number, n: number) => (sum + 200 * 0.02) / (n + 200);
  assert.ok(Math.abs(measured[0].edge - expected(1, 200)) < 1e-12);
  assert.ok(Math.abs(measured[2].edge - expected(7, 200)) < 1e-12);
  for (let i = 1; i < measured.length; i += 1) assert.ok(measured[i].edge >= measured[i - 1].edge);

  const many = (prefix: string, count: number, spec: Parameters<typeof row>[1]) => Array.from({ length: count }, (_, i) => row(`${prefix}${i}`, spec));
  const replay = file('2026-10-30', 'replay', [
    ...many('u-w', 150, { p: 0.3, actual: 8 }),
    ...many('u-l', 100, { p: 0.3, actual: 14 }),
    ...many('o-w', 100, { p: 0.7, actual: 14 }),
    ...many('o-l', 150, { p: 0.7, actual: 8 }),
    ...many('void', 7, { p: 0.3, void: true }),
  ]);
  const live = file('2026-11-02', 'live', [
    row('a', { p: 0.3, actual: 8, close: { priced_at: '2026-11-02T23:00:00Z', line: 9.5, over: -110, under: -110 } }),
    row('b', { p: 0.7, actual: 8, close: { priced_at: '2026-11-02T23:00:00Z', line: 9.5, over: -110, under: -110 } }),
    row('c', { p: 0.3, actual: 8, close: { priced_at: '2026-11-02T23:00:00Z', line: 10.5, over: -105, under: -125 } }),
    row('d', { p: 0.3 }),
  ]);
  const record = buildRecord([replay, live]);
  assert.equal(record.settled, 503);
  assert.equal(record.voids, 7);
  assert.deepEqual([record.from, record.through], ['2026-10-30', '2026-11-02']);
  assert.equal(record.replayed.under.n + record.replayed.over.n, 500);
  assert.equal(record.live.under.n, 2);
  assert.equal(record.live.over.n, 1);
  // A line that drops after an under lean moved toward it; the same drop after an over lean moved away.
  assert.deepEqual({ tracked: record.moves.tracked, toward: record.moves.toward, away: record.moves.away, same_line: record.moves.same_line }, { tracked: 3, toward: 1, away: 1, same_line: 1 });
  assert.ok(record.moves.price_toward > 0);
  const under = tierFor(record, 'under', 0.17)!;
  const over = tierFor(record, 'over', 0.17)!;
  assert.equal(under.n, 252);
  assert.ok(under.edge > 0.05 && over.edge < -0.05);
  assert.equal(under.units, Number((152 * (100 / 110) - 100).toFixed(2)));
  const lean = (side: 'over' | 'under', claimed: number, play = 0.95): Lean => ({ event_id: 'e', athlete_id: `${side}${claimed}`, name: `${side} ${claimed}`, matchup: 'A @ B', tip: '2026-11-03T00:00:00Z', market: 'pts', line: 10.5, over_odds: -110, under_odds: -110, book: 'DraftKings', priced_at: '2026-11-02T20:00:00Z', side, model: 0.7, need: 0.524, claimed, projection: 12, minutes: 30, play });
  // Two live unders sit in this bucket. The pooled 252 is not what the list reads.
  assert.equal(listed(lean('under', 0.17), record), false);
  assert.equal(listed(lean('over', 0.17), record), false);
  // A player who probably sits is not listed even on a side that has been winning.
  assert.equal(listed(lean('under', 0.17, 0.3), record), false);
  // With no record nothing is listed: a model percentage alone is not a reason.
  assert.equal(listed(lean('under', 0.17), null), false);
  const enough = many('live', 220, { p: 0.3, actual: 8 });
  const liveRecord = buildRecord([file('2026-11-03', 'live', enough)]);
  assert.equal(listed(lean('under', 0.17), liveRecord), true);
  assert.equal(listed(lean('under', 0.17), buildRecord([file('2026-11-03', 'replay', enough)])), false);
  const board = rankLeans([lean('under', 0.17), lean('under', 0.19), lean('over', 0.3), lean('under', 0.01), lean('under', 0.4)], liveRecord);
  assert.deepEqual(board.listed.under.map((item) => item.claimed), [0.19, 0.17]);
  assert.deepEqual(board.listed.over, []);
  assert.deepEqual(board.unlisted.over.map((item) => item.claimed), [0.3]);
  // A 40-point gap is a reliability problem, not the strongest lean: it is never listed, whatever its side has done.
  assert.deepEqual(board.unlisted.under.map((item) => item.claimed), [0.4]);
  assert.deepEqual(board.counts, { over: 0, under: 2 });
  assert.deepEqual(board.players, { over: 0, under: 2 });
  // One row a player: his strongest lean, with a count of his other lines that lean the same way.
  const samePlayer = (claimed: number, market: Lean['market']): Lean => ({ ...lean('under', claimed), athlete_id: 'one', name: 'One Player', market });
  const grouped = rankLeans([samePlayer(0.12, 'pts'), samePlayer(0.18, 'pra'), samePlayer(0.07, 'reb'), lean('under', 0.1)], liveRecord);
  assert.deepEqual(grouped.listed.under.map((item) => [item.name, item.market, item.also]), [['One Player', 'pra', 2], ['under 0.1', 'pts', 0]]);
  assert.deepEqual([grouped.counts.under, grouped.players.under], [4, 2]);

  // Gaps of 25 points or more are graded in their own row and kept out of the pooled buckets and the side's prior.
  const withExtreme = buildRecord([replay, file('2026-10-31', 'replay', many('x', 40, { p: 0.02, actual: 14 }))]);
  const extreme = tierFor(withExtreme, 'under', 0.4)!;
  assert.deepEqual({ lo: extreme.lo, n: extreme.n, wins: extreme.wins, pooled: extreme.pooled }, { lo: 0.25, n: 40, wins: 0, pooled: 40 });
  assert.ok(extreme.edge < 0);
  assert.equal(tierFor(withExtreme, 'under', 0.17)!.edge, tierFor(buildRecord([replay]), 'under', 0.17)!.edge);
  assert.equal(listed(lean('under', 0.4), withExtreme), false);
});

test('the picks step simulates only games that have not tipped, reuses an unchanged comparison, and never adds live rows to a replayed day', () => {
  const now = new Date('2026-11-02T22:30:00Z');
  const cardAt = '2026-11-02T22:00:00Z';
  const liveCard = { ...card, generated_at: cardAt, model_hash: 'm1', input_hash: 'i1' };
  const pre = { ...game, date: '2026-11-02', status_state: 'pre', start_time: '2026-11-03T00:00:00Z' };
  const started = { ...slate.games.find((item) => item.event_id !== game.event_id)!, date: '2026-11-02', status_state: 'in', start_time: '2026-11-02T22:00:00Z' };
  const liveSlate = { ...slate, generated_at: cardAt, games: [pre, started] };
  const startedRate = card.games.find((item) => item.event_id === started.event_id)!;
  const feed: BookLine[] = [
    { event_id: pre.event_id, athlete_id: first.athlete_id, market: 'pts', line: 17.5, over_odds: 100, under_odds: -120, priced_at: '2026-11-02T20:00:00Z', book: 'DraftKings', tip: pre.start_time },
    { event_id: pre.event_id, athlete_id: second.athlete_id, market: 'pts', line: 30.5, over_odds: -110, under_odds: -110, priced_at: '2026-11-02T20:00:00Z', book: 'DraftKings', tip: pre.start_time },
    { event_id: started.event_id, athlete_id: startedRate.players[0].athlete_id, market: 'pts', line: 12.5, over_odds: -110, under_odds: -110, priced_at: '2026-11-02T20:00:00Z', book: 'DraftKings', tip: started.start_time },
  ];
  let calls = 0;
  const draws: Draws = (_game, rateGame) => {
    calls += 1;
    return new Map(rateGame.players.map((player) => [player.athlete_id, sample([20, 20, 20, 20, 20, 20, 20, 10, 10, 10])]));
  };
  const ledgers = new Map<string, LedgerFile>();
  const run = (previous: PicksFile | null, at = now, lines = feed, cardNow = liveCard) => buildPicks({ slate: liveSlate, card: cardNow, feed: [lines], ledgers, events: new Map(), previous, now: at, draws });
  const firstRun = run(null);
  assert.equal(calls, 1);
  assert.deepEqual({ simulated: firstRun.simulated, opened: firstRun.opened }, { simulated: 1, opened: 2 });
  // Both games' lines are published for the board, but only the game that has not tipped is logged.
  assert.deepEqual(Object.keys(firstRun.picks.lines).sort(), [pre.event_id, started.event_id].sort());
  assert.deepEqual(ledgers.get('2026-11-02')!.rows.map((item) => item.e), [pre.event_id, pre.event_id]);
  assert.equal(ledgers.get('2026-11-02')!.source, 'live');
  // 70% over at +100 is a 20-point over claim; 30.5 is out of reach, so the other row is an under claim.
  assert.deepEqual(firstRun.picks.leans.map((lean) => [lean.athlete_id, lean.side, lean.claimed]), [
    [second.athlete_id, 'under', 0.4762],
    [first.athlete_id, 'over', 0.2],
  ]);
  assert.equal(firstRun.picks.generated_at, cardAt);
  assert.equal(firstRun.picks.book, 'DraftKings');
  assert.deepEqual(linesByKey(firstRun.picks).get(`${pre.event_id}:${first.athlete_id}:pts`)?.line, 17.5);
  assert.deepEqual(parsePicksFile(serializePicks(firstRun.picks)), firstRun.picks);

  // Same card, same prices, later clock: nothing is simulated or rewritten.
  const again = run(firstRun.picks, new Date('2026-11-02T23:00:00Z'));
  assert.equal(calls, 1);
  assert.equal(serializePicks(again.picks), serializePicks(firstRun.picks));
  // A newer capture of the same price only moves the stamp.
  const restamped = run(firstRun.picks, new Date('2026-11-02T23:00:00Z'), feed.map((line) => ({ ...line, priced_at: '2026-11-02T22:45:00Z' })));
  assert.equal(calls, 1);
  assert.equal(restamped.picks.leans[0].priced_at, '2026-11-02T22:45:00Z');
  // A moved line is a new comparison. The ledger keeps what it opened with and records the move as the close.
  // The feed leaves the old 17.5 row behind with its old stamp; only the rows from the newer capture are posted.
  const moved = [...feed.map((line) => ({ ...line, priced_at: line.athlete_id === first.athlete_id ? line.priced_at : '2026-11-02T22:50:00Z' })), { ...feed[0], line: 18.5, priced_at: '2026-11-02T22:50:00Z' }];
  const afterMove = run(firstRun.picks, new Date('2026-11-02T23:00:00Z'), moved);
  assert.equal(calls, 2);
  assert.equal(afterMove.opened, 0);
  assert.equal(afterMove.refreshed, 2);
  const logged = ledgers.get('2026-11-02')!.rows.find((item) => item.a === first.athlete_id)!;
  assert.equal(logged.open.line, 17.5);
  assert.deepEqual({ at: logged.last!.at, line: logged.last!.line }, { at: cardAt, line: 18.5 });
  assert.deepEqual(logged.close, { priced_at: '2026-11-02T22:50:00Z', line: 18.5, over: 100, under: -120 });
  assert.equal(afterMove.picks.leans.find((lean) => lean.athlete_id === first.athlete_id)?.line, 18.5);
  // A new card is a new forecast, so it is simulated again.
  run(afterMove.picks, new Date('2026-11-02T23:10:00Z'), moved, { ...liveCard, generated_at: '2026-11-02T23:05:00Z' });
  assert.equal(calls, 3);
  // After the tip the game leaves the list and the ledger is only graded.
  const late = run(afterMove.picks, new Date('2026-11-03T00:30:00Z'), moved);
  assert.equal(calls, 3);
  assert.deepEqual(late.picks.leans, []);

  // A day rebuilt by replay stays a replay: a live run adds nothing to it.
  const replayed = new Map<string, LedgerFile>([['2026-11-02', emptyLedger('2026-11-02', 'replay')]]);
  const guarded = buildPicks({ slate: liveSlate, card: liveCard, feed: [feed], ledgers: replayed, events: new Map(), previous: null, now, draws });
  assert.equal(guarded.opened, 0);
  assert.deepEqual(replayed.get('2026-11-02')!.rows, []);
  assert.equal(guarded.picks.leans.length, 2);

  // A market the book pulled is neither listed nor logged: its row is older than the day's last capture.
  const pulled = [{ ...feed[0], priced_at: '2026-11-02T12:40:00Z' }, { ...feed[1], priced_at: '2026-11-02T22:00:00Z' }];
  const fresh = new Map<string, LedgerFile>();
  const afterPull = buildPicks({ slate: liveSlate, card: liveCard, feed: [pulled], ledgers: fresh, events: new Map(), previous: null, now, draws });
  assert.deepEqual(Object.values(afterPull.picks.lines).flat().map((line) => line[0]), [second.athlete_id]);
  assert.deepEqual(fresh.get('2026-11-02')!.rows.map((item) => item.a), [second.athlete_id]);
});

test('a malformed picks file is dropped whole, and the published artifact may carry picks.json only', () => {
  const good: PicksFile = { schema_version: 1, generated_at: '2026-11-02T22:00:00Z', input_hash: 'i', model_hash: 'm', built_at: '2026-11-02T22:30:00Z', book: 'DraftKings', lines: { e: [['1', 'pts', 17.5, -110, -110, '2026-11-02T20:00:00Z']] }, leans: [], record: buildRecord([]) };
  assert.deepEqual(parsePicksFile(JSON.stringify(good)), good);
  assert.equal(parsePicksFile('{'), null);
  assert.equal(parsePicksFile(JSON.stringify({ ...good, schema_version: 2 })), null);
  assert.equal(parsePicksFile(JSON.stringify({ ...good, lines: { e: [['1', 'pts', 17.5, -50, -110, '2026-11-02T20:00:00Z']] } })), null);
  assert.equal(parsePicksFile(JSON.stringify({ ...good, lines: { e: [['1', 'fantasy', 17.5, -110, -110, '2026-11-02T20:00:00Z']] } })), null);
  assert.equal(parsePicksFile(JSON.stringify({ ...good, leans: [{ event_id: 'e' }] })), null);
  assert.equal(linesByKey(null).size, 0);
  assert.doesNotThrow(() => validateArtifact('public'));
});

test('a large model gap is not a lean when graded gaps of that side and size have lost to the price', () => {
  // 70% of 2,000 played games over 17.5 at -110: a 17.6-point claim that clears every sampling check.
  const draws = sample(Array.from({ length: 2000 }, (_, i) => (i % 10 < 7 ? 20 : 10)));
  const quote = quoteProp(draws, 'pts', 'over', 17.5, -110)!;
  const context: PropContext = { available: true, missingShooting: false, thinSample: false, onCard: true };
  assert.equal(decideVerdict(quote, context, 'pts')?.verdict, 'LEAN');
  const lost = decideVerdict(quote, { ...context, measured: { edge: -0.0289, graded: 686 } }, 'pts')!;
  assert.equal(lost.verdict, 'PASS');
  assert.match(lost.text, /settled 2\.9 points short of the posted price across 686 graded leans/);
  assert.equal(decideVerdict(quote, { ...context, measured: { edge: 0.0294, graded: 935 } }, 'pts')?.verdict, 'LEAN');
  // A gap the price already beats still passes for its own reason, record or not.
  const thin = quoteProp(draws, 'pts', 'over', 17.5, -260)!;
  assert.match(decideVerdict(thin, { ...context, measured: { edge: 0.03, graded: 900 } }, 'pts')!.text, /do not clear this line often enough/);

  const many = (prefix: string, count: number, spec: Parameters<typeof row>[1]) => Array.from({ length: count }, (_, i) => row(`${prefix}${i}`, spec));
  const settled = [...many('o-w', 100, { p: 0.7, actual: 14 }), ...many('o-l', 150, { p: 0.7, actual: 8 }), ...many('u-w', 150, { p: 0.3, actual: 8 }), ...many('u-l', 100, { p: 0.3, actual: 14 })];
  const record = buildRecord([file('2026-10-30', 'live', settled)]);
  const score = { playerDraws: new Map([['p', draws]]) } as unknown as Simulation;
  const player = { minutes_weight: 1, shooting_games: 20, thin_sample: false };
  const form = { market: 'pts' as const, side: 'over' as const, line: '17.5', style: 'american' as const, odds: '-110', opposite: '' };
  const over = renderPropResults(score, 'p', form, player, record);
  assert.match(over, /data-verdict="pass"/);
  assert.doesNotMatch(over, /Why this call/);
  assert.doesNotMatch(over, /points short of the posted price across 250 graded leans/);
  // The same rows rebuilt as replay do not attach a measured veto.
  const replayOver = renderPropResults(score, 'p', form, player, buildRecord([file('2026-10-30', 'replay', settled)]));
  assert.match(replayOver, /data-verdict="lean"/);
  assert.doesNotMatch(replayOver, /points short of the posted price/);
  // The same simulation on the side that has been winning keeps its lean, and no record means no veto.
  const low = { playerDraws: new Map([['p', sample(Array.from({ length: 2000 }, (_, i) => (i % 10 < 7 ? 10 : 20)))]]) } as unknown as Simulation;
  const under = renderPropResults(low, 'p', { market: 'pts', side: 'under', line: '17.5', style: 'american', odds: '-110', opposite: '' }, player, record);
  assert.match(under, /data-verdict="lean"/);
  assert.match(renderPropResults(score, 'p', form, player), /data-verdict="lean"/);
});

test('buildRecord without a map counts every settled lean as uncalibrated and lists from the live tier', () => {
  const files = readdirSync('data/pick-ledger')
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseLedger(readFileSync(`data/pick-ledger/${name}`, 'utf8')));
  const record = buildRecord(files);
  assert.equal(record.gradedUncalibrated, record.settled);
  assert.ok(record.tiersLive.length > 0);
  const lean: Lean = {
    event_id: 'e',
    athlete_id: 'a',
    name: 'Under',
    matchup: 'A @ B',
    tip: '2026-11-18T00:00:00Z',
    market: 'pts',
    line: 10.5,
    over_odds: -110,
    under_odds: -110,
    book: 'DraftKings',
    priced_at: '2026-11-18T00:00:00Z',
    side: 'under',
    model: 0.4,
    need: 0.52,
    claimed: 0.16,
    projection: 12,
    minutes: 30,
    play: 0.95,
  };
  const pooledOnly = {
    ...record,
    tiers: record.tiers.map((tier) => (tier.side === 'under' && tier.lo === 0.15 ? { ...tier, pooled: MIN_TIER_LEANS, edge: MIN_MEASURED_EDGE } : tier)),
    tiersLive: record.tiersLive.map((tier) => ({ ...tier, pooled: 0, edge: -1 })),
  };
  assert.equal(listed(lean, pooledOnly), false);
  const liveOnly = {
    ...record,
    tiers: record.tiers.map((tier) => (tier.side === 'under' && tier.lo === 0.15 ? { ...tier, pooled: 0, edge: -1 } : tier)),
    tiersLive: record.tiersLive.map((tier) => (tier.side === 'under' && tier.lo === 0.15 ? { ...tier, pooled: MIN_TIER_LEANS, edge: MIN_MEASURED_EDGE } : tier)),
  };
  assert.equal(listed(lean, liveOnly), true);
  assert.equal(listed({ ...lean, play: MIN_PLAY_SHARE - 0.01 }, liveOnly), false);
  const shut = {
    ...liveOnly,
    tiersLive: liveOnly.tiersLive.map((tier) => (tier.side === 'under' && tier.lo === 0.15 ? { ...tier, edge: MIN_MEASURED_EDGE - 0.001 } : tier)),
  };
  assert.equal(listed(lean, shut), false);
});

test('a logged snapshot carries the simulation family, so a later card cannot relabel it', () => {
  const draws = new Map<string, PlayerSample>(rate.players.map((player) => [player.athlete_id, sample([20, 20, 20, 10, 10])]));
  const lines = new Map<string, BookLine>();
  lines.set(`${game.event_id}:${first.athlete_id}:pts`, { event_id: game.event_id, athlete_id: first.athlete_id, market: 'pts', line: 17.5, over_odds: -115, under_odds: -105, priced_at: '2026-11-02T20:00:00Z', book: 'DraftKings' });
  const pre = { ...game, start_time: '2026-11-03T00:00:00Z' };
  const [stamped] = openRows(pre, rate, draws, lines, '2026-11-02T22:00:00Z', 'hash-a', 'fam-a');
  assert.equal(stamped.open.v, 'fam-a');
  assert.equal(stamped.model_hash, 'hash-a');
  const ledger = emptyLedger('2026-11-02');
  mergeOpen(ledger, [stamped]);
  const [later] = openRows(pre, rate, draws, lines, '2026-11-02T23:00:00Z', 'hash-b', 'fam-b');
  assert.equal(refreshLast(ledger, [later]), 1);
  assert.equal(ledger.rows[0].open.v, 'fam-a');
  assert.equal(ledger.rows[0].last?.v, 'fam-b');
  const parsed = parseLedger(serializeLedger(ledger));
  assert.equal(parsed.rows[0].last?.v, 'fam-b');
  assert.throws(() => parseLedger(serializeLedger({ ...ledger, rows: [{ ...ledger.rows[0], open: { ...ledger.rows[0].open, v: '' } }] })), /family/);
});

test('a calibrated quote shows the raw share, the mapped chance, and the blend it was weighed with', () => {
  const draws = sample(Array.from({ length: 2000 }, (_, i) => (i % 10 < 7 ? 20 : 10)));
  // Temperature 2 on the over: 70% maps to about 60.4%, and 0.2 of that is weighed with a 50% no-vig price.
  const calibration = { apply: (p: number) => 1 / (1 + Math.exp(-Math.log(p / (1 - p)) / 2)), w: 0.2, noVig: null };
  const quote = quoteProp(draws, 'pts', 'over', 17.5, -110, -110, calibration)!;
  assert.ok(quote.calibrated);
  assert.equal(quote.calibrated.raw, 0.7);
  assert.ok(Math.abs(quote.calibrated.mapped - 0.6044) < 0.001);
  assert.ok(Math.abs(quote.modelProbability! - (0.2 * quote.calibrated.mapped + 0.8 * 0.5)) < 1e-9);
  assert.equal(quoteProp(draws, 'pts', 'over', 17.5, -110, -110)!.calibrated, undefined);
  // A one-sided price has no no-vig chance to blend with, so the raw share stands.
  assert.equal(quoteProp(draws, 'pts', 'over', 17.5, -110, null, calibration)!.calibrated, undefined);
  const lean = decideVerdict({ ...quote, edge: 0.05, expectedReturn: 0.05, standardError: 0.001 }, { available: true, missingShooting: false, thinSample: false, onCard: true, propCalibration: calibration }, 'pts')!;
  assert.equal(lean.verdict, 'LEAN');
  assert.match(lean.text, /calibrated chance/);
});
