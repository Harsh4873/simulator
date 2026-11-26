import { chicagoDate } from './date.ts';
import type { PicksFile } from './picks.ts';
import type { PropMarket, PropSide } from './props.ts';
import type { SlateGame } from './types.ts';
import { MAX_CARD_AGE_MS } from './validate-card.ts';

/**
 * A price can back a new pick while it is no older than a card may be. The prop feed is checked a few times a day, so
 * the last check before a tip can be hours old; each pick prints when its price was checked.
 */
export const DAILY_PRICE_MAX_AGE_MS = MAX_CARD_AGE_MS;

export function currentDailyPrice(pricedAt: string, tip: string, now: Date): boolean {
  const age = now.getTime() - Date.parse(pricedAt);
  return age >= 0 && age <= DAILY_PRICE_MAX_AGE_MS && now.getTime() < Date.parse(tip);
}

export function upcomingToday(game: SlateGame, now: Date): boolean {
  return game.date === chicagoDate(now) && game.status_state === 'pre' && !game.completed && Date.parse(game.start_time) > now.getTime();
}

/**
 * BET and LEAN clear every check, including (for a prop) a live record of leans like it beating the price. EDGE clears
 * the price, noise and data checks without that record. Below the edge bar a prop is still posted when nothing better
 * is: THIN when its calibrated chance beats the break-even by less than the bar, TOP when it does not beat it at all.
 * Each ranks below every grade before it.
 */
export type DailyGrade = 'BET' | 'LEAN' | 'EDGE' | 'THIN' | 'TOP';

const GRADE_RANK: Readonly<Record<DailyGrade, number>> = { BET: 4, LEAN: 3, EDGE: 2, THIN: 1, TOP: 0 };
const DAILY_GRADES = Object.keys(GRADE_RANK) as DailyGrade[];

export function gradeRank(grade: DailyGrade): number {
  return GRADE_RANK[grade];
}

/** How a pick settles: the side and handicap of a spread, or the player, stat, side and line of a prop. */
export type DailySettle =
  | { kind: 'spread'; side: 'home' | 'away'; home_spread: number; home: string; away: string }
  | { kind: 'prop'; athlete_id: string; market: PropMarket; side: PropSide; line: number };

export interface DailyOffer {
  eventId: string;
  title: string;
  projectionLabel: string;
  matchup: string;
  tip: string;
  pricedAt: string;
  book: string;
  odds: number;
  modelProbability: number;
  breakEven: number;
  expectedReturn: number;
  grade: DailyGrade;
  /** What the grade rests on, in words: the live record of leans like it, or that none exists yet. */
  evidence?: string;
  settle?: DailySettle;
}

/** What the panel reads from picks.json: its posted prices. */
export type DailyPicks = Pick<PicksFile, 'lines'> & Partial<Pick<PicksFile, 'offers'>>;

export function compareOffers(a: DailyOffer, b: DailyOffer): number {
  return gradeRank(b.grade) - gradeRank(a.grade) || b.expectedReturn - a.expectedReturn ||
    b.modelProbability - a.modelProbability || a.tip.localeCompare(b.tip) ||
    a.title.localeCompare(b.title) || a.book.localeCompare(b.book) || a.eventId.localeCompare(b.eventId);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function validSettle(value: unknown): value is DailySettle {
  if (!value || typeof value !== 'object') return false;
  const settle = value as Record<string, unknown>;
  if (settle.kind === 'spread') {
    return (settle.side === 'home' || settle.side === 'away') && finite(settle.home_spread) && Number.isInteger(2 * settle.home_spread) &&
      text(settle.home) && text(settle.away);
  }
  return settle.kind === 'prop' && text(settle.athlete_id) && text(settle.market) && (settle.side === 'over' || settle.side === 'under') &&
    finite(settle.line) && settle.line >= 0;
}

export function isDailyOffer(value: unknown): value is DailyOffer {
  if (!value || typeof value !== 'object') return false;
  const offer = value as Partial<DailyOffer>;
  return [offer.eventId, offer.title, offer.projectionLabel, offer.matchup, offer.book].every(text) &&
    typeof offer.tip === 'string' && Number.isFinite(Date.parse(offer.tip)) &&
    typeof offer.pricedAt === 'string' && Number.isFinite(Date.parse(offer.pricedAt)) &&
    DAILY_GRADES.includes(offer.grade as DailyGrade) && finite(offer.odds) && Math.abs(offer.odds) >= 100 &&
    finite(offer.modelProbability) && offer.modelProbability > 0 && offer.modelProbability <= 1 &&
    finite(offer.breakEven) && offer.breakEven > 0 && offer.breakEven < 1 &&
    finite(offer.expectedReturn) && offer.expectedReturn > -1 &&
    // Only a top prop may sit at or under its break-even; every other grade beats the price.
    (offer.grade === 'TOP' || (offer.breakEven < offer.modelProbability && offer.expectedReturn > 0)) &&
    (offer.evidence === undefined || typeof offer.evidence === 'string') &&
    (offer.settle === undefined || validSettle(offer.settle));
}

function propPriced(picks: DailyPicks, game: SlateGame, now: Date): boolean {
  const stamps = picks.offers ? (picks.offers[game.event_id] ?? []).map(row => row[6]) : (picks.lines[game.event_id] ?? []).map(row => row[5]);
  return stamps.some(at => currentDailyPrice(at, game.start_time, now));
}

/** Why no player prop has been posted today while games remain. */
export function propNote(picks: DailyPicks | null, upcoming: readonly SlateGame[], now: Date): string {
  if (!picks || !upcoming.some(game => propPriced(picks, game, now))) return 'No current player prop price for today’s remaining games.';
  return 'No player prop has cleared the model’s price, noise and data checks yet today.';
}

/** Why no spread has been posted today while games remain. */
export function spreadNote(upcoming: readonly SlateGame[], now: Date): string {
  return upcoming.some(game => game.spread_quotes?.some(quote => currentDailyPrice(quote.captured_at, game.start_time, now)))
    ? 'No spread has cleared the model’s edge and noise checks yet today.'
    : 'No current spread price for today’s remaining games.';
}
