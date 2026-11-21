import { historyBarsSvg, propBarsSvg, sparkBarsSvg, type HistoryBarPoint } from './charts.ts';
import { chicagoDate, formatTip } from './date.ts';
import { playerHeadshotUrl, teamLogoUrl } from './display.ts';
import { percent, propFormMarkup, renderPropResults, type PropFormState } from './boxscore.ts';
import { summarizeOverrides, type LineupOverrides } from './lineup-overrides.ts';
import {
  DEFENSE_SLOTS,
  NBA_TEAMS,
  computeHitWindows,
  computePerMinuteSummary,
  computeStreak,
  computeSupportingStats,
  gradeHistoricalSeries,
  historicalStatValue,
  marketToDefenseKey,
  medianOf,
  positionToDefenseSlot,
  unpackOnOff,
  unpackPlayerGames,
  unpackRankedPair,
  unpackTeamAllowed,
  type DefenseSlot,
  type PlayerGameRow,
  type PlayerOnOffSummary,
  type ProjectionContext,
  type RankedStat,
  type TeammateSplit,
} from './projection-context.ts';
import { bookKey, type BookLine } from './book-lines.ts';
import { EXTREME_CLAIM, rankLeans, type Lean, type PickRecord, type RankedLean, type TierRecord } from './picks.ts';
import { quoteCalibrationFor, type PropCalibrationArtifact, type PropCalibrationGroup, type PropPanelCalibration } from './prop-calibration.ts';
import { americanBreakEven, gradeProp, noVigFromBreakEven, parseBookPrice, quoteProp, valueAt, type PlayerSample, type PropMarket } from './props.ts';
import type { Simulation } from './simulate.ts';
import { avatarMarkup, escapeHtml, placeLine, playerSideLine, statusLabel, viewToggles } from './slate.ts';
import type { RateCard, RateGame, RatePlayer, Slate, SlateGame, TeamSide } from './types.ts';

const MARKETS: { value: PropMarket; label: string; short: string }[] = [
  { value: 'pts', label: 'Points', short: 'PTS' },
  { value: 'reb', label: 'Rebounds', short: 'REB' },
  { value: 'ast', label: 'Assists', short: 'AST' },
  { value: 'pra', label: 'Points + rebounds + assists', short: 'PRA' },
  { value: 'pa', label: 'Points + assists', short: 'PA' },
  { value: 'pr', label: 'Points + rebounds', short: 'PR' },
  { value: 'ra', label: 'Rebounds + assists', short: 'RA' },
  { value: 'tpm', label: 'Threes', short: '3PM' },
  { value: 'stl', label: 'Steals', short: 'STL' },
  { value: 'blk', label: 'Blocks', short: 'BLK' },
  { value: 'tov', label: 'Turnovers', short: 'TOV' },
  { value: 'dd', label: 'Double-double', short: 'DD' },
  { value: 'td', label: 'Triple-double', short: 'TD' },
];

export type HistorySplit = 'all' | 'home' | 'away';
/** The board shows every game still to play, or one game. */
export type BoardScope = 'all' | 'game';
export type BoardSort = 'projection' | 'over' | 'under' | 'matchup';
/** Players is the card board. Defense ranks tonight's defenses by position. */
export type ProjectionMode = 'players' | 'defense';
/** Keeps the cards whose opponent is soft (ranked 21st to 30th in what it allows) or tough (1st to 10th) at the player's position. */
export type DvpFilter = 'all' | 'soft' | 'tough';
/** One defense and position picked from the Defense view. */
export interface DvpFocus {
  team: string;
  slot: DefenseSlot;
}
export type SupportMode = 'avg' | 'med';

export interface ProjectionView {
  slate: Slate;
  card: RateCard;
  now: Date;
  query: string;
  eventId: string | null;
  athleteId: string | null;
  form: PropFormState;
  simulation: Simulation | null;
  /** True only while a draw for this game is in flight. A cached result is not a draw. */
  drawing: boolean;
  /** 0..1 progress while `drawing` is true. */
  drawProgress?: number;
  /** Event ids already cached in memory / IndexedDB so the Games rail can badge them. */
  readyEventIds?: ReadonlySet<string>;
  overrides: LineupOverrides;
  historySplit?: HistorySplit;
  boardSort?: BoardSort;
  selectedGameIndex?: number | null;
  supportMode?: SupportMode;
  selectedTeammateId?: string | null;
  defenseSlot?: DefenseSlot | null;
  /** Posted sportsbook over/under lines for the slate, keyed by event, athlete and market. */
  lines?: ReadonlyMap<string, BookLine>;
  /** Leans for games that have not started: published with the card, or recomputed here after a lineup call. */
  leans?: readonly Lean[];
  /** Games with posted lines whose simulations are not ready yet. */
  leansWaiting?: number;
  record?: PickRecord | null;
  book?: string | null;
  propCalibration?: PropPanelCalibration | null;
  /** Every game or the selected one. Defaults to the game when one is selected. */
  scope?: BoardScope;
  /** Simulations already in this browser, by event, for the every-game board. */
  simulations?: ReadonlyMap<string, Simulation>;
  /** How many cards the every-game board shows before its Show all button. Unset shows them all. */
  boardLimit?: number | null;
  mode?: ProjectionMode;
  dvpFilter?: DvpFilter;
  dvpFocus?: DvpFocus | null;
  /** The position column the Defense view is ordered by. */
  dvpSort?: DefenseSlot;
}

export const PROJECTION_MODES: readonly { value: ProjectionMode; label: string }[] = [
  { value: 'players', label: 'Players' },
  { value: 'defense', label: 'Defense' },
];

export function isProjectionMode(value: string): value is ProjectionMode {
  return PROJECTION_MODES.some((mode) => mode.value === value);
}

export function isDvpFilter(value: string): value is DvpFilter {
  return value === 'all' || value === 'soft' || value === 'tough';
}

export function isPropMarket(value: string): value is PropMarket {
  return MARKETS.some((market) => market.value === value);
}

export function isHistorySplit(value: string): value is HistorySplit {
  return value === 'all' || value === 'home' || value === 'away';
}

export function isBoardSort(value: string): value is BoardSort {
  return value === 'projection' || value === 'over' || value === 'under' || value === 'matchup';
}

export function isDefenseSlot(value: string): value is DefenseSlot {
  return (DEFENSE_SLOTS as readonly string[]).includes(value);
}

export function validPropLine(raw: string): number | null {
  if (raw.trim() === '') return null;
  const line = Number(raw);
  if (!Number.isFinite(line) || line < 0 || !Number.isInteger(line * 2)) return null;
  return line;
}

const playedMemo = new WeakMap<PlayerSample, Map<PropMarket, number[]>>();

export function playedValues(sample: PlayerSample, market: PropMarket): number[] {
  const memo = playedMemo.get(sample);
  const hit = memo?.get(market);
  if (hit) return hit;
  const values = computePlayedValues(sample, market);
  if (memo) memo.set(market, values);
  else playedMemo.set(sample, new Map([[market, values]]));
  return values;
}

function computePlayedValues(sample: PlayerSample, market: PropMarket): number[] {
  const values: number[] = [];
  for (let index = 0; index < sample.min.length; index += 1) {
    if (!(sample.min[index] > 0)) continue;
    const value = valueAt(sample, index, market);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

export function playedMean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Milestones settle at 0.5 only. Every other whole or half-point line can be graded. */
export function gradedPropLine(market: PropMarket, line: number | null): number | null {
  if (line === null || !Number.isFinite(line)) return null;
  if (market === 'dd' || market === 'td') return line === 0.5 ? line : null;
  return line;
}

/** Nearest nonnegative half point to the median of the values. */
export function nearestHalfPoint(values: ArrayLike<number>): number {
  const nums: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) nums.push(value);
  }
  if (!nums.length) return 0;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return Math.max(0, Math.round(median * 2) / 2);
}

/** The viewer's line. Double-double and triple-double stay locked at 0.5. */
export function viewerLine(market: PropMarket, values: ArrayLike<number>): number {
  if (market === 'dd' || market === 'td') return 0.5;
  return nearestHalfPoint(values);
}

export function l10HistoricalValues(
  context: ProjectionContext | undefined,
  athleteId: string | null,
  market: PropMarket,
): number[] {
  if (!context || !athleteId) return [];
  const rows = unpackPlayerGames(context.players[athleteId]?.games);
  return rows
    .map((row) => historicalStatValue(row, market))
    .filter((val): val is number => val !== null && Number.isFinite(val))
    .slice(-10);
}

/**
 * The half point nearest the average of the values. A line set just under a player's own simulated median makes the
 * over at least 50% by construction, which is an artifact and not a lean, so no default line is placed that way.
 */
export function nearestHook(market: PropMarket, values: ArrayLike<number>): number {
  if (market === 'dd' || market === 'td') return 0.5;
  let total = 0;
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  if (!count) return 0.5;
  return Math.max(0.5, Math.floor(total / count) + 0.5);
}

/** The line a player opens with: the posted line when there is one, otherwise the half point nearest his projection. */
export function defaultMarketLine(
  market: PropMarket,
  sample: PlayerSample | null,
  context: ProjectionContext | undefined,
  athleteId: string | null,
  book: BookLine | null = null,
): number | null {
  if (market === 'dd' || market === 'td') return 0.5;
  if (book) return book.line;
  if (sample && !statMissing(sample, market)) {
    const values = playedValues(sample, market);
    if (values.length) return nearestHook(market, values);
  }
  const recent = l10HistoricalValues(context, athleteId, market);
  if (recent.length) return nearestHook(market, recent);
  return null;
}

export function bookLineFor(
  lines: ReadonlyMap<string, BookLine> | undefined,
  eventId: string | null,
  athleteId: string | null,
  market: PropMarket,
): BookLine | null {
  if (!lines || !eventId || !athleteId) return null;
  return lines.get(bookKey({ event_id: eventId, athlete_id: athleteId, market })) ?? null;
}

function marketLabel(market: PropMarket): string {
  return MARKETS.find((item) => item.value === market)?.label ?? market;
}

function marketShort(market: PropMarket): string {
  return MARKETS.find((item) => item.value === market)?.short ?? market.toUpperCase();
}

function statMissing(sample: PlayerSample, market: PropMarket): boolean {
  if (market === 'stl' || market === 'blk' || market === 'tov') return !sample[market];
  if (market === 'dd' || market === 'td') return !sample.stl || !sample.blk;
  return false;
}

function chancePair(
  sample: PlayerSample,
  market: PropMarket,
  line: number,
): { over: number | null; under: number | null; pushes: number; sitOuts: number } | null {
  if ((market === 'dd' || market === 'td') && line !== 0.5) return null;
  if (statMissing(sample, market)) return null;
  try {
    const over = gradeProp(sample, market, 'over', line);
    const under = gradeProp(sample, market, 'under', line);
    const overDecided = over.wins + over.losses;
    const underDecided = under.wins + under.losses;
    return {
      over: overDecided === 0 ? null : over.wins / overDecided,
      under: underDecided === 0 ? null : under.wins / underDecided,
      pushes: over.pushes,
      sitOuts: over.voids,
    };
  } catch {
    return null;
  }
}

export function modelChanceHtml(sample: PlayerSample | null, market: PropMarket, lineRaw: string): string {
  if (!sample) return '<p class="prop-note">The model chance appears after this game is simulated.</p>';
  if (statMissing(sample, market)) return '<p class="prop-note">This stat is missing from the older card.</p>';
  const entered = validPropLine(lineRaw);
  if (entered === null || ((market === 'dd' || market === 'td') && entered !== 0.5)) {
    return '<p class="prop-note">Enter a whole or half-point line to see the over and under model chances.</p>';
  }
  const pair = chancePair(sample, market, entered);
  if (!pair) return '<p class="prop-note">Enter a whole or half-point line to see the over and under model chances.</p>';
  const over = pair.over === null ? '—' : percent(pair.over);
  const under = pair.under === null ? '—' : percent(pair.under);
  return `<dl class="line line-pair projection-chances">
      <div class="stat-tile"><dt>Over</dt><dd>${over}</dd><span class="stat-name">Model chance</span></div>
      <div class="stat-tile"><dt>Under</dt><dd>${under}</dd><span class="stat-name">Model chance</span></div>
    </dl>
    <p class="prop-note">${pair.pushes} pushes. ${pair.sitOuts} sit-outs. Sit-outs stay out of the chance.</p>`;
}

function signedEdge(edge: number): string {
  const points = edge * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)} pp`;
}

function edgeText(sample: PlayerSample, market: PropMarket, form: PropFormState, line: number, calibration?: PropPanelCalibration | null): string {
  const price = parseBookPrice(form.odds, form.style);
  if (!price) return '';
  // The prop analyzer withholds the whole quote when the opposite price is filled in but illegal.
  // An empty opposite still has an edge. A valid opposite still has an edge.
  const opposite = form.opposite.trim() === '' ? null : parseBookPrice(form.opposite, form.style);
  if (form.opposite.trim() !== '' && !opposite) return '';
  const quote = quoteProp(sample, market, form.side, line, price, opposite, quoteCalibrationFor(calibration, market, form.side));
  if (!quote || quote.edge === null || quote.breakEven === null || quote.expectedReturn === null) return '';
  return signedEdge(quote.edge);
}

function hitToneClass(rate: number | null): string {
  if (rate === null) return 'tone-muted';
  if (rate >= 0.6) return 'tone-good';
  if (rate >= 0.45) return 'tone-mid';
  return 'tone-low';
}

interface BoardRow {
  athleteId: string;
  eventId: string;
  name: string;
  teamId: string;
  position: string;
  headshot: string | null;
  minutes: number;
  projection: number | null;
  line: number | null;
  /** Set when the row is graded at the posted line, so its price can be shown beside the model chance. */
  book: BookLine | null;
  over: string;
  under: string;
  overRate: number | null;
  underRate: number | null;
  edge: string;
  note: string | null;
  games: PlayerGameRow[];
  /** His simulated values for the stat in the games he plays, for the card's small chart. */
  values: readonly number[];
  opponentId: string;
  /** His position group, the split the defense numbers come in. */
  slot: DefenseSlot;
  /** What his opponent allows a game at his position for the stat, and its rank of 30 (30th allows the most). */
  dvp: RankedStat | null;
  /** At a posted line: the chance anchored on the price, with the simulation and the price alone. */
  anchor?: AnchoredChance | null;
}

function byRate(key: 'overRate' | 'underRate') {
  return (a: BoardRow, b: BoardRow) => {
    const left = a[key];
    const right = b[key];
    if (left === null && right === null) return a.name.localeCompare(b.name);
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || a.name.localeCompare(b.name);
  };
}

function byProjection(a: BoardRow, b: BoardRow): number {
  if (a.projection === null && b.projection === null) return b.minutes - a.minutes || a.name.localeCompare(b.name);
  if (a.projection === null) return 1;
  if (b.projection === null) return -1;
  return b.projection - a.projection || a.name.localeCompare(b.name);
}

function byMatchup(a: BoardRow, b: BoardRow): number {
  if (a.dvp === null && b.dvp === null) return byProjection(a, b);
  if (a.dvp === null) return 1;
  if (b.dvp === null) return -1;
  return b.dvp[1] - a.dvp[1] || byProjection(a, b);
}

function sortRows(rows: BoardRow[], sort: BoardSort, simulated: boolean): BoardRow[] {
  if (sort === 'matchup') return rows.sort(byMatchup);
  if (sort === 'over' && simulated) return rows.sort(byRate('overRate'));
  if (sort === 'under' && simulated) return rows.sort(byRate('underRate'));
  if (!simulated) return rows.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
  return rows.sort(byProjection);
}

export function americanText(odds: number): string {
  return odds > 0 ? `+${odds}` : String(odds);
}

function lineText(line: number): string {
  return Number.isInteger(line) ? line.toFixed(1) : String(line);
}

/**
 * How much of the simulation's disagreement with the price shows up in results: the prop calibration's fitted weight
 * where a stat has a map, and otherwise the share measured on every graded line (about a fifth, 3,370 live lines from
 * 2026-11-15 to 2026-11-20). The rest of the chance is the price with its vig taken out.
 */
export const MARKET_ANCHOR_WEIGHT = 0.2;

export interface AnchoredChance {
  /** The chance shown: the simulation, mapped where a map exists, weighed against the no-vig price. */
  over: number;
  /** The simulation alone, and the price alone with its vig taken out. */
  raw: number;
  market: number;
  /** Chance minus break-even on the better side; at or below zero there is no edge after the vig. */
  side: 'over' | 'under';
  edge: number;
}

/** The over chance at a posted line, anchored on its price, and the side, if any, that still clears its break-even. */
export function anchoredChance(rawOver: number, book: Pick<BookLine, 'over_odds' | 'under_odds'>, market: PropMarket, calibration: PropPanelCalibration | null | undefined): AnchoredChance | null {
  const overNeed = americanBreakEven(book.over_odds);
  const underNeed = americanBreakEven(book.under_odds);
  if (overNeed === null || underNeed === null || !(rawOver > 0 && rawOver < 1)) return null;
  const noVig = noVigFromBreakEven(overNeed, underNeed);
  if (noVig === null) return null;
  const map = quoteCalibrationFor(calibration, market, 'over');
  const mapped = map ? map.apply(rawOver) : rawOver;
  const weight = map ? map.w : MARKET_ANCHOR_WEIGHT;
  const over = weight * mapped + (1 - weight) * noVig;
  const overEdge = over - overNeed;
  const underEdge = 1 - over - underNeed;
  return overEdge >= underEdge ? { over, raw: rawOver, market: noVig, side: 'over', edge: overEdge } : { over, raw: rawOver, market: noVig, side: 'under', edge: underEdge };
}

function boardRows(
  game: RateGame,
  simulation: Simulation | null,
  form: PropFormState,
  athleteId: string | null,
  context: ProjectionContext | undefined,
  sort: BoardSort,
  lines: ReadonlyMap<string, BookLine> | undefined,
  calibration?: PropPanelCalibration | null,
): BoardRow[] {
  const viewerGraded = validPropLine(form.line);
  const validViewer = viewerGraded !== null && !((form.market === 'dd' || form.market === 'td') && viewerGraded !== 0.5) ? viewerGraded : null;
  const rows = game.players.map((player) => {
    const sample = simulation?.playerDraws.get(player.athlete_id) ?? null;
    const missing = sample ? statMissing(sample, form.market) : false;
    const values = sample && !missing ? playedValues(sample, form.market) : [];
    const projection = values.length ? playedMean(values) : null;
    let note: string | null = null;
    if (simulation && missing) note = 'This stat is missing from the older card.';
    else if (simulation && projection === null) note = 'does not play in the simulations.';
    const posted = bookLineFor(lines, game.event_id, player.athlete_id, form.market);
    const selected = player.athlete_id === athleteId;
    // The selected player is graded at the line in the form. Everyone else is graded at the posted line or not at all:
    // a line placed from a player's own simulated median says nothing about which side to take.
    const milestone = form.market === 'dd' || form.market === 'td' ? 0.5 : null;
    const rowLine = selected && validViewer !== null ? validViewer : posted?.line ?? milestone;
    const book = posted && rowLine === posted.line ? posted : null;
    let over = '';
    let under = '';
    let overRate: number | null = null;
    let underRate: number | null = null;
    let edge = '';
    let anchor: AnchoredChance | null = null;
    if (sample && rowLine !== null && !missing && projection !== null) {
      const pair = chancePair(sample, form.market, rowLine);
      overRate = pair?.over ?? null;
      underRate = pair?.under ?? null;
      // At a posted line the chance is anchored on its price: on graded lines the simulation alone has been right
      // about a fifth of the way when it disagreed with the market, so its raw chance overstates every lean.
      anchor = book && overRate !== null ? anchoredChance(overRate, book, form.market, calibration) : null;
      if (anchor) {
        overRate = anchor.over;
        underRate = 1 - anchor.over;
      }
      over = overRate === null ? '' : percent(overRate);
      under = underRate === null ? '' : percent(underRate);
      if (selected && form.odds.trim() !== '') edge = edgeText(sample, form.market, form, rowLine, calibration);
      else if (anchor && anchor.edge > 0) edge = `${anchor.side === 'over' ? 'Over' : 'Under'} ${signedEdge(anchor.edge)}`;
    }
    const games = context ? unpackPlayerGames(context.players[player.athlete_id]?.games) : [];
    const opponentId = player.team_id === game.home_team_id ? game.away_team_id : game.home_team_id;
    const slot = positionToDefenseSlot(player.position_group);
    const defense = context?.teams[opponentId];
    return {
      opponentId,
      slot,
      dvp: defense?.allowed?.[marketToDefenseKey(form.market)] ? unpackTeamAllowed(defense, marketToDefenseKey(form.market), slot) : null,
      athleteId: player.athlete_id,
      eventId: game.event_id,
      name: player.name,
      teamId: player.team_id,
      position: player.position.trim(),
      headshot: player.headshot_url ?? null,
      minutes: player.minutes_mean,
      projection,
      line: projection === null && simulation ? null : rowLine,
      book,
      over,
      under,
      overRate,
      underRate,
      edge,
      note,
      games,
      values,
      anchor,
    };
  });
  return sortRows(rows, sort, Boolean(simulation));
}

/** Hit rate at the card's line over the last `take` box scores, or over all of them. */
function hitChip(label: string, rows: readonly PlayerGameRow[], form: PropFormState, line: number | null, take?: number): string {
  if (line === null || !rows.length) return '';
  const valid = rows.filter((r) => historicalStatValue(r, form.market) !== null);
  const sample = take === undefined ? valid : valid.slice(-take);
  const grade = gradeHistoricalSeries(sample, form.market, form.side, line);
  if (grade.decided === 0) return '';
  return `<span class="hit-chip ${hitToneClass(grade.rate)}" title="${escapeHtml(`${form.side === 'under' ? 'Under' : 'Over'} ${line}: ${grade.wins} of ${grade.decided}`)}"><small>${escapeHtml(label)}</small><strong>${grade.wins}/${grade.decided}</strong></span>`;
}

interface CardSides {
  team: TeamSide | null;
  opponent: TeamSide | null;
  home: boolean;
  tip: string | null;
}

function cardSides(slate: Slate | null, eventId: string, teamId: string): CardSides {
  const game = slate?.games.find((item) => item.event_id === eventId) ?? null;
  if (!game) return { team: null, opponent: null, home: false, tip: null };
  const home = game.home.team_id === teamId;
  return { team: home ? game.home : game.away, opponent: home ? game.away : game.home, home, tip: game.start_time };
}

function clockText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(date);
}

function logoImg(side: TeamSide | null): string {
  if (!side) return '';
  const url = teamLogoUrl(side);
  const abbr = escapeHtml(sideAbbr(side));
  return `<span class="logo pick-logo">${url ? `<img referrerpolicy="no-referrer" loading="lazy" alt="" src="${escapeHtml(url)}" width="22" height="22">` : ''}<span class="mono"${url ? ' hidden' : ''}>${abbr}</span></span>`;
}

const SLOT_WORD: Record<DefenseSlot, string> = { all: 'all players', G: 'guards', F: 'forwards', C: 'centers' };
const SLOT_NAME: Record<DefenseSlot, string> = { all: 'All', G: 'Guards', F: 'Forwards', C: 'Centers' };
const TONE_WORD = { fav: 'Soft', mid: 'Mid', tough: 'Tough' } as const;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const unit = n % 10;
  return `${n}${unit === 1 ? 'st' : unit === 2 ? 'nd' : unit === 3 ? 'rd' : 'th'}`;
}

function defenseStatLabel(market: PropMarket): string {
  return marketLabel(market === 'dd' || market === 'td' ? 'pra' : market).toLowerCase();
}

/** The opponent's defense at his position for the stat: soft, mid or tough, and its rank of 30. */
function dvpChip(row: BoardRow, form: PropFormState, opponent: TeamSide | null): string {
  if (!row.dvp) return '';
  const [value, rank] = row.dvp;
  const tone = rankTone(rank, true);
  const who = opponent ? sideAbbr(opponent) : 'His opponent';
  const title = `${who} allows ${value.toFixed(1)} ${defenseStatLabel(form.market)} a game to ${SLOT_WORD[row.slot]}: ${ordinal(rank)} of 30, where 30th allows the most.`;
  return `<span class="dvp-chip" data-tone="${tone}" title="${escapeHtml(title)}"><small>${TONE_WORD[tone]} D</small><strong>${ordinal(rank)}</strong></span>`;
}

/** Whether a card passes the defense filter and the defense picked in the Defense view. */
function passesDefense(row: BoardRow, filter: DvpFilter, focus: DvpFocus | null): boolean {
  if (focus && (row.opponentId !== focus.team || (focus.slot !== 'all' && row.slot !== focus.slot))) return false;
  if (filter === 'all') return true;
  if (!row.dvp) return false;
  const tone = rankTone(row.dvp[1], true);
  return filter === 'soft' ? tone === 'fav' : tone === 'tough';
}

/** One player on the board: who, the projection and line, his simulated spread against it, and the chances. */
function pickCardHtml(row: BoardRow, form: PropFormState, selected: boolean, sides: CardSides, hasHistory: boolean, showMatchup: boolean): string {
  const id = escapeHtml(row.athleteId);
  const matchup = sides.team && sides.opponent ? `${sideAbbr(sides.team)} ${sides.home ? 'vs' : '@'} ${sideAbbr(sides.opponent)}` : '';
  const sub = [row.position, showMatchup ? matchup : '', showMatchup && sides.tip ? clockText(sides.tip) : ''].filter(Boolean).join(' · ');
  const projection = row.note
    ? `<span class="pick-value pick-muted">—</span>`
    : row.projection === null
      ? '<span class="pick-value pick-muted">…</span>'
      : `<span class="pick-value">${row.projection.toFixed(1)}</span>`;
  const lineValue =
    row.line === null
      ? '<span class="pick-value pick-muted">—</span>'
      : row.book
        ? `<span class="pick-value"><span class="line-posted" title="${escapeHtml(`${row.book.book}, priced ${formatTip(row.book.priced_at)}`)}">${escapeHtml(lineText(row.line))}</span></span>`
        : `<span class="pick-value">${escapeHtml(lineText(row.line))}</span>`;
  const lineLabel = row.book ? escapeHtml(row.book.book) : selected && row.line !== null ? 'Your line' : row.line !== null ? 'Line' : 'No line';
  const price = (odds: number | undefined) => (odds === undefined ? '' : ` <small class="line-price">${escapeHtml(americanText(odds))}</small>`);
  // At a posted line a side lights only when its anchored chance still clears the price; elsewhere the likelier side does.
  const leanTo = row.anchor
    ? row.anchor.edge > 0
      ? row.anchor.side
      : ''
    : row.overRate !== null && row.underRate !== null
      ? row.overRate > row.underRate
        ? 'over'
        : row.underRate > row.overRate
          ? 'under'
          : ''
      : '';
  const chances =
    row.over || row.under
      ? `<span class="pick-odds">
          <span class="pick-side" data-side="over"${leanTo === 'over' ? ' data-lead' : ''}><span class="pick-side-name">Over</span><span class="pick-pct">${row.over || '—'}</span>${row.over ? price(row.book?.over_odds) : ''}</span>
          <span class="pick-meter" aria-hidden="true"><span class="pick-meter-fill" style="width:${((row.overRate ?? 0) * 100).toFixed(1)}%"></span></span>
          <span class="pick-side" data-side="under"${leanTo === 'under' ? ' data-lead' : ''}><span class="pick-side-name">Under</span><span class="pick-pct">${row.under || '—'}</span>${row.under ? price(row.book?.under_odds) : ''}</span>
        </span>${row.anchor ? `<span class="pick-anchor" title="Simulated chance and the posted price">Over: sim ${percent(row.anchor.raw)} · price ${percent(row.anchor.market)}</span>` : ''}`
      : '';
  const spark = row.values.length ? `<span class="pick-spark">${sparkBarsSvg(row.values, row.line, `${row.name}: ${marketLabel(form.market)} in simulated games he played`)}</span>` : '';
  const hits = hasHistory
    ? [dvpChip(row, form, sides.opponent), hitChip('L5', row.games, form, row.line, 5), hitChip('L10', row.games, form, row.line, 10), hitChip('Home', row.games.filter((g) => g.home), form, row.line), hitChip('Away', row.games.filter((g) => !g.home), form, row.line)].join('')
    : '';
  const edgeTone = row.edge.includes('+') ? ' edge-up' : row.edge.includes('-') || row.edge.includes('−') ? ' edge-down' : '';
  return `<li class="pick-card${selected ? ' is-selected' : ''}${row.note ? ' is-out' : ''}"${leanTo ? ` data-lean="${leanTo}"` : ''}>
      <button type="button" class="pick-hit projection-player" data-projection-player="${id}" data-projection-event="${escapeHtml(row.eventId)}" aria-pressed="${selected ? 'true' : 'false'}">
        <span class="pick-head">
          <span class="pick-face">${avatarMarkup(row.name, row.athleteId, row.headshot)}${logoImg(sides.team)}</span>
          <span class="pick-who"><span class="pick-name">${escapeHtml(row.name)}</span><span class="pick-sub">${escapeHtml(sub)}</span></span>
        </span>
        <span class="pick-numbers">
          <span class="pick-stat pick-proj"><span class="pick-label">Projection</span>${projection}</span>
          <span class="pick-stat pick-line"><span class="pick-label">${lineLabel}</span>${lineValue}${row.book?.open_line != null ? `<span class="pick-open">Opened ${escapeHtml(lineText(row.book.open_line))}</span>` : ''}</span>
        </span>
        ${row.note ? `<span class="pick-note">${escapeHtml(row.note)}</span>` : spark}
        ${chances}
        ${hits ? `<span class="pick-hits">${hits}</span>` : ''}
        ${row.edge ? `<span class="pick-edge${edgeTone}">${escapeHtml(row.edge)}</span>` : ''}
      </button>
    </li>`;
}

function sortBarHtml(sort: BoardSort, defense: boolean): string {
  return `<div class="mini-tabs board-sort" role="group" aria-label="Order the board">
      <button type="button" class="mini-tab" data-board-sort="projection" aria-pressed="${sort === 'projection' ? 'true' : 'false'}">Projection</button>
      <button type="button" class="mini-tab" data-board-sort="over" aria-pressed="${sort === 'over' ? 'true' : 'false'}">Highest over</button>
      <button type="button" class="mini-tab" data-board-sort="under" aria-pressed="${sort === 'under' ? 'true' : 'false'}">Highest under</button>
      ${defense ? `<button type="button" class="mini-tab" data-board-sort="matchup" aria-pressed="${sort === 'matchup' ? 'true' : 'false'}">Softest D</button>` : ''}
    </div>`;
}

/** The defense filter, and the defense picked from the Defense view with a button to drop it. */
function defenseToolsHtml(context: ProjectionContext | undefined, filter: DvpFilter, focus: DvpFocus | null): string {
  if (!context) return '';
  const chip = (value: DvpFilter, label: string) => `<button type="button" class="mini-tab" data-dvp-filter="${value}" aria-pressed="${filter === value ? 'true' : 'false'}">${label}</button>`;
  const team = focus ? context.teams[focus.team] : null;
  const picked = focus
    ? `<button type="button" class="ghost mini-action dvp-focus" data-dvp-clear>Facing ${escapeHtml(team?.abbr ?? 'this')} D${focus.slot === 'all' ? '' : ` · ${SLOT_WORD[focus.slot]}`} <span aria-hidden="true">×</span><span class="sr-only">, show everyone</span></button>`
    : '';
  return `<div class="mini-tabs dvp-filter" role="group" aria-label="Opponent defense">${chip('all', 'Any defense')}${chip('soft', 'Soft D')}${chip('tough', 'Tough D')}</div>${picked}`;
}

export function projectionBoardHtml(
  game: RateGame,
  simulation: Simulation | null,
  form: PropFormState,
  eventId: string,
  athleteId: string | null,
  context?: ProjectionContext,
  sort: BoardSort = 'projection',
  lines?: ReadonlyMap<string, BookLine>,
  calibration?: PropPanelCalibration | null,
  slate: Slate | null = null,
  defense: { filter?: DvpFilter; focus?: DvpFocus | null } = {},
): string {
  const filter = context ? defense.filter ?? 'all' : 'all';
  const focus = defense.focus ?? null;
  const rows = boardRows(game, simulation, form, athleteId, context, sort, lines, calibration).filter((row) => passesDefense(row, filter, focus));
  const hasHistory = Boolean(context);
  const line = validPropLine(form.line);
  const gradedLine = line !== null && !((form.market === 'dd' || form.market === 'td') && line !== 0.5) ? line : null;
  const sideText = form.side === 'under' ? 'Under' : 'Over';
  const posted = rows.filter((row) => row.book !== null);
  const pickPrompt = !athleteId ? '<p class="board-hint">Tap a player for the full breakdown.</p>' : '';
  const waiting = simulation ? '' : '<p class="panel-lede">Projection, over, under, and edge fill in once this game is simulated.</p>';
  const milestone = form.market === 'dd' || form.market === 'td';
  const source = milestone
    ? 'Double-doubles and triple-doubles settle at 0.5. No price is posted for them here.'
    : posted.length
      ? `Lines are the posted ${escapeHtml(posted[0].book!.book)} over/under for this stat. Each chance weighs the simulation against the price, and a side lights only when it still beats the price.`
      : 'No posted line is in for this stat in this game, so only the projection is shown. Select a player to grade a line of your own.';
  const lineBadge = simulation
    ? `<p class="board-grade-note">${gradedLine !== null && athleteId ? `Selected player graded at <strong>${sideText} ${gradedLine}</strong>. ` : ''}${source}</p>`
    : '';
  const cards = rows.map((row) => pickCardHtml(row, form, row.athleteId === athleteId, cardSides(slate, eventId, row.teamId), hasHistory, false)).join('');
  const none = rows.length ? '' : '<p class="prop-note">No player in this game matches the defense filter.</p>';
  return `${pickPrompt}${waiting}<div class="board-tools">${sortBarHtml(sort, hasHistory)}${defenseToolsHtml(context, filter, focus)}</div>${lineBadge}${none}<ul class="pick-grid">${cards}</ul>`;
}

/** Games the every-game board covers: those not yet final, or the whole slate once every game is done. */
function boardGames(slate: Slate, now: Date): SlateGame[] {
  const today = chicagoDate(now);
  const open = slate.games.filter((game) => game.completed !== true && game.status_state !== 'post');
  if (open.length) return open;
  const todays = slate.games.filter((game) => game.date === today);
  return todays.length ? todays : [...slate.games];
}

/** Rotation players a board without posted lines shows: the ones with real minutes. */
const BOARD_MINUTES = 15;

/**
 * Every game still to play on one board, the way a prop board reads: players with a posted line for the stat when
 * there are any, otherwise the rotation, each with his projection and simulated spread once his game's draws are in.
 */
export function slateBoardHtml(view: ProjectionView): string {
  const games = boardGames(view.slate, view.now);
  const context = view.card.projection_context;
  const sort = view.boardSort ?? 'projection';
  const filter = context ? view.dvpFilter ?? 'all' : 'all';
  const focus = view.dvpFocus ?? null;
  const anyPosted = games.some((game) => view.card.games.find((rate) => rate.event_id === game.event_id)?.players.some((player) => bookLineFor(view.lines, game.event_id, player.athlete_id, view.form.market)));
  const rows: BoardRow[] = [];
  let pending = 0;
  for (const game of games) {
    const rate = view.card.games.find((item) => item.event_id === game.event_id);
    if (!rate) continue;
    const simulation = view.simulations?.get(game.event_id) ?? (view.eventId === game.event_id ? view.simulation : null);
    if (!simulation) pending += 1;
    const athleteId = view.eventId === game.event_id ? view.athleteId : null;
    for (const row of boardRows(rate, simulation ?? null, view.form, athleteId, context, sort, view.lines, view.propCalibration)) {
      if (row.note && row.athleteId !== view.athleteId) continue;
      const player = rate.players.find((item) => item.athlete_id === row.athleteId);
      if (!player || player.replacement_level) continue;
      const keep = anyPosted ? row.book !== null : player.minutes_weight !== 0 && player.minutes_mean >= BOARD_MINUTES;
      if ((keep || row.athleteId === view.athleteId) && passesDefense(row, filter, focus)) rows.push(row);
    }
  }
  sortRows(rows, sort, true);
  const milestone = view.form.market === 'dd' || view.form.market === 'td';
  const book = rows.find((row) => row.book)?.book?.book;
  const note = anyPosted && book
    ? `Players with a posted ${escapeHtml(book)} line for ${escapeHtml(marketLabel(view.form.market).toLowerCase())}. Each chance weighs the simulation against the price, and a side lights only when it still beats the price.`
    : milestone
      ? 'Double-doubles and triple-doubles settle at 0.5.'
      : `No posted line is in for ${escapeHtml(marketLabel(view.form.market).toLowerCase())} yet, so the board shows every rotation player's projection.`;
  const waiting = pending ? `<p class="board-grade-note" role="status">${pending} ${pending === 1 ? 'game is still loading its' : 'games are still loading their'} 10,000 simulations; those players fill in as they arrive.</p>` : '';
  const limit = view.boardLimit ?? null;
  const shown = limit !== null && rows.length > limit ? rows.slice(0, limit) : rows;
  const chosen = rows.find((row) => row.athleteId === view.athleteId && row.eventId === view.eventId);
  if (chosen && !shown.includes(chosen)) shown.push(chosen);
  const more = shown.length < rows.length ? `<button type="button" class="ghost board-more" data-board-more>Show all ${rows.length} players</button>` : '';
  const cards = shown.map((row) => pickCardHtml(row, view.form, row.athleteId === view.athleteId && row.eventId === view.eventId, cardSides(view.slate, row.eventId, row.teamId), Boolean(context), true)).join('');
  const empty = rows.length ? '' : filter !== 'all' || focus ? '<p class="prop-note">No player matches the defense filter.</p>' : '<p class="prop-note">No player on the board yet.</p>';
  return `<p class="board-hint">Tap a player for the full breakdown.</p><div class="board-tools">${sortBarHtml(sort, Boolean(context))}${defenseToolsHtml(context, filter, focus)}</div><p class="board-grade-note">${note}</p>${waiting}${empty}<ul class="pick-grid">${cards}</ul>${more}`;
}

interface DefenseRow {
  game: SlateGame;
  defense: TeamSide;
  offense: TeamSide;
  cells: Record<DefenseSlot, RankedStat>;
  pace: RankedStat;
}

const DEFENSE_COLUMNS: readonly DefenseSlot[] = ['G', 'F', 'C', 'all'];

/**
 * Tonight's defenses against each position for the picked stat, as a heatmap: what each allows a game, its rank of 30,
 * and its pace. A number opens the players who face that defense at that position.
 */
export function defenseModeHtml(view: ProjectionView): string {
  const context = view.card.projection_context;
  if (!context) return '<p class="state">Defense numbers are not on this card yet.</p>';
  const key = marketToDefenseKey(view.form.market);
  const stat = defenseStatLabel(view.form.market);
  const sort = view.dvpSort ?? 'all';
  const rows: DefenseRow[] = [];
  for (const game of boardGames(view.slate, view.now)) {
    for (const [defense, offense] of [[game.home, game.away], [game.away, game.home]] as const) {
      const team = context.teams[defense.team_id];
      if (!team?.allowed?.[key]) continue;
      const cells = { all: unpackTeamAllowed(team, key, 'all'), G: unpackTeamAllowed(team, key, 'G'), F: unpackTeamAllowed(team, key, 'F'), C: unpackTeamAllowed(team, key, 'C') };
      rows.push({ game, defense, offense, cells, pace: unpackRankedPair(team.pace) });
    }
  }
  if (!rows.length) return '<p class="state">No game left tonight to rank.</p>';
  rows.sort((a, b) => b.cells[sort][1] - a.cells[sort][1] || b.cells[sort][0] - a.cells[sort][0] || sideAbbr(a.defense).localeCompare(sideAbbr(b.defense)));
  const head = DEFENSE_COLUMNS.map(
    (slot) => `<th scope="col"><button type="button" class="dvp-sort" data-dvp-sort="${slot}" aria-pressed="${sort === slot ? 'true' : 'false'}">${SLOT_NAME[slot]}${sort === slot ? ' <span aria-hidden="true">↓</span>' : ''}</button></th>`,
  ).join('');
  const body = rows
    .map((row) => {
      const abbr = sideAbbr(row.defense);
      const cells = DEFENSE_COLUMNS.map((slot) => {
        const [value, rank] = row.cells[slot];
        const tone = rankTone(rank, true);
        const title = `${abbr} allows ${value.toFixed(1)} ${stat} a game to ${SLOT_WORD[slot]}: ${ordinal(rank)} of 30, where 30th allows the most. Show the ${sideAbbr(row.offense)} ${slot === 'all' ? 'players' : SLOT_WORD[slot]} facing it.`;
        return `<td data-label="${escapeHtml(SLOT_NAME[slot])}"><button type="button" class="dvp-cell" data-tone="${tone}" data-dvp-team="${escapeHtml(row.defense.team_id)}" data-dvp-slot="${slot}" data-dvp-event="${escapeHtml(row.game.event_id)}" title="${escapeHtml(title)}"><strong>${value.toFixed(1)}</strong><small>${ordinal(rank)}</small></button></td>`;
      }).join('');
      const [pace, paceRank] = row.pace;
      return `<tr>
          <th scope="row"><span class="dvp-team">${logoImg(row.defense)}<span class="dvp-team-copy"><span class="dvp-abbr">${escapeHtml(abbr)}</span><span class="dvp-vs">vs ${escapeHtml(sideAbbr(row.offense))} · ${escapeHtml(clockText(row.game.start_time))}</span></span></span></th>
          ${cells}
          <td class="dvp-pace" data-label="Pace" data-tone="${rankTone(paceRank, false)}" title="${escapeHtml(`${pace.toFixed(1)} possessions per 48 minutes, ${ordinal(paceRank)} fastest of 30`)}"><strong>${pace.toFixed(1)}</strong><small>${ordinal(paceRank)}</small></td>
        </tr>`;
    })
    .join('');
  return `<section class="dvp-page" aria-label="Defense by position">
      <div class="dvp-head">
        <h2>${escapeHtml(marketLabel(view.form.market === 'dd' || view.form.market === 'td' ? 'pra' : view.form.market))} allowed by position</h2>
        <p class="section-sub">Tonight's defenses, ${escapeHtml(context.defense_season_label)}, per game. Rank 30 allows the most, so green is the softest matchup. Tap a number to see the players who face it.</p>
      </div>
      <p class="def-legend"><span><i class="dot fav"></i>Soft (21–30)</span><span><i class="dot mid"></i>Mid (11–20)</span><span><i class="dot tough"></i>Tough (1–10)</span></p>
      <div class="table-scroll"><table class="dvp-table">
        <thead><tr><th scope="col">Defense</th>${head}<th scope="col">Pace</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </section>`;
}

/** What goes inside the board for the view's scope. */
export function boardInnerHtml(view: ProjectionView): string {
  const scope = view.scope ?? (view.eventId ? 'game' : 'all');
  if (scope === 'all') return slateBoardHtml(view);
  const rate = view.card.games.find((item) => item.event_id === view.eventId) ?? null;
  if (!rate || !view.eventId) return '';
  return projectionBoardHtml(rate, view.simulation, view.form, view.eventId, view.athleteId, view.card.projection_context, view.boardSort ?? 'projection', view.lines, view.propCalibration, view.slate, { filter: view.dvpFilter, focus: view.dvpFocus });
}

export function projectionChartHtml(sample: PlayerSample | null, market: PropMarket, lineRaw: string): string {
  if (!sample) return '';
  if (statMissing(sample, market)) return '<p class="prop-note">This stat is missing from the older card.</p>';
  const values = playedValues(sample, market);
  if (!values.length) return '<p class="prop-note">This player does not play in the simulations.</p>';
  const line = validPropLine(lineRaw);
  const graded = line !== null && !((market === 'dd' || market === 'td') && line !== 0.5) ? line : null;
  const svg = propBarsSvg(values, graded, `${marketLabel(market)} in simulated games this player played`);
  return `<figure class="chart projection-chart">
      <figcaption><span>These are 10,000 simulated games, not past games.</span><span class="legend-pair"><i class="key under"></i>Under<i class="key push"></i>Push<i class="key over"></i>Over</span></figcaption>
      ${svg}
    </figure>`;
}

function sideAbbr(side: TeamSide): string {
  const abbreviation = side.abbreviation.trim();
  if (abbreviation) return abbreviation;
  return side.name.trim() || 'Team';
}

function sideName(side: TeamSide): string {
  const name = side.name.trim();
  if (name) return name;
  return sideAbbr(side);
}

function teamAbbrById(teamId: string, slate: Slate, context?: ProjectionContext): string {
  for (const game of slate.games) {
    if (game.away.team_id === teamId) return sideAbbr(game.away);
    if (game.home.team_id === teamId) return sideAbbr(game.home);
  }
  return context?.teams[teamId]?.abbr ?? NBA_TEAMS[teamId]?.abbr ?? teamId;
}

function shortCalendarDate(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function shareText(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0 || value > 1) return 'not in the data';
  return percent(value);
}

function minutesText(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return 'not in the data';
  return value.toFixed(1);
}

function monogram(name: string): string {
  const trimmed = name.trim();
  return escapeHtml(Array.from(trimmed)[0]?.toUpperCase() ?? '?');
}

function photoHtml(name: string, url: string | null): string {
  const letter = monogram(name);
  if (!url) return `<div class="photo"><span class="mono">${letter}</span></div>`;
  return `<div class="photo"><img referrerpolicy="no-referrer" class="headshot" alt="${escapeHtml(name)}" src="${escapeHtml(url)}" width="64" height="64"><span class="mono" hidden>${letter}</span></div>`;
}

function callFor(name: string, game: RateGame, overrides: LineupOverrides): string {
  const summary = summarizeOverrides(game, overrides);
  if (summary.ruledOut.includes(name)) return 'Your call: out';
  if (summary.ruledIn.includes(name)) return 'Your call: in';
  return '';
}

function teammateNote(player: RatePlayer, game: RateGame, overrides: LineupOverrides): string {
  const call = callFor(player.name, game, overrides);
  if (call) return call;
  const status = player.injury_status.trim();
  if (status === 'out' || status === 'day-to-day' || player.minutes_weight === 0) return status || 'out';
  return '';
}

function teammatesHtml(game: RateGame, player: RatePlayer, overrides: LineupOverrides): string {
  const mates = game.players
    .filter((item) => item.team_id === player.team_id && item.athlete_id !== player.athlete_id && !item.replacement_level)
    .sort((a, b) => b.minutes_mean - a.minutes_mean || a.name.localeCompare(b.name));
  if (!mates.length) return '';
  const chips = mates
    .map((mate) => {
      const note = teammateNote(mate, game, overrides);
      const out = note === 'out' || note === 'Your call: out';
      return `<span class="chip${out ? ' chip-out' : note ? ' chip-warn' : ''}">${escapeHtml(mate.name)}${note ? ` <em>${escapeHtml(note)}</em>` : ''}</span>`;
    })
    .join('');
  return `<div class="teammate-row" data-teammates>
      <div class="section-head">
        <p class="stat-group-label">Teammates</p>
        <button type="button" class="ghost mini-action" data-lineup="${escapeHtml(game.event_id)}">Edit lineups</button>
      </div>
      <div class="chips">${chips}</div>
    </div>`;
}

function simPlayer(simulation: Simulation, athleteId: string) {
  return [...simulation.away.players, ...simulation.home.players].find((player) => player.athlete_id === athleteId) ?? null;
}

function meanTile(label: string, value: number | undefined, name: string, tone: '' | 'hero' | 'lead'): string {
  const shown = value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(1);
  const cls = tone ? `stat-tile stat-${tone}` : 'stat-tile';
  return `<div class="${cls}"><dt>${label}</dt><dd>${shown}</dd><span class="stat-name">${escapeHtml(name)}</span></div>`;
}

/** The headline of the detail: his projection for the stat and how often he plays in the simulations. */
function spotlightHtml(simulation: Simulation, athleteId: string, market: PropMarket): string {
  const line = simPlayer(simulation, athleteId);
  const sample = simulation.playerDraws.get(athleteId) ?? null;
  if (!line?.expectation?.played || !sample) return '<p class="prop-note">This player does not play in the simulations.</p>';
  const share = `${(line.expectation.playRate * 100).toFixed(1)}%`;
  const width = Math.max(0, Math.min(100, line.expectation.playRate * 100)).toFixed(1);
  const values = statMissing(sample, market) ? [] : playedValues(sample, market);
  const mean = playedMean(values);
  const headline = statMissing(sample, market)
    ? '<p class="prop-note">This stat is missing from the older card.</p>'
    : mean === null
      ? '<p class="prop-note">This player does not play in the simulations.</p>'
      : `<p class="projection-headline"><span class="stat-group-label">${escapeHtml(marketLabel(market))} · 10k projection</span><span class="projection-value">${mean.toFixed(1)}</span></p>`;
  return `${headline}
    <div class="play-meter"><p class="play-meter-label"><span>Simulated play share</span><span class="play-meter-value">${share}</span></p><span class="play-track" aria-hidden="true"><span class="play-fill" style="width:${width}%"></span></span></div>`;
}

/** His full expected line in the games he plays. */
function meansHtml(simulation: Simulation, athleteId: string): string {
  const played = simPlayer(simulation, athleteId)?.expectation?.played ?? null;
  if (!played) return '';
  return `<p class="panel-lede">Means from the draws this player actually played.</p>
    <dl class="line line-hero">
      ${meanTile('PTS', played.ptsMean, 'Points when playing', 'hero')}
      ${meanTile('MIN', played.minMean, 'Minutes', 'lead')}
      ${meanTile('REB', played.rebMean, 'Rebounds', 'lead')}
      ${meanTile('AST', played.astMean, 'Assists', '')}
      ${meanTile('3PM', played.counts?.tpm, 'Threes', '')}
    </dl>`;
}

function factsHtml(player: RatePlayer): string {
  return `<dl class="projection-facts">
      <div><dt>Typical minutes</dt><dd>${minutesText(player.typical_minutes)}</dd></div>
      <div><dt>Starter rate</dt><dd>${shareText(player.starter_rate)}</dd></div>
      <div><dt>Closing rate</dt><dd>${shareText(player.closing_rate)}</dd></div>
      <div><dt>Input play probability</dt><dd>${shareText(player.play_probability)}</dd></div>
    </dl>`;
}

function lineTools(form: PropFormState, simReady: boolean, histReady: boolean): string {
  const locked = form.market === 'dd' || form.market === 'td';
  const stepDisabled = locked ? ' disabled' : '';
  const simDisabled = locked || !simReady ? ' disabled' : '';
  const histDisabled = locked || !histReady ? ' disabled' : '';
  return `<div class="line-step">
      <p class="field-label">The viewer's line</p>
      <div class="line-step-row">
        <button type="button" class="ghost" data-line-nudge="-0.5"${stepDisabled}>−0.5</button>
        <button type="button" class="ghost" data-line-nudge="0.5"${stepDisabled}>+0.5</button>
        <button type="button" class="ghost" data-line-median${simDisabled}>Nearest half point to the simulated median</button>
        ${histReady ? `<button type="button" class="ghost" data-line-l10${histDisabled}>L10 median half point</button>` : ''}
      </div>
      ${locked ? '<p class="field-hint">Double-doubles and triple-doubles stay at 0.5.</p>' : ''}
    </div>`;
}

function marketPillValue(
  market: PropMarket,
  sample: PlayerSample | null,
  rows: readonly PlayerGameRow[],
): string {
  if (sample && !statMissing(sample, market)) {
    const vals = playedValues(sample, market);
    const mean = playedMean(vals);
    if (mean !== null) return mean.toFixed(1);
  }
  if (rows.length) {
    const vals = rows
      .map((r) => historicalStatValue(r, market))
      .filter((v): v is number => v !== null && Number.isFinite(v))
      .slice(-10);
    const mean = playedMean(vals);
    if (mean !== null) return mean.toFixed(1);
  }
  return '';
}

function marketPills(form: PropFormState, sample: PlayerSample | null, rows: readonly PlayerGameRow[]): string {
  const buttons = MARKETS.map((market) => {
    const sub = marketPillValue(market.value, sample, rows);
    return `<button type="button" class="market-pill" data-projection-market="${market.value}" aria-pressed="${form.market === market.value ? 'true' : 'false'}"><span class="pill-name">${market.short}</span>${sub ? `<span class="pill-val">${sub}</span>` : ''}</button>`;
  }).join('');
  return `<div class="market-pills" role="group" aria-label="Market">${buttons}</div>`;
}

function filterRowsByLocation(rows: readonly PlayerGameRow[], split: HistorySplit): PlayerGameRow[] {
  if (split === 'home') return rows.filter((r) => r.home);
  if (split === 'away') return rows.filter((r) => !r.home);
  return [...rows];
}

export function historySummaryHtml(
  filteredRows: readonly PlayerGameRow[],
  allRows: readonly PlayerGameRow[],
  form: PropFormState,
  activeSeason: number,
): string {
  const graded = gradedPropLine(form.market, validPropLine(form.line));
  const validCut = filteredRows
    .map((r) => historicalStatValue(r, form.market))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const l10Vals = validCut.slice(-10);
  const l10Avg = playedMean(l10Vals);
  const seasonVals = allRows
    .filter((r) => r.season === activeSeason)
    .map((r) => historicalStatValue(r, form.market))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const seasonAvg = playedMean(seasonVals);

  const lineText = graded === null ? '—' : Number.isInteger(graded) ? graded.toFixed(1) : String(graded);
  const l10Text = l10Avg === null ? '—' : l10Avg.toFixed(1);
  const seasonSub = seasonAvg === null ? `${l10Vals.length} games` : `season ${seasonAvg.toFixed(1)}`;

  let diffText = '—';
  let diffSub = 'set a line';
  let diffClass = '';
  if (l10Avg !== null && graded !== null) {
    const diff = l10Avg - graded;
    const pct = graded > 0 ? Math.round((diff / graded) * 100) : 0;
    diffText = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`;
    diffSub = graded > 0 ? `${pct >= 0 ? '+' : ''}${pct}% vs line` : 'vs line';
    diffClass = diff > 0.04 ? 'edge-up' : diff < -0.04 ? 'edge-down' : '';
  }

  const streak = computeStreak(filteredRows, form.market, graded);
  let streakText = '—';
  let streakClass = '';
  if (streak) {
    const word = streak.kind === 'over' ? (streak.count === 1 ? 'over' : 'overs') : streak.kind === 'under' ? (streak.count === 1 ? 'under' : 'unders') : streak.count === 1 ? 'push' : 'pushes';
    streakText = `${streak.count} ${word}`;
    streakClass = streak.kind === 'over' ? 'edge-up' : streak.kind === 'under' ? 'edge-down' : '';
  }

  return `<dl class="history-kpis">
      <div><dt>Line</dt><dd>${escapeHtml(lineText)}</dd><span>viewer's line</span></div>
      <div><dt>L10 avg</dt><dd>${escapeHtml(l10Text)}</dd><span>${escapeHtml(seasonSub)}</span></div>
      <div><dt>Avg vs line</dt><dd class="${diffClass}">${escapeHtml(diffText)}</dd><span>${escapeHtml(diffSub)}</span></div>
      <div><dt>Streak</dt><dd class="${streakClass}">${escapeHtml(streakText)}</dd><span>most recent</span></div>
    </dl>`;
}

export function historyChartBlockHtml(
  filteredRows: readonly PlayerGameRow[],
  form: PropFormState,
  selectedIndex: number | null,
  teamAbbr: string,
  slate: Slate,
  context: ProjectionContext,
): string {
  const validRows = filteredRows.filter((row) => historicalStatValue(row, form.market) !== null);
  const last20 = validRows.slice(-20);
  if (!last20.length) {
    return '<p class="prop-note">No completed games in this split yet.</p>';
  }
  const line = validPropLine(form.line);
  const graded = line !== null && !((form.market === 'dd' || form.market === 'td') && line !== 0.5) ? line : null;
  const activeIdx =
    selectedIndex !== null && selectedIndex >= 0 && selectedIndex < last20.length ? selectedIndex : last20.length - 1;

  const barPoints: HistoryBarPoint[] = last20.map((row) => {
    const oppAbbr = teamAbbrById(row.opp, slate, context);
    const val = historicalStatValue(row, form.market) ?? 0;
    const oppLabel = `${row.home ? '' : '@'}${oppAbbr}`;
    const shortDate = shortCalendarDate(row.date);
    return {
      oppLabel,
      shortDate,
      value: val,
      ariaLabel: `${shortDate} ${row.home ? 'vs' : 'at'} ${oppAbbr}: ${val} ${marketLabel(form.market)} in ${row.min.toFixed(0)} minutes`,
    };
  });

  const svg = historyBarsSvg(barPoints, graded, activeIdx, `Last ${last20.length} games ${marketLabel(form.market)}`);
  const picked = last20[activeIdx];
  const pickedVal = historicalStatValue(picked, form.market) ?? 0;
  const oppAbbr = teamAbbrById(picked.opp, slate, context);
  const verdict =
    graded === null
      ? ''
      : pickedVal === graded
        ? `<span class="result-pill push">push ${graded}</span>`
        : pickedVal > graded
          ? `<span class="result-pill over">over ${graded} (${(pickedVal - graded >= 0 ? '+' : '') + (pickedVal - graded).toFixed(1)})</span>`
          : `<span class="result-pill under">under ${graded} (${(pickedVal - graded).toFixed(1)})</span>`;
  const callout = `<div class="history-callout">
      <div class="callout-main">
        <span class="callout-date">${escapeHtml(shortCalendarDate(picked.date))} · ${picked.home ? 'HOME' : 'AWAY'}</span>
        <strong>${escapeHtml(teamAbbr)} ${picked.teamPts} : ${picked.oppPts} ${escapeHtml(oppAbbr)}</strong>
        ${verdict}
      </div>
      <div class="callout-stats">
        <span><b>${escapeHtml(marketShort(form.market))}</b> ${pickedVal}</span>
        <span><b>MIN</b> ${picked.min.toFixed(0)}</span>
        <span><b>FG</b> ${picked.fgm}-${picked.fga}</span>
        <span><b>3PT</b> ${picked.tpm}-${picked.tpa}</span>
        <span><b>FT</b> ${picked.ftm}-${picked.fta}</span>
        ${picked.usg !== null ? `<span><b>USG</b> ${picked.usg.toFixed(1)}%</span>` : ''}
      </div>
    </div>`;
  return `<div class="history-chart-wrap">${svg}</div>${callout}`;
}

export function historyWindowsHtml(
  filteredRows: readonly PlayerGameRow[],
  form: PropFormState,
  activeSeason: number,
  opponentTeamId: string,
  courtRows: readonly PlayerGameRow[] = filteredRows,
): string {
  const graded = gradedPropLine(form.market, validPropLine(form.line));
  const windows = computeHitWindows(filteredRows, form.market, form.side, graded, activeSeason, opponentTeamId, courtRows);
  const sideLabel = form.side === 'under' ? 'Under' : 'Over';
  const cards = windows
    .map((win) => {
      if (graded === null || win.grade.decided === 0) {
        const sub = graded === null ? 'set line' : win.grade.pushes > 0 ? `${win.grade.pushes} push` : '0 games';
        return `<div class="hit-window tone-muted"><span class="win-label">${win.label}</span><strong>—</strong><small>${escapeHtml(sub)}</small></div>`;
      }
      const pct = Math.round((win.grade.rate ?? 0) * 100);
      const pushNote = win.grade.pushes > 0 ? ` · ${win.grade.pushes}P` : '';
      return `<div class="hit-window ${hitToneClass(win.grade.rate)}"><span class="win-label">${win.label}</span><strong>${pct}%</strong><small>${win.grade.wins}/${win.grade.decided}${pushNote}</small></div>`;
    })
    .join('');
  return `<p class="stat-group-label">${sideLabel} hit rate by window${graded !== null ? ` · line ${graded}` : ''}</p><div class="hit-windows">${cards}</div>`;
}

function supportingStatsHtml(rows: readonly PlayerGameRow[], market: PropMarket, mode: SupportMode): string {
  const items = computeSupportingStats(rows, market, mode);
  if (!items.length) return '';
  const cells = items
    .map(
      (item) =>
        `<div class="support-cell"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd>${item.sub ? `<span>${escapeHtml(item.sub)}</span>` : ''}</div>`,
    )
    .join('');
  return `<div class="support-block" data-supporting-stats>
      <div class="section-head">
        <div><h3 class="section-kicker">Supporting stats</h3><p class="section-sub">${mode === 'med' ? 'Median' : 'Average'} per game over the last ${Math.min(20, rows.length)} games</p></div>
        <div class="mini-tabs" role="group" aria-label="Supporting stat aggregation">
          <button type="button" class="mini-tab" data-support-mode="avg" aria-pressed="${mode === 'avg' ? 'true' : 'false'}">Average</button>
          <button type="button" class="mini-tab" data-support-mode="med" aria-pressed="${mode === 'med' ? 'true' : 'false'}">Median</button>
        </div>
      </div>
      <dl class="support-grid">${cells}</dl>
    </div>`;
}

function historyPanelHtml(
  view: ProjectionView,
  game: SlateGame,
  player: RatePlayer,
  form: PropFormState,
  context: ProjectionContext,
): string {
  const allRows = unpackPlayerGames(context.players[player.athlete_id]?.games);
  if (!allRows.length) return '';
  const split: HistorySplit = view.historySplit ?? 'all';
  const mode: SupportMode = view.supportMode ?? 'avg';
  const filtered = filterRowsByLocation(allRows, split);
  const team = player.team_id === game.away.team_id ? game.away : game.home;
  const opponent = player.team_id === game.away.team_id ? game.home : game.away;
  return `<section class="projection-card history-panel" data-block="proj-history" aria-label="Historical game record">
      <div class="section-head">
        <div>
          <h3 class="section-kicker">${escapeHtml(marketLabel(form.market))} · recent games</h3>
          <p class="section-sub">${filtered.length} games in this cut · click any bar to inspect the box score</p>
        </div>
        <div class="mini-tabs" role="group" aria-label="Location filter">
          <button type="button" class="mini-tab" data-history-split="all" aria-pressed="${split === 'all' ? 'true' : 'false'}">All</button>
          <button type="button" class="mini-tab" data-history-split="home" aria-pressed="${split === 'home' ? 'true' : 'false'}">Home</button>
          <button type="button" class="mini-tab" data-history-split="away" aria-pressed="${split === 'away' ? 'true' : 'false'}">Away</button>
        </div>
      </div>
      <div data-history-summary>${historySummaryHtml(filtered, allRows, form, context.active_season)}</div>
      <div data-history-chart>${historyChartBlockHtml(filtered, form, view.selectedGameIndex ?? null, sideAbbr(team), view.slate, context)}</div>
      <div data-history-windows>${historyWindowsHtml(filtered, form, context.active_season, opponent.team_id, allRows)}</div>
      ${supportingStatsHtml(filtered, form.market, mode)}
    </section>`;
}

function defaultOnOffMate(
  onOff: PlayerOnOffSummary,
  rate: RateGame,
  player: RatePlayer,
  overrides: LineupOverrides,
  requested: string | null | undefined,
): TeammateSplit | null {
  if (!onOff.splits.length) return null;
  if (requested) {
    const exact = onOff.splits.find((s) => s.mate_id === requested);
    if (exact) return exact;
  }
  const matesById = new Map(rate.players.filter((p) => p.team_id === player.team_id).map((p) => [p.athlete_id, p]));
  const outSplit = onOff.splits.find((s) => {
    const mate = matesById.get(s.mate_id);
    if (!mate) return false;
    const note = teammateNote(mate, rate, overrides);
    return note === 'out' || note === 'Your call: out';
  });
  return outSplit ?? onOff.splits[0];
}

function signedDelta(val: number, suffix = ''): string {
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}${suffix}`;
}

function onOffPanelHtml(
  rate: RateGame,
  player: RatePlayer,
  overrides: LineupOverrides,
  context: ProjectionContext,
  selectedMateId: string | null | undefined,
): string {
  const onOff = unpackOnOff(context.players[player.athlete_id]?.on_off);
  if (!onOff) return '';
  const matesById = new Map(rate.players.filter((p) => p.team_id === player.team_id).map((p) => [p.athlete_id, p]));
  const activeSplit = defaultOnOffMate(onOff, rate, player, overrides, selectedMateId);
  const [totalMin, totalUsg] = onOff.overall;
  const intro = `<p class="section-copy">Usage is the share of his team's plays he finishes — a shot, a free-throw trip, or a turnover — counted over the minutes on the court. Across these ${onOff.games} games (${totalMin} min) it is <strong>${totalUsg.toFixed(1)}%</strong>.</p>`;
  if (!activeSplit) {
    return `<section class="projection-card onoff-panel" data-block="proj-onoff" aria-label="On and off court usage">
        <div class="section-head">
          <h3 class="section-kicker">Who he shares the floor with</h3>
          <span class="meta-pill">${onOff.games} games with rebuilt lineups · ${escapeHtml(onOff.season_label)}</span>
        </div>
        ${intro}
        <p class="prop-note">A teammate split needs at least 20 minutes on the court both on and off.</p>
      </section>`;
  }

  const activeMate = matesById.get(activeSplit.mate_id);
  const activeName = activeMate?.name ?? activeSplit.mate_id;
  const usgSwing = Math.round((activeSplit.off[1] - activeSplit.on[1]) * 10) / 10;
  const ptsSwing = Math.round((activeSplit.off[2] - activeSplit.on[2]) * 10) / 10;
  const swingClass = usgSwing > 0.05 ? 'edge-up' : usgSwing < -0.05 ? 'edge-down' : '';

  const chipButtons = onOff.splits
    .map((split) => {
      const mate = matesById.get(split.mate_id);
      const name = mate?.name ?? split.mate_id;
      const note = mate ? teammateNote(mate, rate, overrides) : '';
      const isOut = note === 'out' || note === 'Your call: out';
      const pressed = split.mate_id === activeSplit.mate_id;
      return `<button type="button" class="mate-pill${isOut ? ' is-out' : ''}" data-onoff-mate="${escapeHtml(split.mate_id)}" aria-pressed="${pressed ? 'true' : 'false'}"><span>${escapeHtml(name)}</span>${note ? `<em class="mate-tag">${escapeHtml(note.toUpperCase())}</em>` : ''}</button>`;
    })
    .join('');

  const [onMin, onUsg, onPts, onFga, onReb, onAst, onTov] = activeSplit.on;
  const [offMin, offUsg, offPts, offFga, offReb, offAst, offTov] = activeSplit.off;

  const allRows = onOff.splits
    .map((split) => {
      const mate = matesById.get(split.mate_id);
      const name = mate?.name ?? split.mate_id;
      const note = mate ? teammateNote(mate, rate, overrides) : '';
      const delta = Math.round((split.off[1] - split.on[1]) * 10) / 10;
      const cls = delta > 0.05 ? 'edge-up' : delta < -0.05 ? 'edge-down' : '';
      const selected = split.mate_id === activeSplit.mate_id;
      return `<tr${selected ? ' class="is-selected"' : ''}>
          <th scope="row"><button type="button" class="projection-player" data-onoff-mate="${escapeHtml(split.mate_id)}" aria-pressed="${selected ? 'true' : 'false'}">${escapeHtml(name)}${note ? ` <small class="mate-inline-note">${escapeHtml(note)}</small>` : ''}</button></th>
          <td>${split.on[0]}</td>
          <td>${split.on[1].toFixed(1)}%</td>
          <td>${split.on[2].toFixed(1)}</td>
          <td>${split.off[0]}</td>
          <td>${split.off[1].toFixed(1)}%</td>
          <td>${split.off[2].toFixed(1)}</td>
          <td class="${cls}">${signedDelta(delta)}</td>
        </tr>`;
    })
    .join('');

  return `<section class="projection-card onoff-panel" data-block="proj-onoff" aria-label="On and off court usage">
      <div class="section-head">
        <h3 class="section-kicker">Who he shares the floor with</h3>
        <span class="meta-pill">${onOff.games} games with rebuilt lineups · ${escapeHtml(onOff.season_label)}</span>
      </div>
      ${intro}
      <div class="mate-pills" role="group" aria-label="Teammates with reconstructed splits">${chipButtons}</div>
      <div class="onoff-banner">
        <div>
          <p class="onoff-title">With <strong>${escapeHtml(activeName)}</strong> OFF the floor, his usage goes</p>
          <p class="section-sub">Points / 36 moves ${signedDelta(ptsSwing)} (${onPts.toFixed(1)} with · ${offPts.toFixed(1)} without)</p>
        </div>
        <div class="onoff-delta">
          <strong class="${swingClass}">${signedDelta(usgSwing)}</strong>
          <span>pts of usage</span>
        </div>
      </div>
      <div class="table-scroll">
        <table class="onoff-compare">
          <thead><tr><th>Metric</th><th>With him</th><th>Without him</th></tr></thead>
          <tbody>
            <tr><th scope="row">Usage %</th><td>${onUsg.toFixed(1)}%</td><td>${offUsg.toFixed(1)}%</td></tr>
            <tr><th scope="row">Points / 36</th><td>${onPts.toFixed(1)}</td><td>${offPts.toFixed(1)}</td></tr>
            <tr><th scope="row">Shots / 36</th><td>${onFga.toFixed(1)}</td><td>${offFga.toFixed(1)}</td></tr>
            <tr><th scope="row">Rebounds / 36</th><td>${onReb.toFixed(1)}</td><td>${offReb.toFixed(1)}</td></tr>
            <tr><th scope="row">Assists / 36</th><td>${onAst.toFixed(1)}</td><td>${offAst.toFixed(1)}</td></tr>
            <tr><th scope="row">Turnovers / 36</th><td>${onTov.toFixed(1)}</td><td>${offTov.toFixed(1)}</td></tr>
            <tr><th scope="row">Minutes</th><td>${onMin}</td><td>${offMin}</td></tr>
          </tbody>
        </table>
      </div>
      <details class="onoff-all" open>
        <summary>Every teammate (${onOff.splits.length})</summary>
        <div class="table-scroll">
          <table class="onoff-every">
            <thead>
              <tr class="group-row"><th></th><th colspan="3">Teammate on court</th><th colspan="3">Teammate off court</th><th></th></tr>
              <tr><th>Teammate</th><th>Min</th><th>USG%</th><th>P/36</th><th>Min</th><th>USG%</th><th>P/36</th><th>Off ΔUSG</th></tr>
            </thead>
            <tbody>${allRows}</tbody>
          </table>
        </div>
        <p class="field-hint">Min is minutes on the court shared and apart. P/36 is points per 36 on-court minutes. A split needs 20 minutes on each side before it appears.</p>
      </details>
    </section>`;
}

export function gameLogRowsHtml(
  rows: readonly PlayerGameRow[],
  form: PropFormState,
  slate: Slate,
  context: ProjectionContext,
): string {
  const line = validPropLine(form.line);
  const graded = line !== null && !((form.market === 'dd' || form.market === 'td') && line !== 0.5) ? line : null;
  const recent = [...rows].reverse().slice(0, 20);
  return recent
    .map((row) => {
      const oppAbbr = teamAbbrById(row.opp, slate, context);
      const val = historicalStatValue(row, form.market);
      const valText = val === null ? '—' : String(val);
      let resCell = '—';
      if (graded !== null && val !== null) {
        if (val === graded) resCell = '<span class="result-pill push">push</span>';
        else if (val > graded) resCell = `<span class="result-pill over">over +${(val - graded).toFixed(1)}</span>`;
        else resCell = `<span class="result-pill under">under ${(val - graded).toFixed(1)}</span>`;
      }
      const outcome = row.teamPts > row.oppPts ? 'W' : 'L';
      const statLabel = escapeHtml(marketShort(form.market));
      return `<tr>
          <th scope="row">${escapeHtml(shortCalendarDate(row.date))}</th>
          <td data-label="Opp">${row.home ? 'vs ' : '@ '}${escapeHtml(oppAbbr)}</td>
          <td data-label="Score">${outcome} ${row.teamPts}-${row.oppPts}</td>
          <td data-label="Min">${row.min.toFixed(0)}</td>
          <td class="log-stat" data-label="${statLabel}">${escapeHtml(valText)}</td>
          <td data-label="FG">${row.fgm}-${row.fga}</td>
          <td data-label="3PT">${row.tpm}-${row.tpa}</td>
          <td data-label="FT">${row.ftm}-${row.fta}</td>
          <td data-label="USG%">${row.usg === null ? '—' : `${row.usg.toFixed(1)}%`}</td>
          <td data-label="Result">${resCell}</td>
        </tr>`;
    })
    .join('');
}

function gameLogPanelHtml(
  view: ProjectionView,
  player: RatePlayer,
  form: PropFormState,
  context: ProjectionContext,
): string {
  const allRows = unpackPlayerGames(context.players[player.athlete_id]?.games);
  const filtered = filterRowsByLocation(allRows, view.historySplit ?? 'all');
  if (!filtered.length) return '';
  return `<section class="projection-card gamelog-panel" data-block="proj-log" aria-label="Recent game log">
      <div class="section-head">
        <h3 class="section-kicker">Game log</h3>
        <span class="meta-pill">last ${Math.min(20, filtered.length)} played</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Opp</th><th>Score</th><th>Min</th><th>${escapeHtml(marketShort(form.market))}</th><th>FG</th><th>3PT</th><th>FT</th><th>USG%</th><th>Result</th></tr></thead>
          <tbody data-gamelog-body>${gameLogRowsHtml(filtered, form, view.slate, context)}</tbody>
        </table>
      </div>
    </section>`;
}

function rankTone(rank: number, higherIsFavorable: boolean): 'fav' | 'mid' | 'tough' {
  if (higherIsFavorable) {
    if (rank >= 21) return 'fav';
    if (rank >= 11) return 'mid';
    return 'tough';
  }
  if (rank <= 10) return 'fav';
  if (rank <= 20) return 'mid';
  return 'tough';
}

function defenseAsideHtml(
  view: ProjectionView,
  game: SlateGame,
  player: RatePlayer,
  form: PropFormState,
  context: ProjectionContext,
): string {
  const teamSide = player.team_id === game.away.team_id ? game.away : game.home;
  const oppSide = player.team_id === game.away.team_id ? game.home : game.away;
  const oppDef = context.teams[oppSide.team_id];
  const teamDef = context.teams[teamSide.team_id];
  if (!oppDef) return '';

  const defKey = marketToDefenseKey(form.market);
  const defShort = form.market === 'dd' || form.market === 'td' ? 'PRA' : marketShort(form.market);
  const defaultSlot = positionToDefenseSlot(player.position_group || player.position);
  const activeSlot: DefenseSlot = view.defenseSlot ?? defaultSlot;
  const slotEntry = unpackTeamAllowed(oppDef, defKey, activeSlot);
  const allEntry = unpackTeamAllowed(oppDef, defKey, 'all');
  const [oppPace, oppPaceRank] = unpackRankedPair(oppDef.pace);

  const tabs = (
    [
      ['all', 'Overall'],
      ['G', 'vs G'],
      ['F', 'vs F'],
      ['C', 'vs C'],
    ] as const
  )
    .map(
      ([slot, label]) =>
        `<button type="button" class="slot-tab" data-defense-slot="${slot}" aria-pressed="${activeSlot === slot ? 'true' : 'false'}">${label}</button>`,
    )
    .join('');

  const slotLabel =
    activeSlot === 'G'
      ? 'Guards / game'
      : activeSlot === 'F'
        ? 'Forwards / game'
        : activeSlot === 'C'
          ? 'Centers / game'
          : `${defShort} allowed`;

  const slotRow =
    activeSlot === 'all'
      ? ''
      : `<div class="def-row"><span>${escapeHtml(slotLabel)}</span><span class="def-num">${slotEntry[0].toFixed(1)} <i class="rank-badge ${rankTone(slotEntry[1], true)}">${slotEntry[1]}</i></span></div>`;

  let paceCallout = '';
  if (teamDef) {
    const teamPace = unpackRankedPair(teamDef.pace)[0];
    const blendPace = (teamPace + oppPace) / 2;
    const diff = blendPace - teamPace;
    const cls = diff >= 0.3 ? 'edge-up' : diff <= -0.3 ? 'edge-down' : '';
    const dir = diff >= 0.3 ? 'Pace up' : diff <= -0.3 ? 'Pace down' : 'Neutral pace';
    paceCallout = `<div class="pace-box">
        <p class="pace-title"><strong class="${cls}">${dir} ${signedDelta(diff)}</strong></p>
        <p class="section-sub">${escapeHtml(sideAbbr(teamSide))} plays at ${teamPace.toFixed(1)} · ${escapeHtml(sideAbbr(oppSide))} at ${oppPace.toFixed(1)}</p>
      </div>`;
  }

  const perMin = computePerMinuteSummary(
    unpackPlayerGames(context.players[player.athlete_id]?.games),
    form.market,
    context.active_season,
  );
  const perMinCard = perMin
    ? `<section class="aside-block" data-block="proj-matchup" aria-label="Per minute rates">
        <div class="section-head">
          <h3 class="section-kicker">Per minute</h3>
          <span class="meta-pill">${escapeHtml(perMin.sampleLabel)}</span>
        </div>
        <table class="aside-table">
          <thead><tr><th>Stat</th><th>Avg</th><th>Median</th></tr></thead>
          <tbody>
            <tr><th scope="row">Usage rate</th><td>${perMin.usgAvg === null ? '—' : `${perMin.usgAvg.toFixed(1)}%`}</td><td>${perMin.usgMed === null ? '—' : `${perMin.usgMed.toFixed(1)}%`}</td></tr>
            <tr><th scope="row">${escapeHtml(marketShort(form.market))} / 36</th><td>${perMin.rate36Avg === null ? '—' : perMin.rate36Avg.toFixed(1)}</td><td>${perMin.rate36Med === null ? '—' : perMin.rate36Med.toFixed(1)}</td></tr>
            <tr><th scope="row">Minutes</th><td>${perMin.minAvg === null ? '—' : perMin.minAvg.toFixed(1)}</td><td>${perMin.minMed === null ? '—' : perMin.minMed.toFixed(1)}</td></tr>
          </tbody>
        </table>
      </section>`
    : '';

  return `<section class="aside-block" data-block="proj-matchup" aria-label="Opponent defense">
      <div class="section-head">
        <h3 class="section-kicker">Key ${escapeHtml(sideAbbr(oppSide))} ${escapeHtml(defShort)} defense</h3>
        <span class="meta-pill">${escapeHtml(context.defense_season_label)} · ${oppDef.games}g</span>
      </div>
      <div class="slot-tabs" role="group" aria-label="Position defense">${tabs}</div>
      <div class="def-list">
        ${slotRow}
        <div class="def-row"><span>All players / game</span><span class="def-num">${allEntry[0].toFixed(1)} <i class="rank-badge ${rankTone(allEntry[1], true)}">${allEntry[1]}</i></span></div>
        <div class="def-row"><span>Pace (poss / 48)</span><span class="def-num">${oppPace.toFixed(1)} <i class="rank-badge ${rankTone(oppPaceRank, false)}">${oppPaceRank}</i></span></div>
      </div>
      ${paceCallout}
      <p class="def-legend"><span><i class="dot fav"></i>Soft (21–30)</span><span><i class="dot mid"></i>Mid (11–20)</span><span><i class="dot tough"></i>Tough (1–10)</span></p>
    </section>${perMinCard}`;
}

function inlineDrawingHtml(progress?: number): string {
  const pct = Math.min(100, Math.max(0, Math.round((progress ?? 0) * 100)));
  return `<div class="projection-drawing" role="status" aria-live="polite">
      <div class="play-meter-label">
        <span data-projection-status>Simulating 10,000 games</span>
        <span class="play-meter-value" data-projection-pct>${pct}%</span>
      </div>
      <span class="play-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <span class="play-fill" data-projection-progress style="width:${pct}%"></span>
      </span>
    </div>`;
}

function detailHtml(view: ProjectionView, game: SlateGame, rate: RateGame): string {
  const player = rate.players.find((item) => item.athlete_id === view.athleteId) ?? null;
  if (!player || !view.athleteId) return '';
  const context = view.card.projection_context;
  const team = player.team_id === game.away.team_id ? game.away : game.home;
  const opponent = player.team_id === game.away.team_id ? game.home : game.away;
  const side = player.team_id === game.away.team_id ? 'away' : 'home';
  const url = playerHeadshotUrl({ athlete_id: player.athlete_id, headshot_url: player.headshot_url ?? null });
  const position = player.position.trim();
  const injury = player.injury_status.trim() || 'not in the data';
  const call = callFor(player.name, rate, view.overrides);
  const sample = view.simulation?.playerDraws.get(player.athlete_id) ?? null;
  const form = view.form.market === 'dd' || view.form.market === 'td' ? { ...view.form, line: '0.5' } : view.form;
  const results = view.simulation
    ? renderPropResults(view.simulation, player.athlete_id, form, player, view.record ?? null, view.propCalibration ?? null)
    : '<div class="prop-prompt"><p class="prop-prompt-title">Add a line and a price</p><p class="prop-note">The price comparison appears after this game is simulated.</p></div>';
  const l10Ready = l10HistoricalValues(context, player.athlete_id, form.market).length > 0;
  const posted = bookLineFor(view.lines, game.event_id, player.athlete_id, form.market);
  const historyHtml = context ? historyPanelHtml(view, game, player, form, context) : '';
  const onOffHtml = context ? onOffPanelHtml(rate, player, view.overrides, context, view.selectedTeammateId) : '';
  const logHtml = context ? gameLogPanelHtml(view, player, form, context) : '';

  const spotlight = view.simulation
    ? spotlightHtml(view.simulation, player.athlete_id, form.market)
    : view.drawing
      ? inlineDrawingHtml(view.drawProgress)
      : `<div class="projection-unrun"><p class="prop-note" data-projection-status>Not simulated yet.</p><button type="button" data-projection-rerun="${escapeHtml(game.event_id)}">Simulate 10,000 games</button></div>`;
  const means = view.simulation ? meansHtml(view.simulation, player.athlete_id) : '';
  return `<article class="projection-card projection-detail" data-block="proj-player">
      <div class="detail-top">
        <div class="who">
          ${photoHtml(player.name, url)}
          <div class="who-copy">
            <h2 class="who-name">${escapeHtml(player.name)}</h2>
            <p class="who-team">${escapeHtml(playerSideLine(game, side, sideName(team), sideName(opponent)))}</p>
            <p class="tip">${escapeHtml(formatTip(game.start_time))}</p>
            <p class="who-pos">${position ? `<span class="chip">${escapeHtml(position)}</span>` : ''}<span class="chip">${escapeHtml(injury)}</span>${call ? `<span class="chip">${escapeHtml(call)}</span>` : ''}</p>
            ${url ? '' : '<p class="photo-note">Photo is not in the data.</p>'}
          </div>
        </div>
        <button type="button" class="ghost detail-close" data-projection-close>Back to board</button>
      </div>
      <div class="detail-spotlight">
        <div class="detail-projection">${spotlight}</div>
        <div class="detail-chances" data-model-chances>${modelChanceHtml(sample, form.market, form.line)}</div>
      </div>
      <div class="detail-chart" data-projection-chart>${projectionChartHtml(sample, form.market, form.line)}</div>
      ${lineTools(form, Boolean(sample && playedValues(sample, form.market).length), l10Ready)}
      <section class="detail-price" aria-label="Check a price">
        <h3 class="section-kicker">Check a price</h3>
        <div class="projection-form">
          <div data-posted>${postedLineHtml(posted, form)}</div>
          ${propFormMarkup(form)}
          <div data-prop-results aria-live="polite">${results}</div>
          <div data-measured>${measuredNoteHtml(sample, form, view.record, view.propCalibration)}</div>
        </div>
      </section>
      <details class="detail-more">
        <summary>Full line, role and teammates</summary>
        ${means}
        ${factsHtml(player)}
        ${teammatesHtml(rate, player, view.overrides)}
      </details>
    </article>
    ${historyHtml}
    ${onOffHtml}
    ${logHtml}`;
}

export function searchHitsHtml(slate: Slate, card: RateCard, query: string): string {
  const needle = query.trim().toLowerCase();
  if (!needle) return '';
  const hits: string[] = [];
  for (const rate of card.games) {
    const game = slate.games.find((item) => item.event_id === rate.event_id);
    if (!game) continue;
    for (const player of rate.players) {
      if (!player.name.toLowerCase().includes(needle)) continue;
      hits.push(
        `<button type="button" class="ghost projection-hit" data-projection-player="${escapeHtml(player.athlete_id)}" data-projection-event="${escapeHtml(game.event_id)}"><span>${escapeHtml(player.name)}</span><span class="tip">${escapeHtml(`Away ${sideAbbr(game.away)} @ Home ${sideAbbr(game.home)} · ${placeLine(game)} · ${formatTip(game.start_time)}`)}</span></button>`,
      );
    }
  }
  if (!hits.length) return '<p class="prop-note">No player on this slate matches that search.</p>';
  return hits.join('');
}

/** The games across the top: every game at once, or one. A game whose draws are in this browser is marked ready. */
function gameStripHtml(view: ProjectionView, scope: BoardScope): string {
  const all = `<button type="button" class="game-chip" data-projection-all aria-pressed="${scope === 'all' ? 'true' : 'false'}"><span class="game-row-head"><span class="abbr">All games</span></span><span class="tip">${view.slate.games.length} on the slate</span></button>`;
  const chips = view.slate.games
    .map((item) => {
      const selected = scope === 'game' && item.event_id === view.eventId;
      const ready = view.readyEventIds?.has(item.event_id) ?? false;
      const status = statusLabel(item, view.now, view.slate.generated_at);
      const when = status === 'not started' ? clockText(item.start_time) : status === 'final' ? 'Final' : status === 'in progress' ? 'Live' : clockText(item.start_time);
      const title = `Away ${sideAbbr(item.away)} @ Home ${sideAbbr(item.home)} · ${placeLine(item)} · ${formatTip(item.start_time)}`;
      return `<button type="button" class="game-chip projection-game" data-projection-game="${escapeHtml(item.event_id)}" aria-pressed="${selected ? 'true' : 'false'}" title="${escapeHtml(title)}">
          <span class="game-row-head"><span class="chip-logos">${logoImg(item.away)}${logoImg(item.home)}</span><span class="abbr">${escapeHtml(`${sideAbbr(item.away)} @ ${sideAbbr(item.home)}`)}</span>${ready ? '<span class="ready-dot" title="10,000 simulations cached">10k ready</span>' : ''}</span>
          <span class="tip">${escapeHtml(when)}</span>
        </button>`;
    })
    .join('');
  return `<nav class="game-strip" aria-label="Games">${all}${chips}</nav>`;
}

/** The selected player's matchup rail: the opponent's defense at his position and his per-minute rates. */
function matchupAsideHtml(view: ProjectionView, game: SlateGame | null, rate: RateGame | null): string {
  const player = rate?.players.find((item) => item.athlete_id === view.athleteId) ?? null;
  if (!view.card.projection_context || !game || !player) return '';
  const form = view.form.market === 'dd' || view.form.market === 'td' ? { ...view.form, line: '0.5' } : view.form;
  const rail = defenseAsideHtml(view, game, player, form, view.card.projection_context);
  return rail ? `<aside class="projection-aside">${rail}</aside>` : '';
}

function points(value: number): string {
  const text = (value * 100).toFixed(1);
  return `${value >= 0 ? '+' : ''}${text} pp`;
}

function tierLabel(tier: Pick<TierRecord, 'lo' | 'hi'>): string {
  if (tier.lo === null) return 'below 0';
  const lo = Math.round(tier.lo * 100);
  return tier.hi === null ? `${lo}+` : `${lo} to ${Math.round(tier.hi * 100)}`;
}

/** The lean side's raw simulated share, when a fitted map moved it. */
function rawSideShare(lean: Pick<Lean, 'calibrationMethod' | 'modelRaw' | 'side'>): number | null {
  if (!lean.calibrationMethod || lean.modelRaw === undefined || !Number.isFinite(lean.modelRaw)) return null;
  return lean.side === 'over' ? lean.modelRaw : 1 - lean.modelRaw;
}

const CALIBRATION_GROUPS: readonly { group: PropCalibrationGroup; label: string }[] = [
  { group: 'points', label: 'points and point combos' },
  { group: 'rebAst', label: 'rebounds, assists and R+A' },
  { group: 'tpm', label: 'threes' },
  { group: 'defense', label: 'steals and blocks' },
];

export interface CalibrationStatus {
  artifacts: readonly PropCalibrationArtifact[];
  family: string | null;
}

/** Which stat groups the page shows calibrated, and how much each map helped on games it was not fitted on. */
export function calibrationStatusHtml(status: CalibrationStatus | null | undefined): string {
  if (!status) return '';
  const fitted = new Map(status.artifacts.filter((item) => item.status === 'fitted' && item.model_version === status.family).map((item) => [item.group, item]));
  if (!fitted.size) {
    return '<p class="prop-note" data-calibration-status>Model chances are the raw simulation. No prop calibration map has passed its check on later games yet.</p>';
  }
  const parts = CALIBRATION_GROUPS.map(({ group, label }) => {
    const item = fitted.get(group);
    if (!item) return `${label} raw until enough lines settle`;
    const raw = item.metrics_raw?.logLoss;
    const gain = raw !== undefined && Number.isFinite(raw) ? `, log loss ${raw.toFixed(3)} to ${item.metrics_validated.logLoss.toFixed(3)}` : '';
    return `${label} calibrated (checked on ${item.rows_validated.toLocaleString('en-US')} later lines${gain})`;
  });
  const weight = Math.round(([...fitted.values()][0]?.w ?? 0) * 100);
  return `<p class="prop-note" data-calibration-status>Prop calibration: ${escapeHtml(parts.join('; '))}. A calibrated chance is the simulation moved by a map fitted on earlier settled lines, then weighed ${weight}% against the no-vig price.</p>`;
}

function leanRowHtml(lean: RankedLean): string {
  const side = lean.side === 'over' ? 'Over' : 'Under';
  const odds = lean.side === 'over' ? lean.over_odds : lean.under_odds;
  const modelWidth = Math.max(0, Math.min(100, lean.model * 100)).toFixed(1);
  const needAt = Math.max(0, Math.min(100, lean.need * 100)).toFixed(1);
  return `<li><button type="button" class="lean-row" data-projection-player="${escapeHtml(lean.athlete_id)}" data-projection-event="${escapeHtml(lean.event_id)}" data-lean-market="${escapeHtml(lean.market)}" data-lean-side="${lean.side}">
      <span class="lean-head">
        <span class="lean-face">${avatarMarkup(lean.name, lean.athlete_id)}</span>
        <span class="lean-id"><span class="lean-name">${escapeHtml(lean.name)}</span><span class="lean-call">${side} ${escapeHtml(lineText(lean.line))} ${escapeHtml(marketShort(lean.market))} <small>${escapeHtml(americanText(odds))}</small></span></span>
        <span class="lean-pct" data-side="${lean.side}">${escapeHtml(percent(lean.model))}</span>
      </span>
      <span class="lean-meter" aria-hidden="true"><span class="lean-meter-fill" data-side="${lean.side}" style="width:${modelWidth}%"></span><span class="lean-meter-need" style="left:${needAt}%"></span></span>
      <span class="lean-meta">${escapeHtml(lean.matchup)} · projection ${lean.projection.toFixed(1)} in ${lean.minutes.toFixed(0)} min${lean.play < 0.9 ? ` · plays in ${escapeHtml(percent(lean.play))} of simulations, and a sit-out voids the line` : ''}</span>
      <span class="lean-odds">Model ${escapeHtml(percent(lean.model))}${rawSideShare(lean) !== null ? ` calibrated, ${escapeHtml(percent(rawSideShare(lean)!))} in the raw simulation` : ''} · price needs ${escapeHtml(percent(lean.need))}${lean.also ? ` · ${lean.also} more of his lines ${lean.also === 1 ? 'leans' : 'lean'} ${lean.side}` : ''}</span>
    </button></li>`;
}

function leanColumnHtml(title: string, side: 'over' | 'under', rows: readonly RankedLean[], count: number, players: number): string {
  let body: string;
  if (rows.length) {
    const more = players > rows.length ? `<p class="prop-note">${count} ${side} leans across ${players} players clear the bar. Each player's strongest is shown for the first ${rows.length}; the board for a game has the rest.</p>` : '';
    body = `<ul>${rows.map((row) => leanRowHtml(row)).join('')}</ul>${more}`;
  } else {
    body = `<p class="prop-note">No ${side} lean clears the bar right now.</p>`;
  }
  return `<div><h3>${title}</h3>${body}</div>`;
}

function shortDate(iso: string | null): string {
  if (!iso) return '';
  const [, month, day] = iso.split('-');
  return `${Number(month)}/${Number(day)}`;
}

export function recordHtml(record: PickRecord | null | undefined): string {
  if (!record || !record.settled) {
    return '<details class="lean-record"><summary>Record</summary><p class="prop-note">No lean has been graded yet. Each one is logged before its game tips and graded from the final box score.</p></details>';
  }
  const liveTiers = record.tiersLive;
  const rows = liveTiers?.length
    ? liveTiers
      .filter((tier) => tier.n > 0)
      .map((tier) => {
        const hit = tier.wins / tier.n;
        const raw = hit - tier.need;
        return `<tr>
          <th scope="row">${tier.side === 'over' ? 'Over' : 'Under'}</th>
          <td>${escapeHtml(tierLabel(tier))}</td>
          <td>${tier.n.toLocaleString('en-US')}</td>
          <td>${escapeHtml(percent(hit))}</td>
          <td>${escapeHtml(percent(tier.need))}</td>
          <td class="${raw > 0 ? 'edge-up' : raw < 0 ? 'edge-down' : ''}">${escapeHtml(points(raw))}</td>
          <td class="${tier.units > 0 ? 'edge-up' : tier.units < 0 ? 'edge-down' : ''}">${tier.units >= 0 ? '+' : ''}${tier.units.toFixed(1)}</td>
          <td class="${tier.lo !== null && tier.lo >= EXTREME_CLAIM ? '' : tier.edge > 0 ? 'edge-up' : 'edge-down'}">${tier.lo !== null && tier.lo >= EXTREME_CLAIM ? 'never listed' : escapeHtml(points(tier.edge))}</td>
        </tr>`;
      })
      .join('')
    : '';
  const table = liveTiers?.length
    ? `<div class="table-scroll"><table class="record-table">
        <thead><tr><th>Side</th><th title="Model chance of the side minus the break-even of its price, in probability points">Claimed edge</th><th>Graded</th><th>Hit</th><th title="Average break-even of the posted prices">Needed</th><th title="Hit rate minus the break-even needed">Against price</th><th title="Profit at the posted prices, one unit a lean">Units</th><th title="Pooled so it never falls as the claim grows, then pulled toward the side's overall result">Measured</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : '<p class="prop-note">Nothing is listed.</p>';
  const liveCount = record.live.over.n + record.live.under.n;
  const replayCount = record.replayed.over.n + record.replayed.under.n;
  const span = (totals: PickRecord['live']) => (totals.from && totals.through ? ` (${shortDate(totals.from)} to ${shortDate(totals.through)})` : '');
  const sources = [
    replayCount ? `${replayCount.toLocaleString('en-US')} were rebuilt from archived pre-tip inputs with the current model${span(record.replayed)}` : '',
    `${liveCount.toLocaleString('en-US')} were logged live before the tip${span(record.live)}`,
  ].filter(Boolean).join('. ');
  const moved = record.moves.toward + record.moves.away;
  const held = record.moves.same_line
    ? ` On ${record.moves.same_line.toLocaleString('en-US')} more the line held and the no-vig price moved ${escapeHtml(points(record.moves.price_toward / record.moves.same_line))} toward the lean on average.`
    : '';
  const moves = moved || record.moves.same_line
    ? `<p class="prop-note">${moved ? `After a lean was logged, the posted line later moved on ${moved.toLocaleString('en-US')} props, ${escapeHtml(percent(record.moves.toward / moved))} of them toward the lean.` : ''}${held} The later price is the last one posted before the tip, not a confirmed closing line.</p>`
    : '';
  const days = record.days.length
    ? `<p class="prop-note">Last ${record.days.length} graded days, leans the price did not already beat: ${record.days.map((day) => `${shortDate(day.date)} ${day.wins}-${day.n - day.wins}`).join(' · ')}</p>`
    : '';
  return `<details class="lean-record">
      <summary>Record: ${record.settled.toLocaleString('en-US')} graded leans</summary>
      <p class="prop-note">Every posted over/under line is logged with the model's side before the game tips, then graded from the final box score at the price it was logged with. ${escapeHtml(sources)}. The table is the live record the list uses, and replayed days stay in the totals above it. A player who sits voids the line (${record.voids.toLocaleString('en-US')} so far).</p>
      ${table}
      ${moves}
      ${days}
    </details>`;
}

export interface LeanPanelInput {
  leans: readonly Lean[];
  waiting: number;
  record: PickRecord | null | undefined;
  book: string | null | undefined;
  /** Whether any posted line exists for a game that has not started. */
  open: boolean;
  /** Whether any posted line exists on the slate at all. */
  posted: boolean;
  /** Published prop maps, for the line that says which stats are calibrated. */
  calibration?: CalibrationStatus | null;
}

export function leanPanelInner(input: LeanPanelInput): string {
  const head = '<div class="leans-head"><h2>Top leans</h2><p class="section-sub">The model\'s side at posted lines for games that have not started. The bar is the model chance; the tick is what the price needs.</p></div>';
  if (!input.posted) {
    return `${head}<p class="prop-note">No posted line is in for this slate yet. They usually arrive late morning Central, and this list fills at the next refresh.</p>`;
  }
  if (!input.open) {
    return `${head}<p class="prop-note">Every game with a posted line has started. Leans are logged before the tip and graded after the final.</p>`;
  }
  const board = rankLeans(input.leans, input.record);
  const waiting = input.waiting
    ? `<p class="section-sub">${input.waiting} ${input.waiting === 1 ? 'game is' : 'games are'} still simulating.</p>`
    : '';
  return `${head}${waiting}<div class="lean-columns">${leanColumnHtml('Under', 'under', board.listed.under, board.counts.under, board.players.under)}${leanColumnHtml('Over', 'over', board.listed.over, board.counts.over, board.players.over)}</div>`;
}

/** The settled-leans paragraph used to sit under a priced line. The page no longer prints it. */
export function measuredNoteHtml(
  sample: PlayerSample | null,
  form: PropFormState,
  record: PickRecord | null | undefined,
  calibration?: PropPanelCalibration | null,
): string {
  void sample;
  void form;
  void record;
  void calibration;
  return '';
}

export function postedLineHtml(book: BookLine | null, form: PropFormState): string {
  if (!book) return '';
  const using = validPropLine(form.line) === book.line;
  const opened = book.open_line != null && book.open_line !== book.line ? ` Opened ${escapeHtml(lineText(book.open_line))}.` : '';
  return `<p class="prop-note posted-line" data-posted-line>${escapeHtml(book.book)} has ${escapeHtml(lineText(book.line))} at over ${escapeHtml(americanText(book.over_odds))}, under ${escapeHtml(americanText(book.under_odds))}, priced ${escapeHtml(formatTip(book.priced_at))}.${opened}${using ? '' : ' <button type="button" class="ghost mini-action" data-use-posted>Use the posted line</button>'}</p>`;
}

function injuryReportHtml(rate: RateGame, game: SlateGame): string {
  const sides = [
    { id: game.away.team_id, label: sideAbbr(game.away) },
    { id: game.home.team_id, label: sideAbbr(game.home) },
  ];
  const blocks = sides
    .map((side) => {
      const players = rate.players
        .filter((player) => {
          const status = player.injury_status.trim().toLowerCase();
          return player.team_id === side.id && !player.replacement_level && status !== '' && status !== 'healthy';
        })
        .sort((a, b) => Number(b.minutes_weight === 0) - Number(a.minutes_weight === 0) || a.name.localeCompare(b.name));
      if (!players.length) return '';
      const items = players
        .map((player) => {
          const when = player.injury_reported_at ? formatTip(player.injury_reported_at) : '';
          const cap = player.minutes_restriction != null ? `Minutes cap ${player.minutes_restriction}` : '';
          const meta = [player.injury_status, when, cap].filter(Boolean).join(' · ');
          const note = player.injury_note?.trim()
            ? `<span class="injury-note">${escapeHtml(player.injury_note.trim())}</span>`
            : '';
          return `<li class="injury-row"><strong>${escapeHtml(player.name)}</strong><span class="injury-meta">${escapeHtml(meta)}</span>${note}</li>`;
        })
        .join('');
      return `<div><p class="stat-group-label">${escapeHtml(side.label)}</p><ul>${items}</ul></div>`;
    })
    .join('');
  const body = blocks || '<p class="prop-note">No one on this card is on the injury report.</p>';
  return `<section class="injury-report" aria-label="Injury report"><h3>Injury report</h3><p class="section-sub">Designations on the published card. The simulator already sits players from this report.</p>${body}</section>`;
}

/** Games that have not started and have at least one posted line: the only games a lean can be logged for. */
export function openLeanEvents(slate: Slate, lines: ReadonlyMap<string, BookLine> | undefined, now: Date): Set<string> {
  const open = new Set<string>();
  if (!lines) return open;
  const priced = new Set<string>();
  for (const line of lines.values()) priced.add(line.event_id);
  for (const game of slate.games) {
    if (priced.has(game.event_id) && game.status_state === 'pre' && Date.parse(game.start_time) > now.getTime()) open.add(game.event_id);
  }
  return open;
}

export function leanPanelHtml(
  view: Pick<ProjectionView, 'slate' | 'now' | 'lines' | 'leans' | 'leansWaiting' | 'record' | 'book'> & { calibration?: CalibrationStatus | null },
): string {
  return leanPanelInner({
    leans: view.leans ?? [],
    waiting: view.leansWaiting ?? 0,
    record: view.record,
    book: view.book,
    open: openLeanEvents(view.slate, view.lines, view.now).size > 0,
    posted: (view.lines?.size ?? 0) > 0,
    calibration: view.calibration ?? null,
  });
}

function modeSwitchHtml(mode: ProjectionMode): string {
  const buttons = PROJECTION_MODES.map((item) => `<button type="button" data-proj-mode="${item.value}" aria-pressed="${item.value === mode ? 'true' : 'false'}">${item.label}</button>`).join('');
  return `<div class="proj-modes" role="group" aria-label="Projections view">${buttons}</div>`;
}

function introHtml(mode: ProjectionMode): string {
  const note =
    mode === 'defense'
      ? 'How tonight\'s defenses hold each position. Pick a stat, then tap a number for the players in that matchup.'
      : 'Every player, 10,000 simulated games. Pick a stat, then tap a player for the full breakdown.';
  return `<header class="projection-intro">
        <div class="projection-titles">
          <h2>Projections</h2>
          <p class="projection-note">${note}</p>
        </div>
      </header>
      ${modeSwitchHtml(mode)}`;
}

export function renderProjections(view: ProjectionView): string {
  const mode = view.mode ?? 'players';
  if (mode === 'defense') {
    return `<div class="projection-page" data-proj-view="defense">
      ${introHtml(mode)}
      <div class="projection-controls">${marketPills(view.form, null, [])}</div>
      ${defenseModeHtml(view)}
    </div>`;
  }
  const scope: BoardScope = view.scope ?? (view.eventId ? 'game' : 'all');
  const game = view.slate.games.find((item) => item.event_id === view.eventId) ?? null;
  const rate = view.card.games.find((item) => item.event_id === view.eventId) ?? null;
  const detail = game && rate ? detailHtml(view, game, rate) : '';
  const boardMeter = view.drawing && !view.athleteId && scope === 'game' ? inlineDrawingHtml(view.drawProgress) : '';
  const stat = marketLabel(view.form.market);
  const title = scope === 'game' && game ? `${stat} · ${sideAbbr(game.away)} @ ${sideAbbr(game.home)}` : `${stat} · every game`;
  const injuries = scope === 'game' && game && rate ? injuryReportHtml(rate, game) : '';
  const board =
    scope === 'all' || (game && rate)
      ? `${boardMeter}<section class="team-box projection-board" data-block="proj-board"><div class="board-head"><h2>${escapeHtml(title)}</h2></div><div data-projection-board>${boardInnerHtml({ ...view, scope })}</div>${injuries}</section>`
      : '<p class="state">Pick a game above, or search a player. Historical trends load right away, and 10,000 simulations warm in the background.</p>';
  const aside = matchupAsideHtml(view, game, rate);
  const present = `${detail}${board}${aside}`;
  const toggles = (
    [
      ['proj-leans', 'Leans'],
      ['proj-player', 'Player'],
      ['proj-history', 'History'],
      ['proj-onoff', 'Floor share'],
      ['proj-log', 'Game log'],
      ['proj-board', 'Board'],
      ['proj-matchup', 'Matchup'],
    ] as const
  ).filter((row) => row[0] === 'proj-leans' || present.includes(`data-block="${row[0]}"`))
    .map(([id, label]) => ({ id, label }));
  const selected = rate?.players.find((item) => item.athlete_id === view.athleteId) ?? null;
  const sample = selected ? view.simulation?.playerDraws.get(selected.athlete_id) ?? null : null;
  const history = selected && view.card.projection_context ? unpackPlayerGames(view.card.projection_context.players[selected.athlete_id]?.games) : [];
  return `<div class="projection-page" data-proj-view="players">
      ${introHtml(mode)}
      ${gameStripHtml(view, scope)}
      <div class="projection-controls">
        ${marketPills(view.form, sample, history)}
        <label class="field projection-search"><span class="field-label">Find a player</span><input data-projection-search type="search" value="${escapeHtml(view.query)}" placeholder="Search a player on the slate" autocomplete="off"></label>
      </div>
      <div data-projection-hits class="projection-hits">${searchHitsHtml(view.slate, view.card, view.query)}</div>
      <details class="section-picker"><summary>Sections</summary>${viewToggles(toggles)}</details>
      <div class="projection-layout${aside ? '' : ' is-wide'}">
        <div class="projection-main">
          ${detail}
          <section class="model-sides" data-model-sides data-block="proj-leans" aria-label="Leans against the posted lines">${leanPanelHtml(view)}</section>
          ${board}
        </div>
        ${aside}
      </div>
    </div>`;
}

// Re-export medianOf for convenience in tests and controls.
export { medianOf };
