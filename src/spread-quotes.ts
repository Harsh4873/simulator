import type { SpreadQuote } from './types.ts';

/** ESPN scoreboard point spreads, read the same way for the NBA rate card and the NFL bets of the day. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function quoteNumber(value: unknown, words: Readonly<Record<string, number>> = {}): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const word = words[text.toUpperCase()];
  if (word !== undefined) return word;
  if (!/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function currentSpreadSide(value: unknown): { line: number; odds: number } | null {
  // ESPN calls the latest price "close" even while the game is scheduled. Books print a pick'em line as PK and +100 as EVEN.
  if (!isRecord(value) || !isRecord(value.close)) return null;
  const line = quoteNumber(value.close.line, { PK: 0, PICK: 0 });
  const odds = quoteNumber(value.close.odds, { EVEN: 100, EV: 100 });
  if (line === null || !Number.isSafeInteger(line * 2) || odds === null || !Number.isSafeInteger(odds) || Math.abs(odds) < 100) return null;
  return { line, odds };
}

/** Each book's current two-sided spread on one scoreboard competition. A one-sided or mismatched offer is skipped. */
export function spreadQuotes(competition: Record<string, unknown>, capturedAt: string): SpreadQuote[] {
  if (!Array.isArray(competition.odds)) return [];
  const quotes: SpreadQuote[] = [];
  for (const offer of competition.odds) {
    if (!isRecord(offer) || !isRecord(offer.provider) || !isRecord(offer.pointSpread)) continue;
    const book = typeof offer.provider.name === 'string' ? offer.provider.name.trim() : '';
    const home = currentSpreadSide(offer.pointSpread.home);
    const away = currentSpreadSide(offer.pointSpread.away);
    if (!book || !home || !away || home.line !== -away.line) continue;
    quotes.push({ source: 'ESPN scoreboard', book, captured_at: capturedAt, home_spread: home.line, home_odds: home.odds, away_odds: away.odds });
  }
  return quotes;
}

/** A scoreboard game that has not started, with its start time and current spreads. */
export interface PregameQuotes {
  start: string;
  quotes: SpreadQuote[];
}

/**
 * The current spreads of every scoreboard game still to start, by event. A game in progress, final, or already past its
 * start time when the prices were read has none.
 */
export function pregameSpreadQuotes(payload: unknown, capturedAt: string): Map<string, PregameQuotes> {
  const out = new Map<string, PregameQuotes>();
  const events = isRecord(payload) && Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    if (!isRecord(event) || event.id === undefined) continue;
    const competition = Array.isArray(event.competitions) && isRecord(event.competitions[0]) ? event.competitions[0] : {};
    const status = isRecord(competition.status) ? competition.status : isRecord(event.status) ? event.status : {};
    const type = isRecord(status.type) ? status.type : {};
    if (type.state !== 'pre' || type.completed === true) continue;
    const start = Date.parse(String(event.date || competition.date || ''));
    if (!Number.isFinite(start) || !(Date.parse(capturedAt) < start)) continue;
    const quotes = spreadQuotes(competition, capturedAt);
    if (quotes.length) out.set(String(event.id), { start: new Date(start).toISOString(), quotes });
  }
  return out;
}
