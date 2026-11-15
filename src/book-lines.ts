import { americanBreakEven, noVigProbability, type PropMarket } from './props.ts';

/**
 * Posted sportsbook over/under lines for player stats, read from PickLedger's public NBA prop price files.
 * They are compared with the simulations after the draws exist. They never enter fitting or sampling.
 */
export interface BookLine {
  event_id: string;
  athlete_id: string;
  market: PropMarket;
  line: number;
  over_odds: number;
  under_odds: number;
  /** When the feed last saw this price. */
  priced_at: string;
  book: string;
  /** Scheduled tip from the feed row, when it carried one. */
  tip?: string | null;
}

/** Rows from one capture share a stamp. Anything this much older than the last capture was not in it. */
export const CAPTURE_TOLERANCE_MS = 10 * 60_000;

export const BOOK_STAT_MARKETS: Readonly<Record<string, PropMarket>> = {
  points: 'pts',
  totalRebounds: 'reb',
  assists: 'ast',
  three_pointers_made: 'tpm',
  points_rebounds: 'pr',
  points_assists: 'pa',
  points_rebounds_assists: 'pra',
  rebounds_assists: 'ra',
  steals: 'stl',
  blocks: 'blk',
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function american(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 100) return null;
  return value;
}

/** ESPN stamps drop the seconds; every instant is normalised to one ISO form so later comparisons are exact. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

export function bookKey(line: Pick<BookLine, 'event_id' | 'athlete_id' | 'market'>): string {
  return `${line.event_id}:${line.athlete_id}:${line.market}`;
}

/**
 * Two-sided pre-game totals only. One-sided milestone ladders have no under price, so they cannot be compared.
 * A moved line leaves its old row behind with an older stamp; every row is returned and `currentLines` picks.
 */
export function parseBookLines(text: string): BookLine[] {
  const lines: BookLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const row = record(value);
    if (!row || String(row.sport ?? '').toUpperCase() !== 'NBA' || row.market_format !== 'total' || row.pregame !== true) continue;
    const market = BOOK_STAT_MARKETS[String(row.stat_key ?? '')];
    const eventId = String(row.event_id ?? '').trim();
    const athleteId = String(row.athlete_id ?? '').trim();
    const line = typeof row.line === 'number' ? row.line : NaN;
    const over = american(row.over_odds);
    const under = american(row.under_odds);
    const pricedAt = instant(row.retrieved_at);
    const tip = instant(row.start_time);
    if (!market || !/^\d+$/.test(eventId) || !/^\d+$/.test(athleteId) || over === null || under === null || !pricedAt) continue;
    if (!Number.isFinite(line) || line < 0 || line > 200 || !Number.isInteger(line * 2)) continue;
    // A price stamped at or after the tip is not a pre-game price, whatever the row says.
    if (tip && Date.parse(pricedAt) >= Date.parse(tip)) continue;
    lines.push({
      event_id: eventId,
      athlete_id: athleteId,
      market,
      line,
      over_odds: over,
      under_odds: under,
      priced_at: pricedAt,
      book: String(row.provider ?? '').trim().slice(0, 40) || 'sportsbook',
      tip,
    });
  }
  return lines;
}

/** The latest posted line for each player and stat as of `asOf` (default: the latest in the file). */
export function currentLines(lines: readonly BookLine[], asOf?: string): Map<string, BookLine> {
  const limit = asOf ? Date.parse(asOf) : Infinity;
  const latest = new Map<string, BookLine>();
  for (const line of lines) {
    const at = Date.parse(line.priced_at);
    if (!(at <= limit)) continue;
    const key = bookKey(line);
    const previous = latest.get(key);
    // Equal stamps are one capture showing two rungs; the one priced closest to even money is the main line.
    if (!previous || at > Date.parse(previous.priced_at) || (at === Date.parse(previous.priced_at) && balance(line) < balance(previous))) latest.set(key, line);
  }
  return latest;
}

/**
 * The lines one day's file shows as posted as of `asOf`: only rows from the file's last capture before each game's
 * tip. The feed keeps a row it no longer sees, with its old stamp, so a market the book pulled after injury news
 * still looks priced. Comparing a card that has the news with that dead price manufactures a huge edge nobody could
 * bet. Pass one day at a time: each day's file is captured by its own runs.
 */
export function postedLines(day: readonly BookLine[], asOf?: string): Map<string, BookLine> {
  const limit = asOf ? Date.parse(asOf) : Infinity;
  const stamps = [...new Set(day.map((line) => Date.parse(line.priced_at)))].filter((at) => at <= limit).sort((a, b) => a - b);
  const live: BookLine[] = [];
  for (const line of day) {
    const at = Date.parse(line.priced_at);
    if (!(at <= limit)) continue;
    const tip = line.tip ? Date.parse(line.tip) : Infinity;
    if (!(at < tip)) continue;
    let last = -Infinity;
    for (const stamp of stamps) {
      if (!(stamp < tip)) break;
      last = stamp;
    }
    if (last - at <= CAPTURE_TOLERANCE_MS) live.push(line);
  }
  return currentLines(live);
}

function balance(line: BookLine): number {
  const fair = noVigProbability(line.over_odds, line.under_odds);
  return fair === null ? 1 : Math.abs(fair - 0.5);
}

export function breakEven(line: Pick<BookLine, 'over_odds' | 'under_odds'>, side: 'over' | 'under'): number {
  return americanBreakEven(side === 'over' ? line.over_odds : line.under_odds) ?? 1;
}

export function fairOver(line: Pick<BookLine, 'over_odds' | 'under_odds'>): number | null {
  return noVigProbability(line.over_odds, line.under_odds);
}
