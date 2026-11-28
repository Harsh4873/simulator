/**
 * Bets of the day, as posted. A category (NBA player prop, NBA game spread, NFL game spread) keeps a set number of picks
 * open at a time: two player props, from different games, and one spread in each league. A pick is fixed at the line and
 * price it was posted with, stays posted until its game tips, and is then followed by the best pick from the games still
 * to play. Every posted pick is kept, shown, and graded into the record.
 */
import { chicagoDate, shiftChicagoDate } from './date.ts';
import {
  compareOffers, isDailyOffer, nflUpcomingToday, propNote, spreadNote, upcomingToday, type DailyOffer, type DailyPicks, type DailySettle,
} from './daily-price.ts';
import type { FeedGame } from './feed.ts';
import type { CompletedEvent, ParsedPlayerGame } from './parse-summary.ts';
import { boxValue } from './pick-ledger.ts';
import { profitPerStake } from './props.ts';
import type { Slate } from './types.ts';

/** NBA player props, NBA game spreads (the team bets), and NFL game spreads. NFL player props are not posted. */
export type DailyCategory = 'prop' | 'spread' | 'nfl_spread';
export const DAILY_CATEGORIES: readonly DailyCategory[] = ['spread', 'prop', 'nfl_spread'];

/** How a category's picks settle: on a player's box score, or on the final margin. */
export function settleKind(category: DailyCategory): DailySettle['kind'] {
  return category === 'prop' ? 'prop' : 'spread';
}

export type DailyOutcome = 'win' | 'loss' | 'push' | 'void';

export interface DailyResult {
  outcome: DailyOutcome;
  /** The home team's final margin for a spread; the player's stat for a prop. A void has none. */
  actual?: number;
  /** Profit on one unit at the posted price: the payout on a win, -1 on a loss, 0 on a push or void. */
  units: number;
  /** Why a pick voided: the player did not play, or the game has no final three days after its date. */
  reason?: 'dnp' | 'no result';
  settled_at: string;
}

/** A pick as the panel posted it. Only `result` is added later. */
export interface PostedDailyPick extends DailyOffer {
  category: DailyCategory;
  /** The Chicago date of its game. */
  date: string;
  posted_at: string;
  settle: DailySettle;
  result?: DailyResult;
}

export interface DailyLedgerDay {
  schema_version: 1;
  date: string;
  picks: PostedDailyPick[];
}

export interface DailyRecordLine {
  picks: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  pending: number;
  units: number;
  /** First date with a posted pick in this line. */
  from: string | null;
}

export interface DailyRecord {
  all: DailyRecordLine;
  prop: DailyRecordLine;
  spread: DailyRecordLine;
  nfl_spread: DailyRecordLine;
  /** First date with a posted pick. */
  from: string | null;
}

/** What the page reads: the picks of the slate's two days and the record over every posted pick. */
export interface DailyFile {
  schema_version: 1;
  built_at: string;
  picks: PostedDailyPick[];
  record: DailyRecord;
}

export interface DailyFinal {
  home: number;
  away: number;
}

/** A game with no final this many days after its date was postponed or never reported, and its pick voids. */
export const UNPLAYED_VOID_DAYS = 3;

export function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function emptyDay(date: string): DailyLedgerDay {
  return { schema_version: 1, date, picks: [] };
}

/**
 * How many picks a category keeps open at once. Player props keep two, from different games, so a day with two priced
 * games always has at least two; each spread category keeps one.
 */
export const DAILY_SLOTS: Readonly<Record<DailyCategory, number>> = { spread: 1, prop: 2, nfl_spread: 1 };

/** The category's picks whose games have not tipped yet. */
export function openPicks(day: DailyLedgerDay, category: DailyCategory, now: Date): PostedDailyPick[] {
  return day.picks.filter((pick) => pick.category === category && Date.parse(pick.tip) > now.getTime());
}

/** The category's first pick whose game has not tipped yet, if one is posted. */
export function openPick(day: DailyLedgerDay, category: DailyCategory, now: Date): PostedDailyPick | null {
  return openPicks(day, category, now)[0] ?? null;
}

/** How many more picks the category can post now. */
export function openSlots(day: DailyLedgerDay, category: DailyCategory, now: Date): number {
  return Math.max(0, DAILY_SLOTS[category] - openPicks(day, category, now).length);
}

function posted(offer: DailyOffer & { settle: DailySettle }, category: DailyCategory, date: string, now: Date): PostedDailyPick {
  const { eventId, title, projectionLabel, matchup, tip, pricedAt, book, odds, modelProbability, breakEven, expectedReturn, grade, evidence, settle } = offer;
  return {
    category, date, posted_at: stamp(now), eventId, title, projectionLabel, matchup, tip, pricedAt, book, odds,
    modelProbability, breakEven, expectedReturn, grade, ...(evidence ? { evidence } : {}), settle,
  };
}

/**
 * Fills each category's open slots with its best candidates, one per game. A game already posted in a category is not
 * posted in it again the same day. Returns what it posted.
 */
export function postDailyPicks(day: DailyLedgerDay, candidates: Readonly<Partial<Record<DailyCategory, readonly DailyOffer[]>>>, now: Date): PostedDailyPick[] {
  const added: PostedDailyPick[] = [];
  for (const category of DAILY_CATEGORIES) {
    let slots = openSlots(day, category, now);
    if (!slots) continue;
    const taken = new Set(day.picks.filter((pick) => pick.category === category).map((pick) => pick.eventId));
    const ranked = (candidates[category] ?? [])
      .filter((offer): offer is DailyOffer & { settle: DailySettle } => Boolean(offer.settle) && offer.settle!.kind === settleKind(category) &&
        !taken.has(offer.eventId) && Date.parse(offer.tip) > now.getTime())
      .sort(compareOffers);
    for (const best of ranked) {
      if (!slots) break;
      if (taken.has(best.eventId)) continue;
      const pick = posted(best, category, day.date, now);
      day.picks.push(pick);
      added.push(pick);
      taken.add(best.eventId);
      slots -= 1;
    }
  }
  return added;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Double- and triple-doubles count the five standard categories at ten or more. */
function milestone(box: ParsedPlayerGame, market: 'dd' | 'td'): number {
  const tens = [box.pts, box.reb, box.ast, box.stl ?? 0, box.blk ?? 0].filter((value) => value >= 10).length;
  return tens >= (market === 'dd' ? 2 : 3) ? 1 : 0;
}

function graded(diff: number, actual: number, odds: number, at: string): DailyResult {
  if (diff > 0) return { outcome: 'win', actual, units: round(profitPerStake(odds) ?? 0), settled_at: at };
  if (diff < 0) return { outcome: 'loss', actual, units: -1, settled_at: at };
  return { outcome: 'push', actual, units: 0, settled_at: at };
}

/** A pick's result once its game is final, or null while it is not. */
export function settleDailyPick(pick: PostedDailyPick, finals: ReadonlyMap<string, DailyFinal>, events: ReadonlyMap<string, CompletedEvent>, now: Date): DailyResult | null {
  const at = stamp(now);
  const unplayed = (): DailyResult | null =>
    shiftChicagoDate(pick.date, UNPLAYED_VOID_DAYS) < chicagoDate(now) ? { outcome: 'void', reason: 'no result', units: 0, settled_at: at } : null;
  const event = events.get(pick.eventId);
  const settle = pick.settle;
  if (settle.kind === 'spread') {
    const final = finals.get(pick.eventId) ?? (event ? { home: event.home_pts, away: event.away_pts } : null);
    if (!final || !Number.isFinite(final.home) || !Number.isFinite(final.away)) return unplayed();
    const margin = final.home - final.away;
    const cover = margin + settle.home_spread;
    return graded(settle.side === 'home' ? cover : -cover, margin, pick.odds, at);
  }
  if (!event) return unplayed();
  const box = event.players.find((player) => player.athlete_id === settle.athlete_id);
  if (!box || !(box.minutes > 0)) return { outcome: 'void', reason: 'dnp', units: 0, settled_at: at };
  const actual = settle.market === 'dd' || settle.market === 'td' ? milestone(box, settle.market) : boxValue(box, settle.market);
  if (actual === null) return null;
  return graded(settle.side === 'over' ? actual - settle.line : settle.line - actual, actual, pick.odds, at);
}

/** Grades every posted pick that has no result yet. Returns how many it graded. */
export function settleDailyPicks(days: Iterable<DailyLedgerDay>, finals: ReadonlyMap<string, DailyFinal>, events: ReadonlyMap<string, CompletedEvent>, now: Date): number {
  let settled = 0;
  for (const day of days) {
    for (const pick of day.picks) {
      if (pick.result) continue;
      const result = settleDailyPick(pick, finals, events, now);
      if (!result) continue;
      pick.result = result;
      settled += 1;
    }
  }
  return settled;
}

function emptyLine(): DailyRecordLine {
  return { picks: 0, wins: 0, losses: 0, pushes: 0, voids: 0, pending: 0, units: 0, from: null };
}

export function dailyRecord(days: Iterable<DailyLedgerDay>): DailyRecord {
  const record: DailyRecord = { all: emptyLine(), prop: emptyLine(), spread: emptyLine(), nfl_spread: emptyLine(), from: null };
  for (const day of days) {
    for (const pick of day.picks) {
      if (!record.from || pick.date < record.from) record.from = pick.date;
      for (const line of [record.all, record[pick.category]]) {
        if (!line.from || pick.date < line.from) line.from = pick.date;
        line.picks += 1;
        const outcome = pick.result?.outcome;
        if (outcome === 'win') line.wins += 1;
        else if (outcome === 'loss') line.losses += 1;
        else if (outcome === 'push') line.pushes += 1;
        else if (outcome === 'void') line.voids += 1;
        else line.pending += 1;
        line.units = round(line.units + (pick.result?.units ?? 0));
      }
    }
  }
  return record;
}

export function parseDailyDay(text: string): DailyLedgerDay | null {
  try {
    const day = JSON.parse(text) as Partial<DailyLedgerDay> | null;
    if (!day || day.schema_version !== 1 || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Array.isArray(day.picks)) return null;
    return day.picks.every(isPostedPick) ? (day as DailyLedgerDay) : null;
  } catch {
    return null;
  }
}

/** One pick a line, in posting order, so a later run changes only the lines it touched. */
export function serializeDailyDay(day: DailyLedgerDay): string {
  const head = JSON.stringify({ schema_version: 1, date: day.date });
  return `${head.slice(0, -1)},"picks":[\n${day.picks.map((pick) => JSON.stringify(pick)).join(',\n')}\n]}\n`;
}

function isResult(value: unknown): value is DailyResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<DailyResult>;
  return ['win', 'loss', 'push', 'void'].includes(result.outcome as string) && typeof result.units === 'number' && Number.isFinite(result.units) &&
    (result.actual === undefined || (typeof result.actual === 'number' && Number.isFinite(result.actual))) &&
    (result.reason === undefined || result.reason === 'dnp' || result.reason === 'no result') &&
    typeof result.settled_at === 'string' && Number.isFinite(Date.parse(result.settled_at));
}

export function isPostedPick(value: unknown): value is PostedDailyPick {
  if (!isDailyOffer(value)) return false;
  const pick = value as Partial<PostedDailyPick>;
  return DAILY_CATEGORIES.includes(pick.category as DailyCategory) && pick.settle?.kind === settleKind(pick.category as DailyCategory) &&
    typeof pick.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(pick.date) &&
    typeof pick.posted_at === 'string' && Number.isFinite(Date.parse(pick.posted_at)) &&
    (pick.result === undefined || isResult(pick.result));
}

function isRecordLine(value: unknown): value is DailyRecordLine {
  if (!value || typeof value !== 'object') return false;
  const line = value as Record<string, unknown>;
  return ['picks', 'wins', 'losses', 'pushes', 'voids', 'pending', 'units'].every((key) => typeof line[key] === 'number' && Number.isFinite(line[key])) &&
    (line.from === undefined || line.from === null || (typeof line.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(line.from)));
}

export function parseDailyFile(text: string): DailyFile | null {
  try {
    const file = JSON.parse(text) as Partial<DailyFile> | null;
    if (!file || file.schema_version !== 1 || typeof file.built_at !== 'string' || !Array.isArray(file.picks)) return null;
    const record = file.record;
    if (!record || !isRecordLine(record.all) || !isRecordLine(record.prop) || !isRecordLine(record.spread) ||
        !(record.nfl_spread === undefined || isRecordLine(record.nfl_spread)) || !(record.from === null || typeof record.from === 'string')) return null;
    // A file written before NFL spreads were posted has no line for them.
    return { schema_version: 1, built_at: file.built_at, picks: file.picks.filter(isPostedPick), record: { ...record, nfl_spread: record.nfl_spread ?? emptyLine() } };
  } catch {
    return null;
  }
}

/** The published file: the picks of the two slate days, oldest first, and the record over every day. */
export function dailyFile(days: ReadonlyMap<string, DailyLedgerDay>, dates: readonly string[], now: Date): DailyFile {
  const picks = [...new Set(dates)].sort().flatMap((date) => days.get(date)?.picks ?? []);
  return { schema_version: 1, built_at: stamp(now), picks, record: dailyRecord(days.values()) };
}

/** Where a posted pick stands for a viewer: still to tip, playing, waiting on its final, or graded. */
export type DailyPickState = 'open' | 'live' | 'awaiting' | DailyOutcome;

/** About how long a game runs. After that an ungraded pick is waiting on its final, not in play. */
const GAME_LENGTH_MS: Readonly<Record<DailyCategory, number>> = { prop: 3 * 3600000, spread: 3 * 3600000, nfl_spread: 3.5 * 3600000 };

export function pickState(pick: PostedDailyPick, now: Date): DailyPickState {
  if (pick.result) return pick.result.outcome;
  const tip = Date.parse(pick.tip);
  if (now.getTime() < tip) return 'open';
  return now.getTime() < tip + GAME_LENGTH_MS[pick.category] ? 'live' : 'awaiting';
}

export interface DailyPanelPick extends PostedDailyPick {
  state: DailyPickState;
}

/** One panel's bets of the day, each category with its own record: NBA Games shows the game spreads, NBA Projections the player props, and NFL its game spreads. */
export interface DailyPanelState {
  status: 'open' | 'unavailable';
  category: DailyCategory;
  record: DailyRecordLine | null;
  today: DailyPanelPick[];
  yesterday: DailyPanelPick[];
  /** Why the category has no pick today, or when its next one posts. */
  notes: string[];
}

function unavailable(category: DailyCategory): DailyPanelState {
  return { status: 'unavailable', category, record: null, today: [], yesterday: [], notes: [] };
}

/** The category's picks for today and yesterday, by start time, each with where it stands. */
function categoryPicks(file: DailyFile, category: DailyCategory, now: Date): { today: DailyPanelPick[]; yesterday: DailyPanelPick[] } {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  const withState = (pick: PostedDailyPick): DailyPanelPick => ({ ...pick, state: pickState(pick, now) });
  const byTip = (a: PostedDailyPick, b: PostedDailyPick) => a.tip.localeCompare(b.tip) || a.posted_at.localeCompare(b.posted_at);
  const mine = file.picks.filter((pick) => pick.category === category);
  return {
    today: mine.filter((pick) => pick.date === today).sort(byTip).map(withState),
    yesterday: mine.filter((pick) => pick.date === yesterday).sort(byTip).map(withState),
  };
}

export function dailyPanelState(file: DailyFile | null, slate: Slate, picks: DailyPicks | null, now: Date, category: DailyCategory): DailyPanelState {
  if (!file) return unavailable(category);
  const { today, yesterday } = categoryPicks(file, category, now);
  const upcoming = slate.games.filter((game) => upcomingToday(game, now));
  const notes: string[] = [];
  if (upcoming.length && !today.some((pick) => pick.state === 'open')) {
    const label = category === 'prop' ? 'player prop' : 'spread';
    if (today.length) notes.push(`The next ${label} posts at the next update if a game still to tip clears the checks.`);
    else notes.push(category === 'prop' ? propNote(picks, upcoming, now) : spreadNote(upcoming, now));
  }
  return { status: 'open', category, record: file.record[category], today, yesterday, notes };
}

function gameDay(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** The NFL team bets of the day. The NFL plays a few days a week, so a day without games names the next game day. */
export function nflDailyPanelState(file: DailyFile | null, games: readonly FeedGame[], now: Date): DailyPanelState {
  const category: DailyCategory = 'nfl_spread';
  if (!file) return unavailable(category);
  const { today, yesterday } = categoryPicks(file, category, now);
  const notes: string[] = [];
  if (!today.some((pick) => pick.state === 'open')) {
    if (games.some((game) => nflUpcomingToday(game, now))) {
      notes.push(today.length
        ? 'The next NFL team bet posts at the next update if a game still to kick off has a current spread.'
        : 'No NFL team bet has been posted yet today. One posts at the next update once a game still to kick off has a current spread.');
    } else if (!today.length) {
      const date = chicagoDate(now);
      const next = games
        .filter((game) => game.status === 'scheduled' && chicagoDate(new Date(game.start_time)) > date)
        .sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
      notes.push(next ? `No NFL games left today. The next team bet posts on game day, ${gameDay(next.start_time)}.` : 'No NFL games left today.');
    }
  }
  return { status: 'open', category, record: file.record[category], today, yesterday, notes };
}
