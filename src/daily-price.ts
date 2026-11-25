import { chicagoDate } from './date.ts';
import type { PicksFile } from './picks.ts';
import type { Slate, SlateGame } from './types.ts';
import { MAX_CARD_AGE_MS } from './validate-card.ts';

/**
 * A price stays on the panel while it is no older than a card may be. The prop feed is checked a few times a day, so
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
 * BET and LEAN clear every check, including (for a prop) a live record of leans like it beating the price. EDGE is the
 * strongest prop that clears the price, noise and data checks without that record, shown only when nothing qualifies.
 */
export type DailyGrade = 'BET' | 'LEAN' | 'EDGE';

const GRADE_RANK: Readonly<Record<DailyGrade, number>> = { BET: 2, LEAN: 1, EDGE: 0 };

export function gradeRank(grade: DailyGrade): number {
  return GRADE_RANK[grade];
}

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
}

export interface DailyPanelState {
  status: 'open' | 'finished' | 'unavailable' | 'stale';
  prop: DailyOffer | null;
  spread: DailyOffer | null;
  /** Why a category has no offer, shown in its place. */
  propNote?: string;
  spreadNote?: string;
}

/** Per-game candidates let a page left open at tip select the next eligible game. */
export interface DailyCandidates {
  date: string;
  slateHash: string;
  picksBuiltAt: string | null;
  props: DailyOffer[];
  spreads: DailyOffer[];
}

/** What the panel reads from picks.json: its build stamp and its posted prices. */
export type DailyPicks = Pick<PicksFile, 'built_at' | 'lines'> & Partial<Pick<PicksFile, 'offers' | 'record'>>;

export function compareOffers(a: DailyOffer, b: DailyOffer): number {
  return gradeRank(b.grade) - gradeRank(a.grade) || b.expectedReturn - a.expectedReturn ||
    b.modelProbability - a.modelProbability || a.tip.localeCompare(b.tip) ||
    a.title.localeCompare(b.title) || a.book.localeCompare(b.book) || a.eventId.localeCompare(b.eventId);
}

function validOffer(value: unknown): value is DailyOffer {
  if (!value || typeof value !== 'object') return false;
  const offer = value as Partial<DailyOffer>;
  return [offer.eventId, offer.title, offer.projectionLabel, offer.matchup, offer.book].every(s => typeof s === 'string' && s.trim()) &&
    typeof offer.tip === 'string' && Number.isFinite(Date.parse(offer.tip)) &&
    typeof offer.pricedAt === 'string' && Number.isFinite(Date.parse(offer.pricedAt)) &&
    (offer.grade === 'BET' || offer.grade === 'LEAN' || offer.grade === 'EDGE') && typeof offer.odds === 'number' && Number.isFinite(offer.odds) && Math.abs(offer.odds) >= 100 &&
    typeof offer.modelProbability === 'number' && offer.modelProbability > 0 && offer.modelProbability <= 1 &&
    typeof offer.breakEven === 'number' && offer.breakEven > 0 && offer.breakEven < offer.modelProbability &&
    typeof offer.expectedReturn === 'number' && Number.isFinite(offer.expectedReturn) && offer.expectedReturn > 0 &&
    (offer.evidence === undefined || typeof offer.evidence === 'string');
}

export function parseDailyCandidates(value: unknown): DailyCandidates | null {
  if (!value || typeof value !== 'object') return null;
  const file = value as Partial<DailyCandidates>;
  if (typeof file.date !== 'string' || typeof file.slateHash !== 'string' || !/^[a-f0-9]{64}$/.test(file.slateHash) ||
      !(typeof file.picksBuiltAt === 'string' || file.picksBuiltAt === null) || !Array.isArray(file.props) || !Array.isArray(file.spreads)) return null;
  return { date: file.date, slateHash: file.slateHash, picksBuiltAt: file.picksBuiltAt, props: file.props.filter(validOffer), spreads: file.spreads.filter(validOffer) };
}

function propPriced(picks: DailyPicks, game: SlateGame, now: Date): boolean {
  const stamps = picks.offers ? (picks.offers[game.event_id] ?? []).map(row => row[6]) : (picks.lines[game.event_id] ?? []).map(row => row[5]);
  return stamps.some(at => currentDailyPrice(at, game.start_time, now));
}

function propNote(picks: DailyPicks | null, sameBuild: boolean, upcoming: readonly SlateGame[], now: Date): string {
  if (!picks || !upcoming.some(game => propPriced(picks, game, now))) return 'No current player prop price for today’s remaining games.';
  if (!sameBuild) return 'Player prop prices changed after today’s picks were made. They return with the next update.';
  // A prop without a live record still shows as an unproven edge, so an empty category means no price gap held up.
  return 'No current player prop clears the model’s price, noise and data checks.';
}

function spreadNote(upcoming: readonly SlateGame[], now: Date): string {
  return upcoming.some(game => game.spread_quotes?.some(quote => currentDailyPrice(quote.captured_at, game.start_time, now)))
    ? 'No spread clears the model’s edge and noise checks at the current price.'
    : 'No current spread price for today’s remaining games.';
}

export function dailyPanelState(slate: Slate, candidates: DailyCandidates | null, slateHash: string | null, picks: DailyPicks | null, now: Date, stale: boolean): DailyPanelState {
  const empty = { prop: null, spread: null };
  if (stale || slate.date !== chicagoDate(now)) return { ...empty, status: 'stale' };
  const upcoming = slate.games.filter(game => upcomingToday(game, now));
  if (!upcoming.length) return { ...empty, status: 'finished' };
  if (!candidates || candidates.date !== slate.date || candidates.slateHash !== slateHash) return { ...empty, status: 'unavailable' };
  const tips = new Map(upcoming.map(game => [game.event_id, game.start_time]));
  const best = (offers: DailyOffer[]) => offers.filter(offer => tips.get(offer.eventId) === offer.tip && currentDailyPrice(offer.pricedAt, offer.tip, now)).sort(compareOffers)[0] ?? null;
  // A prop was chosen against one build of picks.json. Another build can hold other prices, so it is not shown beside one.
  const sameBuild = Boolean(picks) && candidates.picksBuiltAt === picks!.built_at;
  const prop = sameBuild ? best(candidates.props) : null;
  const spread = best(candidates.spreads);
  return {
    status: 'open',
    prop,
    spread,
    ...(prop ? {} : { propNote: propNote(picks, sameBuild, upcoming, now) }),
    ...(spread ? {} : { spreadNote: spreadNote(upcoming, now) }),
  };
}
