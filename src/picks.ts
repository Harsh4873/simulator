import { bookKey, breakEven, fairOver, type BookLine } from './book-lines.ts';
import { americanBreakEven, profitPerStake, PROP_POLICY, valueAt, type PlayerSample, type PropMarket } from './props.ts';
import type { RateGame, SlateGame } from './types.ts';

/**
 * Leans: the simulation's side at a posted sportsbook over/under line, and how leans like it have settled.
 *
 * A model percentage is not a pick. On the archived pre-tip games the posted price predicted results better than the
 * simulations did, and over leans lost at every strength. So a lean is listed only while graded leans of its side and
 * strength have been beating the posted price, and that measured number is shown next to the model's own.
 */
export type LeanSide = 'over' | 'under';

/**
 * A gap this large is a reliability problem, not a lean: it usually means the price or the card is missing news.
 * Through November 13, 2026 the 29 graded under leans that claimed 25 points or more had won 34%. They are never
 * listed and are kept out of the pooling below, where they would hide inside the strongest listed bucket.
 */
export const EXTREME_CLAIM = PROP_POLICY.extremeEdge;
/** Claimed edge buckets in probability points: the model's chance of its side minus the price's break-even. */
export const LEAN_BUCKETS: readonly number[] = [0, 0.03, 0.06, 0.1, 0.15, 0.2, EXTREME_CLAIM];
/** Pulls a small bucket toward its side's overall result. */
export const TIER_PRIOR = 200;
/** A bucket has to hold this many graded leans, and beat the price by this much, before its leans are listed. */
export const MIN_TIER_LEANS = 200;
export const MIN_MEASURED_EDGE = 0.01;
/** Below this simulated play share the player's status is too uncertain to list. A sit-out voids the bet either way. */
export const MIN_PLAY_SHARE = 0.5;
export const LISTED_PER_SIDE = 10;

export interface Lean {
  event_id: string;
  athlete_id: string;
  name: string;
  matchup: string;
  tip: string;
  market: PropMarket;
  line: number;
  over_odds: number;
  under_odds: number;
  book: string;
  priced_at: string;
  side: LeanSide;
  /** Share of simulated games the player played in which the side won, pushes left out. */
  model: number;
  /** Break-even of the posted price on that side. */
  need: number;
  /** model - need. */
  claimed: number;
  projection: number;
  minutes: number;
  play: number;
}

export interface TierRecord {
  side: LeanSide;
  /** Lower bound of the claimed edge, or null for leans the price already beats on both sides. */
  lo: number | null;
  hi: number | null;
  n: number;
  wins: number;
  /** Average break-even of the prices in this bucket. */
  need: number;
  /** Profit in units at the posted prices, one unit a lean. */
  units: number;
  /** Measured edge after pooling so it never falls as the claim grows, then shrinking toward the side. */
  edge: number;
  /** Graded leans behind `edge`, counting the neighbours it was pooled with. */
  pooled: number;
}

export interface SideRecord {
  n: number;
  wins: number;
  need: number;
  units: number;
}

export interface PickRecord {
  settled: number;
  voids: number;
  from: string | null;
  through: string | null;
  live: SideTotals;
  replayed: SideTotals;
  tiers: TierRecord[];
  /** Line moves between the lean and the last posted price before the tip. Not a confirmed closing line. */
  moves: { tracked: number; toward: number; away: number; same_line: number; price_toward: number };
  days: { date: string; n: number; wins: number; units: number }[];
}

export interface SideTotals {
  over: SideRecord;
  under: SideRecord;
  from: string | null;
  through: string | null;
}

/** One posted line a simulation was first compared with, and what happened. `p` is the model chance of the over. */
export interface LedgerRow {
  e: string;
  a: string;
  m: PropMarket;
  name: string;
  team: string;
  tip: string;
  book: string;
  open: { at: string; priced_at: string; line: number; over: number; under: number; p: number; play: number; min: number };
  close?: { priced_at: string; line: number; over: number; under: number };
  result?: { actual: number; min: number } | { void: 'dnp' };
}

export interface LedgerFile {
  schema_version: 1;
  date: string;
  /** `replay` rows were rebuilt from archived pre-tip inputs with the current model. `live` rows were logged before the tip. */
  source: 'live' | 'replay';
  rows: LedgerRow[];
}

export interface PicksFile {
  schema_version: 1;
  /** The rate card these leans were simulated from. */
  generated_at: string | null;
  input_hash: string | null;
  model_hash: string | null;
  built_at: string;
  book: string | null;
  /** Latest posted lines for games on the slate: [athlete_id, market, line, over, under, priced_at], by event. */
  lines: Record<string, [string, PropMarket, number, number, number, string][]>;
  leans: Lean[];
  record: PickRecord;
}

/** Over share among the draws the player played, pushes excluded. Null when nothing is decided. */
export function overShare(sample: PlayerSample, market: PropMarket, line: number): { over: number; decided: number; played: number } | null {
  if ((market === 'stl' || market === 'blk' || market === 'tov') && !sample[market]) return null;
  if ((market === 'dd' || market === 'td') && (!sample.stl || !sample.blk)) return null;
  let wins = 0;
  let losses = 0;
  let played = 0;
  for (let index = 0; index < sample.min.length; index += 1) {
    if (!(sample.min[index] > 0)) continue;
    played += 1;
    const value = valueAt(sample, index, market);
    if (value > line) wins += 1;
    else if (value < line) losses += 1;
  }
  const decided = wins + losses;
  return decided === 0 ? null : { over: wins / decided, decided, played };
}

export function playedSummary(sample: PlayerSample, market: PropMarket): { projection: number; minutes: number; play: number } | null {
  let played = 0;
  let total = 0;
  let minutes = 0;
  for (let index = 0; index < sample.min.length; index += 1) {
    if (!(sample.min[index] > 0)) continue;
    played += 1;
    total += valueAt(sample, index, market);
    minutes += sample.min[index];
  }
  if (!played || !sample.min.length) return null;
  return { projection: total / played, minutes: minutes / played, play: played / sample.min.length };
}

/** The side whose model chance clears its own break-even by more, and by how much. */
export function leanSide(pOver: number, line: Pick<BookLine, 'over_odds' | 'under_odds'>): { side: LeanSide; model: number; need: number; claimed: number } {
  const overNeed = breakEven(line, 'over');
  const underNeed = breakEven(line, 'under');
  const overEdge = pOver - overNeed;
  const underEdge = 1 - pOver - underNeed;
  return overEdge >= underEdge
    ? { side: 'over', model: pOver, need: overNeed, claimed: overEdge }
    : { side: 'under', model: 1 - pOver, need: underNeed, claimed: underEdge };
}

function sideAbbr(side: SlateGame['away']): string {
  return side.abbreviation.trim() || side.name.trim() || 'Team';
}

/** Every posted line in one game that the simulation can be compared with. Ruled-out and placeholder players are skipped. */
export function gameLeans(
  game: SlateGame,
  rate: RateGame,
  draws: ReadonlyMap<string, PlayerSample>,
  lines: ReadonlyMap<string, BookLine>,
): Lean[] {
  const leans: Lean[] = [];
  const matchup = `${sideAbbr(game.away)} @ ${sideAbbr(game.home)}`;
  const players = new Map(rate.players.map((player) => [player.athlete_id, player]));
  for (const line of lines.values()) {
    if (line.event_id !== game.event_id) continue;
    const player = players.get(line.athlete_id);
    const sample = draws.get(line.athlete_id);
    if (!player || !sample || player.replacement_level || player.minutes_weight === 0) continue;
    const share = overShare(sample, line.market, line.line);
    const summary = playedSummary(sample, line.market);
    if (!share || !summary) continue;
    const lean = leanSide(share.over, line);
    leans.push({
      event_id: game.event_id,
      athlete_id: player.athlete_id,
      name: player.name,
      matchup,
      tip: game.start_time,
      market: line.market,
      line: line.line,
      over_odds: line.over_odds,
      under_odds: line.under_odds,
      book: line.book,
      priced_at: line.priced_at,
      side: lean.side,
      model: lean.model,
      need: lean.need,
      claimed: lean.claimed,
      projection: summary.projection,
      minutes: summary.minutes,
      play: summary.play,
    });
  }
  return leans;
}

export function bucketOf(claimed: number): number {
  let index = -1;
  for (let i = 0; i < LEAN_BUCKETS.length; i += 1) if (claimed >= LEAN_BUCKETS[i]) index = i;
  return index;
}

export interface GradedLean {
  date: string;
  side: LeanSide;
  claimed: number;
  need: number;
  odds: number;
  win: boolean;
  live: boolean;
}

/** A ledger row as a graded lean at the line and price it opened with. Null while unsettled, void or pushed. */
export function gradeRow(row: LedgerRow, date: string, live: boolean): GradedLean | null {
  if (!row.result || 'void' in row.result) return null;
  const actual = row.result.actual;
  if (!Number.isFinite(actual) || actual === row.open.line) return null;
  const lean = leanSide(row.open.p, { over_odds: row.open.over, under_odds: row.open.under });
  const odds = lean.side === 'over' ? row.open.over : row.open.under;
  return {
    date,
    side: lean.side,
    claimed: lean.claimed,
    need: lean.need,
    odds,
    win: lean.side === 'over' ? actual > row.open.line : actual < row.open.line,
    live,
  };
}

function emptySide(): SideRecord {
  return { n: 0, wins: 0, need: 0, units: 0 };
}

function addTo(total: SideRecord, lean: GradedLean): void {
  total.n += 1;
  total.wins += Number(lean.win);
  total.need += lean.need;
  total.units += lean.win ? profitPerStake(lean.odds) ?? 0 : -1;
}

const round = (value: number, places: number) => Number(value.toFixed(places));

function finish(total: SideRecord): SideRecord {
  return { n: total.n, wins: total.wins, need: round(total.n ? total.need / total.n : 0, 4), units: round(total.units, 2) };
}

/** Measured edge of a bucket: win rate minus the average break-even of its prices. */
function rawEdge(total: SideRecord): number {
  return total.n ? total.wins / total.n - total.need / total.n : 0;
}

/**
 * Pools neighbouring buckets until the measured edge never falls as the claimed edge grows, then shrinks each pool
 * toward its side. Six small buckets on two weeks of games are noisy, and a stronger claim scoring worse than a weaker
 * one is noise unless the pooled record says so.
 */
export function measuredEdges(buckets: readonly SideRecord[], side: SideRecord): { edge: number; pooled: number }[] {
  const blocks = buckets.map((bucket, index) => ({ from: index, to: index, n: bucket.n, sum: bucket.wins - bucket.need }));
  for (let i = 0; i < blocks.length - 1; ) {
    const here = blocks[i];
    const next = blocks[i + 1];
    const violates = here.n > 0 && next.n > 0 && here.sum / here.n > next.sum / next.n;
    if (violates || next.n === 0 || here.n === 0) {
      blocks[i] = { from: here.from, to: next.to, n: here.n + next.n, sum: here.sum + next.sum };
      blocks.splice(i + 1, 1);
      if (i > 0) i -= 1;
    } else i += 1;
  }
  const prior = rawEdge(side);
  const out = buckets.map(() => ({ edge: prior, pooled: 0 }));
  for (const block of blocks) {
    const edge = (block.sum + TIER_PRIOR * prior) / (block.n + TIER_PRIOR);
    for (let index = block.from; index <= block.to; index += 1) out[index] = { edge, pooled: block.n };
  }
  return out;
}

function sideTotals(leans: readonly GradedLean[]): SideTotals {
  const over = emptySide();
  const under = emptySide();
  let from: string | null = null;
  let through: string | null = null;
  for (const lean of leans) {
    addTo(lean.side === 'over' ? over : under, lean);
    if (from === null || lean.date < from) from = lean.date;
    if (through === null || lean.date > through) through = lean.date;
  }
  return { over: finish(over), under: finish(under), from, through };
}

export function buildRecord(files: readonly LedgerFile[]): PickRecord {
  const graded: GradedLean[] = [];
  let voids = 0;
  const moves = { tracked: 0, toward: 0, away: 0, same_line: 0, price_toward: 0 };
  for (const file of files) {
    for (const row of file.rows) {
      if (row.result && 'void' in row.result) voids += 1;
      const lean = gradeRow(row, file.date, file.source === 'live');
      if (lean) graded.push(lean);
      if (row.close && Date.parse(row.close.priced_at) > Date.parse(row.open.priced_at)) {
        const side = leanSide(row.open.p, { over_odds: row.open.over, under_odds: row.open.under }).side;
        moves.tracked += 1;
        if (row.close.line !== row.open.line) {
          // A line that moves up after an over lean has moved toward it: the same over is now harder to get.
          if ((row.close.line > row.open.line) === (side === 'over')) moves.toward += 1;
          else moves.away += 1;
        } else {
          const before = fairOver({ over_odds: row.open.over, under_odds: row.open.under });
          const after = fairOver({ over_odds: row.close.over, under_odds: row.close.under });
          if (before !== null && after !== null) {
            moves.same_line += 1;
            moves.price_toward += side === 'over' ? after - before : before - after;
          }
        }
      }
    }
  }
  const tiers: TierRecord[] = [];
  for (const side of ['under', 'over'] as const) {
    const mine = graded.filter((lean) => lean.side === side);
    const buckets = LEAN_BUCKETS.map(() => emptySide());
    const below = emptySide();
    // The last bucket holds the gaps too large to trust. It is graded but neither pooled nor part of the side's prior.
    const trusted = emptySide();
    const last = buckets.length - 1;
    for (const lean of mine) {
      const index = bucketOf(lean.claimed);
      if (index < 0) addTo(below, lean);
      else {
        addTo(buckets[index], lean);
        if (index < last) addTo(trusted, lean);
      }
    }
    const extreme = buckets[last];
    const measured = [...measuredEdges(buckets.slice(0, -1), trusted), { edge: (extreme.wins - extreme.need) / (extreme.n + TIER_PRIOR), pooled: extreme.n }];
    if (below.n) {
      tiers.push({ side, lo: null, hi: 0, ...finish(below), edge: round((below.wins - below.need + TIER_PRIOR * rawEdge(trusted)) / (below.n + TIER_PRIOR), 4), pooled: below.n });
    }
    LEAN_BUCKETS.forEach((lo, index) => {
      tiers.push({ side, lo, hi: LEAN_BUCKETS[index + 1] ?? null, ...finish(buckets[index]), edge: round(measured[index].edge, 4), pooled: measured[index].pooled });
    });
  }
  const byDate = new Map<string, SideRecord>();
  for (const lean of graded) {
    if (bucketOf(lean.claimed) < 0) continue;
    const day = byDate.get(lean.date) ?? emptySide();
    addTo(day, lean);
    byDate.set(lean.date, day);
  }
  const dates = graded.map((lean) => lean.date).sort();
  return {
    settled: graded.length,
    voids,
    from: dates[0] ?? null,
    through: dates[dates.length - 1] ?? null,
    live: sideTotals(graded.filter((lean) => lean.live)),
    replayed: sideTotals(graded.filter((lean) => !lean.live)),
    tiers,
    moves: { ...moves, price_toward: round(moves.price_toward, 4) },
    days: [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-21)
      .map(([date, day]) => ({ date, n: day.n, wins: day.wins, units: round(day.units, 2) })),
  };
}

export function tierFor(record: PickRecord | null | undefined, side: LeanSide, claimed: number): TierRecord | null {
  if (!record) return null;
  const index = bucketOf(claimed);
  const lo = index < 0 ? null : LEAN_BUCKETS[index];
  return record.tiers.find((tier) => tier.side === side && tier.lo === lo) ?? null;
}

/** A lean is listed only while graded leans of its side and strength have been beating the posted price. */
export function listed(lean: Lean, record: PickRecord | null | undefined): boolean {
  const tier = tierFor(record, lean.side, lean.claimed);
  return Boolean(tier && lean.claimed >= 0 && lean.claimed < EXTREME_CLAIM && lean.play >= MIN_PLAY_SHARE && tier.pooled >= MIN_TIER_LEANS && tier.edge >= MIN_MEASURED_EDGE);
}

/** A player's strongest lean on a side, with how many more of his stats lean the same way. */
export interface RankedLean extends Lean {
  also: number;
}

export interface LeanBoard {
  listed: { over: RankedLean[]; under: RankedLean[] };
  /** Strongest claims on each side that are not listed, so a viewer can see what the model leans on and how that has gone. */
  unlisted: { over: RankedLean[]; under: RankedLean[] };
  /** Listed leans on each side, and the players they belong to. */
  counts: { over: number; under: number };
  players: { over: number; under: number };
}

/** One row a player: his points, rebounds and combined lines move together, so four of them are one opinion. */
function strongestEach(sorted: readonly Lean[]): RankedLean[] {
  const rows = new Map<string, RankedLean>();
  for (const lean of sorted) {
    const key = `${lean.event_id}:${lean.athlete_id}`;
    const first = rows.get(key);
    if (first) first.also += 1;
    else rows.set(key, { ...lean, also: 0 });
  }
  return [...rows.values()];
}

export function rankLeans(leans: readonly Lean[], record: PickRecord | null | undefined, limit = LISTED_PER_SIDE): LeanBoard {
  const board: LeanBoard = { listed: { over: [], under: [] }, unlisted: { over: [], under: [] }, counts: { over: 0, under: 0 }, players: { over: 0, under: 0 } };
  const measured = (lean: Lean) => tierFor(record, lean.side, lean.claimed)?.edge ?? -1;
  const order = (a: Lean, b: Lean) => measured(b) - measured(a) || b.claimed - a.claimed || a.name.localeCompare(b.name) || a.market.localeCompare(b.market);
  for (const side of ['over', 'under'] as const) {
    const mine = leans.filter((lean) => lean.side === side && lean.claimed >= LEAN_BUCKETS[1] && lean.play >= MIN_PLAY_SHARE);
    const shown = mine.filter((lean) => listed(lean, record)).sort(order);
    const each = strongestEach(shown);
    board.counts[side] = shown.length;
    board.players[side] = each.length;
    board.listed[side] = each.slice(0, limit);
    board.unlisted[side] = strongestEach(
      mine.filter((lean) => !listed(lean, record)).sort((a, b) => b.claimed - a.claimed || a.name.localeCompare(b.name) || a.market.localeCompare(b.market)),
    ).slice(0, limit);
  }
  return board;
}

export function linesByKey(file: Pick<PicksFile, 'lines' | 'book'> | null | undefined): Map<string, BookLine> {
  const map = new Map<string, BookLine>();
  if (!file) return map;
  for (const [eventId, rows] of Object.entries(file.lines)) {
    for (const [athleteId, market, line, over, under, pricedAt] of rows) {
      const entry: BookLine = { event_id: eventId, athlete_id: athleteId, market, line, over_odds: over, under_odds: under, priced_at: pricedAt, book: file.book ?? 'sportsbook' };
      map.set(bookKey(entry), entry);
    }
  }
  return map;
}

const MARKETS = new Set<string>(['pts', 'reb', 'ast', 'pra', 'tpm', 'stl', 'blk', 'pa', 'pr', 'ra']);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const odds = (value: unknown): value is number => finite(value) && americanBreakEven(value) !== null;
const stamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Published picks are optional. Anything malformed is dropped whole so the page falls back to its own simulations. */
export function parsePicksFile(text: string): PicksFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const file = value as Partial<PicksFile> | null;
  if (!file || file.schema_version !== 1 || typeof file.lines !== 'object' || file.lines === null || !Array.isArray(file.leans) || !file.record || !Array.isArray(file.record.tiers)) return null;
  for (const rows of Object.values(file.lines)) {
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 6 || typeof row[0] !== 'string' || !MARKETS.has(String(row[1])) || !finite(row[2]) || row[2] < 0 || !odds(row[3]) || !odds(row[4]) || !stamp(row[5])) return null;
    }
  }
  for (const lean of file.leans) {
    if (!lean || typeof lean.event_id !== 'string' || typeof lean.athlete_id !== 'string' || typeof lean.name !== 'string' || !MARKETS.has(lean.market)) return null;
    if ((lean.side !== 'over' && lean.side !== 'under') || !odds(lean.over_odds) || !odds(lean.under_odds) || !stamp(lean.tip) || !stamp(lean.priced_at)) return null;
    for (const key of ['line', 'model', 'need', 'claimed', 'projection', 'minutes', 'play'] as const) if (!finite(lean[key])) return null;
  }
  for (const tier of file.record.tiers) {
    if (!tier || (tier.side !== 'over' && tier.side !== 'under') || !finite(tier.n) || !finite(tier.wins) || !finite(tier.need) || !finite(tier.units) || !finite(tier.edge) || !finite(tier.pooled)) return null;
  }
  return file as PicksFile;
}
