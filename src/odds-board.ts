import { americanBreakEven, fairAmericanOdds, noVigFromBreakEven, profitPerStake, type PropMarket } from './props.ts';

/**
 * Posted-price board. American odds are converted to decimal when a price is used.
 * The screen takes quotes and the current time. It does not take a model probability, so flags stay empty.
 */

/** A quote younger than this is fresh. */
export const FRESH_UNDER_MS = 5 * 60 * 1000;
/** A quote this old is still a price, but it is no longer fresh. */
export const DEGRADED_THROUGH_MS = 30 * 60 * 1000;
/** A quote older than this is off the board for best prices, low-hold marks, and arb legs. */
export const EXCLUDED_AFTER_MS = 30 * 60 * 1000;
/** Hold strictly under this is a low-hold mark. */
export const LOW_HOLD_UNDER = 0.02;
/** Cross-book profit at or above this is an arb. */
export const MIN_ARB_PROFIT = 0.01;
/** Middle expected value, as a fraction of the stake, at or above this is flagged. */
export const MIN_MIDDLE_EV = 0.02;
/** Stake used to show an arb on the board. */
export const ARB_BANKROLL = 100;
/** Stake used to show a middle. */
export const MIDDLE_STAKE = 20;
export const MIDDLE_FLAG_LABEL = 'positive-EV, not guaranteed profit';
export const ONE_BOOK_REASON = 'Only one book is loaded.';

export type Freshness = 'fresh' | 'degraded' | 'excluded';
export type QuoteStatus = 'active' | 'suspended';

export interface OddsQuote {
  event: string;
  player: string;
  stat: PropMarket;
  line: number;
  period: 'full';
  book: string;
  /** American odds. */
  over: number;
  /** American odds. */
  under: number;
  capturedAt: string;
  status: QuoteStatus;
}

export interface Devig {
  hold: number;
  noVigOver: number;
  fairAmerican: number | null;
}

export interface BoardLine {
  event: string;
  player: string;
  stat: PropMarket;
  line: number;
  period: 'full';
  book: string;
  over: number;
  under: number;
  status: QuoteStatus;
  hold: number | null;
  noVigOver: number | null;
  fairAmerican: number | null;
  freshness: Freshness;
  lowHold: boolean;
}

export interface ShopCell {
  book: string;
  over: number | null;
  under: number | null;
  bestOver: boolean;
  bestUnder: boolean;
  lowHold: boolean;
}

export interface ShopRow {
  event: string;
  player: string;
  stat: PropMarket;
  line: number;
  period: 'full';
  cells: ShopCell[];
  bestOverBook: string | null;
  bestUnderBook: string | null;
}

export interface ArbLeg {
  book: string;
  american: number;
  decimal: number;
  stake: number;
}

export interface Arb {
  event: string;
  player: string;
  stat: PropMarket;
  line: number;
  period: 'full';
  profit: number;
  payout: number;
  over: ArbLeg;
  under: ArbLeg;
}

export interface Middle {
  overLine: number;
  underLine: number;
  overDecimal: number;
  underDecimal: number;
  stake: number;
  ev: number;
  breakEvenWindow: number;
  flagged: boolean;
  label: string | null;
}

export interface OddsScreen {
  lines: BoardLine[];
  books: string[];
  shopping: ShopRow[];
  arbs: Arb[];
  middles: Middle[];
  flags: readonly [];
  reason: string | null;
}

const STAT_LABEL: Record<PropMarket, string> = {
  pts: 'PTS',
  reb: 'REB',
  ast: 'AST',
  pra: 'PRA',
  pa: 'PA',
  pr: 'PR',
  ra: 'RA',
  tpm: '3PM',
  stl: 'STL',
  blk: 'BLK',
  tov: 'TOV',
  dd: 'DD',
  td: 'TD',
};

export function decimalOdds(american: number): number | null {
  const profit = profitPerStake(american);
  if (profit === null) return null;
  return 1 + profit;
}

export function devigPair(over: number, under: number): Devig | null {
  const overBreakEven = americanBreakEven(over);
  const underBreakEven = americanBreakEven(under);
  if (overBreakEven === null || underBreakEven === null) return null;
  const noVigOver = noVigFromBreakEven(overBreakEven, underBreakEven);
  if (noVigOver === null) return null;
  return {
    hold: overBreakEven + underBreakEven - 1,
    noVigOver,
    fairAmerican: fairAmericanOdds(noVigOver),
  };
}

export function freshnessOf(capturedAt: string, now: Date): Freshness {
  const at = Date.parse(capturedAt);
  if (!Number.isFinite(at)) return 'excluded';
  const age = now.getTime() - at;
  if (age > EXCLUDED_AFTER_MS) return 'excluded';
  if (age < FRESH_UNDER_MS) return 'fresh';
  if (age <= DEGRADED_THROUGH_MS) return 'degraded';
  return 'excluded';
}

function capturedMs(quote: OddsQuote): number {
  const at = Date.parse(quote.capturedAt);
  return Number.isFinite(at) ? at : -Infinity;
}

function canMark(quote: OddsQuote, now: Date): boolean {
  return quote.status === 'active' && freshnessOf(quote.capturedAt, now) !== 'excluded';
}

function canPrice(quote: OddsQuote, now: Date): boolean {
  return canMark(quote, now) && decimalOdds(quote.over) !== null && decimalOdds(quote.under) !== null;
}

function canArb(quote: OddsQuote, now: Date): boolean {
  return quote.status === 'active' && freshnessOf(quote.capturedAt, now) === 'fresh' && decimalOdds(quote.over) !== null && decimalOdds(quote.under) !== null;
}

function lowHoldMark(quote: OddsQuote, now: Date, hold: number | null): boolean {
  if (!canMark(quote, now) || hold === null) return false;
  return hold < LOW_HOLD_UNDER;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function arbFromDecimals(
  overDecimal: number,
  underDecimal: number,
  bankroll = ARB_BANKROLL,
): { profit: number; overStake: number; underStake: number; payout: number } | null {
  if (!(overDecimal > 1) || !(underDecimal > 1) || !(bankroll > 0)) return null;
  const overImplied = 1 / overDecimal;
  const underImplied = 1 / underDecimal;
  const sum = overImplied + underImplied;
  const profit = 1 - sum;
  if (!(profit >= MIN_ARB_PROFIT)) return null;
  return {
    profit,
    overStake: roundCents((bankroll * overImplied) / sum),
    underStake: roundCents((bankroll * underImplied) / sum),
    payout: roundCents(bankroll / sum),
  };
}

export function priceMiddle(input: {
  overLine: number;
  underLine: number;
  overDecimal: number;
  underDecimal: number;
  windowProbability: number | null;
  stake?: number;
}): Middle | null {
  if (input.windowProbability === null) return null;
  const { overLine, underLine, overDecimal, underDecimal } = input;
  const stake = input.stake ?? MIDDLE_STAKE;
  if (!Number.isFinite(input.windowProbability) || input.windowProbability < 0 || input.windowProbability > 1) return null;
  if (!(overLine < underLine) || !(overDecimal > 1) || !(underDecimal > 1) || !(stake > 0)) return null;
  const sum = 1 / overDecimal + 1 / underDecimal;
  const outsideProfit = stake * (1 / sum - 1);
  const bothProfit = stake * (2 / sum - 1);
  const ev = input.windowProbability * bothProfit + (1 - input.windowProbability) * outsideProfit;
  const flagged = ev / stake >= MIN_MIDDLE_EV;
  return {
    overLine,
    underLine,
    overDecimal,
    underDecimal,
    stake,
    ev,
    breakEvenWindow: sum - 1,
    flagged,
    label: flagged ? MIDDLE_FLAG_LABEL : null,
  };
}

function marketKey(quote: Pick<OddsQuote, 'event' | 'player' | 'stat' | 'line' | 'period'>): string {
  return [quote.event, quote.player, quote.stat, String(quote.line), quote.period].join('\0');
}

function booksOf(quotes: readonly OddsQuote[]): string[] {
  const books: string[] = [];
  for (const quote of quotes) {
    if (!books.includes(quote.book)) books.push(quote.book);
  }
  return books;
}

function grouped(quotes: readonly OddsQuote[]): OddsQuote[][] {
  const groups = new Map<string, OddsQuote[]>();
  for (const quote of quotes) {
    const key = marketKey(quote);
    const rows = groups.get(key);
    if (rows) rows.push(quote);
    else groups.set(key, [quote]);
  }
  return [...groups.values()].sort((a, b) => marketKey(a[0]).localeCompare(marketKey(b[0])));
}

function lineFrom(quote: OddsQuote, now: Date): BoardLine {
  const priced = devigPair(quote.over, quote.under);
  return {
    event: quote.event,
    player: quote.player,
    stat: quote.stat,
    line: quote.line,
    period: quote.period,
    book: quote.book,
    over: quote.over,
    under: quote.under,
    status: quote.status,
    hold: priced?.hold ?? null,
    noVigOver: priced?.noVigOver ?? null,
    fairAmerican: priced?.fairAmerican ?? null,
    freshness: freshnessOf(quote.capturedAt, now),
    lowHold: lowHoldMark(quote, now, priced?.hold ?? null),
  };
}

function chosenQuote(quotes: readonly OddsQuote[], now: Date): OddsQuote | null {
  if (quotes.length === 0) return null;
  const eligible = quotes.filter((quote) => canPrice(quote, now));
  const pool = eligible.length > 0 ? eligible : quotes;
  return pool.reduce((best, quote) => (capturedMs(quote) >= capturedMs(best) ? quote : best));
}

function shopRows(quotes: readonly OddsQuote[], now: Date, books: readonly string[]): ShopRow[] {
  const rows: ShopRow[] = [];
  for (const group of grouped(quotes)) {
    const byBook = new Map<string, OddsQuote[]>();
    for (const quote of group) {
      const list = byBook.get(quote.book);
      if (list) list.push(quote);
      else byBook.set(quote.book, [quote]);
    }
    const chosen = new Map<string, OddsQuote>();
    for (const [book, list] of byBook) {
      const pick = chosenQuote(list, now);
      if (pick) chosen.set(book, pick);
    }
    let bestOver: { book: string; decimal: number } | null = null;
    let bestUnder: { book: string; decimal: number } | null = null;
    for (const [book, quote] of chosen) {
      if (!canPrice(quote, now)) continue;
      const overDecimal = decimalOdds(quote.over);
      const underDecimal = decimalOdds(quote.under);
      if (overDecimal !== null && (bestOver === null || overDecimal > bestOver.decimal)) bestOver = { book, decimal: overDecimal };
      if (underDecimal !== null && (bestUnder === null || underDecimal > bestUnder.decimal)) bestUnder = { book, decimal: underDecimal };
    }
    const head = group[0];
    const cells = books.map((book): ShopCell => {
      const quote = chosen.get(book);
      if (!quote) return { book, over: null, under: null, bestOver: false, bestUnder: false, lowHold: false };
      const priced = devigPair(quote.over, quote.under);
      return {
        book,
        over: quote.over,
        under: quote.under,
        bestOver: bestOver?.book === book && canPrice(quote, now),
        bestUnder: bestUnder?.book === book && canPrice(quote, now),
        lowHold: lowHoldMark(quote, now, priced?.hold ?? null),
      };
    });
    rows.push({
      event: head.event,
      player: head.player,
      stat: head.stat,
      line: head.line,
      period: head.period,
      cells,
      bestOverBook: bestOver?.book ?? null,
      bestUnderBook: bestUnder?.book ?? null,
    });
  }
  return rows;
}

export function findArbs(quotes: readonly OddsQuote[], now: Date, bankroll = ARB_BANKROLL): Arb[] {
  const arbs: Arb[] = [];
  for (const group of grouped(quotes)) {
    const legs = group.filter((quote) => canArb(quote, now));
    let best: { over: OddsQuote; under: OddsQuote; overDecimal: number; underDecimal: number; priced: NonNullable<ReturnType<typeof arbFromDecimals>> } | null = null;
    for (const overQuote of legs) {
      const overDecimal = decimalOdds(overQuote.over);
      if (overDecimal === null) continue;
      for (const underQuote of legs) {
        if (overQuote.book === underQuote.book) continue;
        const underDecimal = decimalOdds(underQuote.under);
        if (underDecimal === null) continue;
        const priced = arbFromDecimals(overDecimal, underDecimal, bankroll);
        if (!priced) continue;
        if (!best || priced.profit > best.priced.profit) best = { over: overQuote, under: underQuote, overDecimal, underDecimal, priced };
      }
    }
    if (!best) continue;
    const head = best.over;
    arbs.push({
      event: head.event,
      player: head.player,
      stat: head.stat,
      line: head.line,
      period: head.period,
      profit: best.priced.profit,
      payout: best.priced.payout,
      over: { book: best.over.book, american: best.over.over, decimal: best.overDecimal, stake: best.priced.overStake },
      under: { book: best.under.book, american: best.under.under, decimal: best.underDecimal, stake: best.priced.underStake },
    });
  }
  return arbs;
}

export function buildOddsScreen(quotes: readonly OddsQuote[], now: Date): OddsScreen {
  const books = booksOf(quotes);
  const lines = quotes.map((quote) => lineFrom(quote, now)).sort((a, b) => marketKey(a).localeCompare(marketKey(b)) || a.book.localeCompare(b.book));
  const singleBook = books.length < 2;
  return {
    lines,
    books,
    shopping: singleBook ? [] : shopRows(quotes, now, books),
    arbs: singleBook ? [] : findArbs(quotes, now),
    // No window probability is supplied, so no middle is priced.
    middles: [],
    flags: [],
    reason: books.length === 1 ? ONE_BOOK_REASON : null,
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function americanText(odds: number): string {
  return odds > 0 ? `+${odds}` : String(odds);
}

function percentText(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function moneyText(value: number): string {
  return `$${value.toFixed(2)}`;
}

function lineCells(line: BoardLine): string {
  const hold = line.hold === null ? '—' : percentText(line.hold);
  const mark = line.lowHold ? ' · low hold' : '';
  const fair = line.fairAmerican === null ? '—' : americanText(line.fairAmerican);
  return `<tr>
    <td>${escapeHtml(line.event)}</td>
    <td>${escapeHtml(line.player)}</td>
    <td>${escapeHtml(STAT_LABEL[line.stat])}</td>
    <td>${escapeHtml(String(line.line))}</td>
    <td>${escapeHtml(line.book)}</td>
    <td>${escapeHtml(americanText(line.over))}</td>
    <td>${escapeHtml(americanText(line.under))}</td>
    <td>${escapeHtml(`${hold}${mark}`)}</td>
    <td>${escapeHtml(fair)}</td>
    <td data-freshness="${line.freshness}">${escapeHtml(line.freshness)}</td>
  </tr>`;
}

function shopTable(rows: readonly ShopRow[], books: readonly string[]): string {
  if (rows.length === 0) return '';
  const head = books.map((book) => `<th>${escapeHtml(book)}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          if (cell.over === null || cell.under === null) return '<td data-empty="true"></td>';
          const marks = [cell.bestOver ? 'best over' : '', cell.bestUnder ? 'best under' : '', cell.lowHold ? 'low hold' : ''].filter(Boolean).join(', ');
          const note = marks ? ` <span>${escapeHtml(marks)}</span>` : '';
          return `<td data-shop-row="true">${escapeHtml(americanText(cell.over))} / ${escapeHtml(americanText(cell.under))}${note}</td>`;
        })
        .join('');
      return `<tr data-shop-row="true"><th>${escapeHtml(row.player)}</th><td>${escapeHtml(STAT_LABEL[row.stat])}</td><td>${escapeHtml(String(row.line))}</td>${cells}</tr>`;
    })
    .join('');
  return `<div class="table-scroll"><table><thead><tr><th>Player</th><th>Stat</th><th>Line</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function arbTable(arbs: readonly Arb[]): string {
  if (arbs.length === 0) return '';
  const body = arbs
    .map(
      (arb) => `<tr>
        <td>${escapeHtml(arb.player)}</td>
        <td>${escapeHtml(STAT_LABEL[arb.stat])} ${escapeHtml(String(arb.line))}</td>
        <td>${escapeHtml(arb.over.book)} ${escapeHtml(americanText(arb.over.american))}</td>
        <td>${escapeHtml(moneyText(arb.over.stake))}</td>
        <td>${escapeHtml(arb.under.book)} ${escapeHtml(americanText(arb.under.american))}</td>
        <td>${escapeHtml(moneyText(arb.under.stake))}</td>
        <td>${escapeHtml(percentText(arb.profit))}</td>
        <td>${escapeHtml(moneyText(arb.payout))}</td>
      </tr>`,
    )
    .join('');
  return `<div class="table-scroll"><table><thead><tr><th>Player</th><th>Line</th><th>Over</th><th>Stake</th><th>Under</th><th>Stake</th><th>Profit</th><th>Payout</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function middleTable(middles: readonly Middle[]): string {
  if (middles.length === 0) return '';
  const body = middles
    .map((middle) => {
      const label = middle.label ? `<td>${escapeHtml(middle.label)}</td>` : '<td></td>';
      return `<tr><td>Over ${escapeHtml(String(middle.overLine))}</td><td>Under ${escapeHtml(String(middle.underLine))}</td><td>${escapeHtml(moneyText(middle.ev))}</td><td>${escapeHtml(percentText(middle.breakEvenWindow))}</td>${label}</tr>`;
    })
    .join('');
  return `<div class="table-scroll"><table><thead><tr><th>Over</th><th>Under</th><th>EV</th><th>Break-even window</th><th>Label</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function listBlock(name: string, title: string, body: string): string {
  return `<section data-board-list="${name}"><h3>${title}</h3>${body}</section>`;
}

export function renderOddsBoard(screen: OddsScreen): string {
  if (screen.lines.length === 0 && screen.shopping.length === 0 && screen.arbs.length === 0 && screen.middles.length === 0 && screen.flags.length === 0 && screen.reason === null) return '';
  const reason = screen.reason ? `<p class="projection-note" data-board-reason>${escapeHtml(screen.reason)}</p>` : '';
  const posted =
    screen.lines.length === 0
      ? ''
      : `<div class="table-scroll"><table><thead><tr><th>Event</th><th>Player</th><th>Stat</th><th>Line</th><th>Book</th><th>Over</th><th>Under</th><th>Hold</th><th>Fair</th><th>Freshness</th></tr></thead><tbody>${screen.lines.map(lineCells).join('')}</tbody></table></div>`;
  return `<div class="projection-page odds-page">
    ${posted}
    ${reason}
    ${listBlock('shop', 'Shop', shopTable(screen.shopping, screen.books))}
    ${listBlock('arb', 'Arbs', arbTable(screen.arbs))}
    ${listBlock('middle', 'Middles', middleTable(screen.middles))}
    ${listBlock('ev', '+EV', '')}
  </div>`;
}
