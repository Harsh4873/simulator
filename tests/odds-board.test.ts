import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARB_BANKROLL,
  DEGRADED_THROUGH_MS,
  EXCLUDED_AFTER_MS,
  FRESH_UNDER_MS,
  LOW_HOLD_UNDER,
  MIDDLE_FLAG_LABEL,
  MIDDLE_STAKE,
  MIN_ARB_PROFIT,
  MIN_MIDDLE_EV,
  ONE_BOOK_REASON,
  buildOddsScreen,
  devigPair,
  findArbs,
  priceMiddle,
  renderOddsBoard,
  type OddsQuote,
} from '../src/odds-board.ts';

const NOW = new Date('2026-11-19T18:00:00.000Z');

function quote(patch: Partial<OddsQuote> = {}): OddsQuote {
  return {
    event: 'evt',
    player: 'Player',
    stat: 'pts',
    line: 24.5,
    period: 'full',
    book: 'Book',
    over: -110,
    under: -110,
    capturedAt: NOW.toISOString(),
    status: 'active',
    ...patch,
  };
}

function at(ageMs: number): string {
  return new Date(NOW.getTime() - ageMs).toISOString();
}

test('fresh, degraded, excluded, low hold, arb, and middle thresholds are the named bounds', () => {
  assert.equal(FRESH_UNDER_MS, 5 * 60 * 1000);
  assert.equal(DEGRADED_THROUGH_MS, 30 * 60 * 1000);
  assert.equal(EXCLUDED_AFTER_MS, 30 * 60 * 1000);
  assert.equal(LOW_HOLD_UNDER, 0.02);
  assert.equal(MIN_ARB_PROFIT, 0.01);
  assert.equal(MIN_MIDDLE_EV, 0.02);
  assert.equal(ARB_BANKROLL, 100);
  assert.equal(MIDDLE_STAKE, 20);
});

test('−110/−110 devigs to 0.50 with hold about 4.76%', () => {
  const priced = devigPair(-110, -110);
  assert.ok(priced);
  assert.equal(priced.noVigOver, 0.5);
  assert.equal(priced.fairAmerican, -100);
  assert.equal((priced.hold * 100).toFixed(2), '4.76');
});

test('+150 against −130 is a 3.48% arb, with $41.44 and $58.56 stakes and a $103.60 payout', () => {
  const arbs = findArbs(
    [
      quote({ book: 'A', over: 150, under: -110 }),
      quote({ book: 'B', over: -110, under: -130 }),
    ],
    NOW,
  );
  assert.equal(arbs.length, 1);
  const arb = arbs[0];
  assert.equal(arb.over.american, 150);
  assert.equal(arb.under.american, -130);
  assert.equal((arb.profit * 100).toFixed(2), '3.48');
  assert.equal(arb.over.stake, 41.44);
  assert.equal(arb.under.stake, 58.56);
  assert.equal(arb.payout.toFixed(2), '103.60');
  assert.equal(arb.over.stake + arb.under.stake, ARB_BANKROLL);
});

test('Over 24.5 / Under 26.5 at decimal 1.909 with P(window) 0.18 is about +$2.53 per $20', () => {
  const absent = priceMiddle({
    overLine: 24.5,
    underLine: 26.5,
    overDecimal: 1.909,
    underDecimal: 1.909,
    windowProbability: null,
    stake: MIDDLE_STAKE,
  });
  assert.equal(absent, null);
  const middle = priceMiddle({
    overLine: 24.5,
    underLine: 26.5,
    overDecimal: 1.909,
    underDecimal: 1.909,
    windowProbability: 0.18,
    stake: MIDDLE_STAKE,
  });
  assert.ok(middle);
  assert.equal(middle.ev.toFixed(2), '2.53');
  assert.equal((middle.breakEvenWindow * 100).toFixed(2), '4.77');
  assert.equal(middle.flagged, true);
  assert.equal(middle.label, MIDDLE_FLAG_LABEL);
  assert.equal(middle.label, 'positive-EV, not guaranteed profit');
});

test('a price older than 5 minutes never becomes an arb, and a price older than 30 minutes never becomes a best price', () => {
  const live = quote({ book: 'A', over: 150, under: -110, capturedAt: at(FRESH_UNDER_MS - 1) });
  const other = quote({ book: 'B', over: -110, under: -130, capturedAt: at(0) });
  assert.equal(findArbs([live, other], NOW).length, 1);
  assert.equal(findArbs([{ ...live, capturedAt: at(FRESH_UNDER_MS) }, other], NOW).length, 0);
  assert.equal(findArbs([{ ...live, capturedAt: at(FRESH_UNDER_MS + 1) }, other], NOW).length, 0);

  const older = quote({ book: 'A', over: 200, under: -110, capturedAt: at(EXCLUDED_AFTER_MS) });
  const worse = quote({ book: 'B', over: -140, under: -110, capturedAt: at(0) });
  const kept = buildOddsScreen([older, worse], NOW);
  assert.equal(kept.shopping[0]?.bestOverBook, 'A');
  const dropped = buildOddsScreen([{ ...older, capturedAt: at(EXCLUDED_AFTER_MS + 1) }, worse], NOW);
  assert.equal(dropped.shopping[0]?.bestOverBook, 'B');
  assert.notEqual(dropped.shopping[0]?.bestOverBook, 'A');
});

test('a fat edge still produces zero flags', () => {
  const screen = buildOddsScreen(
    [
      quote({ book: 'A', over: 500, under: -110 }),
      quote({ book: 'B', over: -110, under: 450 }),
    ],
    NOW,
  );
  assert.ok(screen.arbs.length > 0);
  assert.ok(screen.arbs[0].profit > 0.25);
  assert.equal(screen.flags.length, 0);
  assert.deepEqual(screen.flags, []);
});

test('a two-book fixture puts the best over and the best under at different books, and a missing book is an empty cell', () => {
  const screen = buildOddsScreen(
    [
      quote({ book: 'DraftKings', over: -105, under: -125 }),
      quote({ book: 'FanDuel', over: -130, under: -102 }),
      quote({ book: 'BetMGM', player: 'Other', stat: 'reb', line: 8.5 }),
    ],
    NOW,
  );
  const row = screen.shopping.find((item) => item.player === 'Player');
  assert.ok(row);
  assert.equal(row.bestOverBook, 'DraftKings');
  assert.equal(row.bestUnderBook, 'FanDuel');
  assert.notEqual(row.bestOverBook, row.bestUnderBook);
  const missing = row.cells.find((cell) => cell.book === 'BetMGM');
  assert.ok(missing);
  assert.equal(missing.over, null);
  assert.equal(missing.under, null);
  assert.equal(missing.bestOver, false);
  assert.equal(missing.bestUnder, false);
  assert.equal(screen.reason, null);
});

test('one published book shows hold and freshness, and leaves shop, arb, middle, and +EV empty', () => {
  const screen = buildOddsScreen([quote({ book: 'DraftKings' })], NOW);
  assert.equal(screen.books.length, 1);
  assert.equal(screen.reason, ONE_BOOK_REASON);
  assert.equal(screen.lines.length, 1);
  assert.equal(screen.lines[0].noVigOver, 0.5);
  assert.equal((screen.lines[0].hold! * 100).toFixed(2), '4.76');
  assert.equal(screen.lines[0].freshness, 'fresh');
  assert.equal(screen.lines[0].lowHold, false);
  assert.deepEqual(screen.shopping, []);
  assert.deepEqual(screen.arbs, []);
  assert.deepEqual(screen.middles, []);
  assert.equal(screen.flags.length, 0);
  const html = renderOddsBoard(screen);
  assert.match(html, /Only one book is loaded\./);
  assert.match(html, /4\.76%/);
  assert.match(html, /data-freshness="fresh"/);
  assert.match(html, /data-board-list="shop"/);
  assert.match(html, /data-board-list="arb"/);
  assert.match(html, /data-board-list="middle"/);
  assert.match(html, /data-board-list="ev"/);
  assert.equal(html.includes('data-shop-row'), false);
});

test('a suspended quote and an excluded quote are not a best price, a low-hold mark, or an arb leg', () => {
  const juicy = quote({ book: 'A', over: 180, under: -101, status: 'suspended' });
  const open = quote({ book: 'B', over: -130, under: -130 });
  const screen = buildOddsScreen([juicy, open], NOW);
  assert.equal(screen.shopping[0]?.bestOverBook, 'B');
  assert.equal(screen.shopping[0]?.bestUnderBook, 'B');
  assert.equal(screen.lines.find((line) => line.book === 'A')?.lowHold, false);
  assert.equal(findArbs([juicy, open], NOW).length, 0);

  const stale = quote({ book: 'A', over: -101, under: -101, capturedAt: at(EXCLUDED_AFTER_MS + 1) });
  const priced = buildOddsScreen([stale, quote({ book: 'B', over: -120, under: -120 })], NOW);
  assert.equal(priced.lines.find((line) => line.book === 'A')?.freshness, 'excluded');
  assert.equal(priced.lines.find((line) => line.book === 'A')?.lowHold, false);
  assert.equal(priced.shopping[0]?.bestOverBook, 'B');
  const excludedCell = priced.shopping[0]?.cells.find((cell) => cell.book === 'A');
  assert.ok(excludedCell);
  assert.equal(excludedCell.lowHold, false);
  assert.equal(excludedCell.bestOver, false);
});

test('an active price under 2% hold is a low-hold mark, including while degraded', () => {
  const fresh = buildOddsScreen([quote({ over: -101, under: -101 })], NOW);
  assert.equal(fresh.lines[0].lowHold, true);
  assert.ok(fresh.lines[0].hold !== null && fresh.lines[0].hold < LOW_HOLD_UNDER);
  const degraded = buildOddsScreen([quote({ over: -101, under: -101, capturedAt: at(FRESH_UNDER_MS) })], NOW);
  assert.equal(degraded.lines[0].freshness, 'degraded');
  assert.equal(degraded.lines[0].lowHold, true);
});

test('the screen prices no middle when no window probability is supplied', () => {
  const screen = buildOddsScreen(
    [
      quote({ book: 'A', line: 24.5 }),
      quote({ book: 'B', line: 26.5 }),
    ],
    NOW,
  );
  assert.deepEqual(screen.middles, []);
  const middle = priceMiddle({
    overLine: 24.5,
    underLine: 26.5,
    overDecimal: 1.909,
    underDecimal: 1.909,
    windowProbability: 0.18,
  });
  assert.ok(middle);
  const html = renderOddsBoard({ ...screen, middles: [middle], books: ['A', 'B'] });
  assert.match(html, /positive-EV, not guaranteed profit/);
});

test('no quotes render an empty board', () => {
  assert.equal(renderOddsBoard(buildOddsScreen([], NOW)), '');
});
