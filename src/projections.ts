import { historyBarsSvg, propBarsSvg, type HistoryBarPoint } from './charts.ts';
import { formatTip } from './date.ts';
import { playerHeadshotUrl } from './display.ts';
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
  type TeammateSplit,
} from './projection-context.ts';
import { gradeProp, parseBookPrice, quoteProp, valueAt, type PlayerSample, type PropMarket } from './props.ts';
import type { Simulation } from './simulate.ts';
import { escapeHtml, statusLabel } from './slate.ts';
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
export type BoardSort = 'projection' | 'over' | 'under';
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
  /** Simulations already cached, keyed by event id. Absent games are still warming up. */
  cachedSimulations?: ReadonlyMap<string, Simulation>;
}

export function isPropMarket(value: string): value is PropMarket {
  return MARKETS.some((market) => market.value === value);
}

export function isHistorySplit(value: string): value is HistorySplit {
  return value === 'all' || value === 'home' || value === 'away';
}

export function isBoardSort(value: string): value is BoardSort {
  return value === 'projection' || value === 'over' || value === 'under';
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

export function playedValues(sample: PlayerSample, market: PropMarket): number[] {
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

/** Expected minutes across every draw, including the games a player sits. */
function expectedMinutes(sample: PlayerSample): number {
  if (!sample.min.length) return 0;
  let total = 0;
  for (let index = 0; index < sample.min.length; index += 1) {
    const minutes = sample.min[index];
    if (minutes > 0) total += minutes;
  }
  return total / sample.min.length;
}

/**
 * A near-zero stat at a 0.5 hook is an almost automatic under, which is not a prop.
 * Rotation minutes and a real per-game average are required before a rate is shown or ranked.
 */
const ROTATION_MINUTES = 10;
const STAT_FLOOR: Record<PropMarket, number> = {
  pts: 4,
  reb: 2,
  ast: 1.5,
  pra: 8,
  pa: 6,
  pr: 6,
  ra: 3.5,
  tpm: 0.8,
  stl: 0.4,
  blk: 0.3,
  tov: 0.7,
  dd: 0.25,
  td: 0.08,
};
/** Median hook below this means the typical game is empty, even if a few outliers pull the average up. */
const LINE_FLOOR: Record<PropMarket, number> = {
  pts: 4.5,
  reb: 1.5,
  ast: 1.5,
  pra: 7.5,
  pa: 5.5,
  pr: 5.5,
  ra: 2.5,
  tpm: 0.5,
  stl: 0.5,
  blk: 0.5,
  tov: 0.5,
  dd: 0.5,
  td: 0.5,
};

export function propEligible(sample: PlayerSample, market: PropMarket): boolean {
  if (statMissing(sample, market)) return false;
  if (expectedMinutes(sample) < ROTATION_MINUTES) return false;
  const values = playedValues(sample, market);
  const mean = playedMean(values);
  if (mean === null || mean < STAT_FLOOR[market]) return false;
  return naturalHookLine(market, values) >= LINE_FLOOR[market];
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

/** Nearest .5 hook to the median of the values (never a whole integer, so pushes do not distort prop rates). */
export function naturalHookLine(market: PropMarket, values: ArrayLike<number>): number {
  if (market === 'dd' || market === 'td') return 0.5;
  const nums: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) nums.push(value);
  }
  if (!nums.length) return 0.5;
  nums.sort((a, b) => a - b);
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return Math.max(0.5, Math.ceil(median) - 0.5);
}

export function defaultMarketLine(
  market: PropMarket,
  sample: PlayerSample | null,
  context: ProjectionContext | undefined,
  athleteId: string | null,
): number | null {
  if (market === 'dd' || market === 'td') return 0.5;
  if (sample && !statMissing(sample, market)) {
    const values = playedValues(sample, market);
    if (values.length) return naturalHookLine(market, values);
  }
  const recent = l10HistoricalValues(context, athleteId, market);
  if (recent.length) return naturalHookLine(market, recent);
  return null;
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
  const line = validPropLine(lineRaw);
  if (line === null || ((market === 'dd' || market === 'td') && line !== 0.5)) {
    return '<p class="prop-note">Enter a whole or half-point line to see the over and under model chances.</p>';
  }
  const pair = chancePair(sample, market, line);
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

function edgeText(sample: PlayerSample, market: PropMarket, form: PropFormState, line: number): string {
  const price = parseBookPrice(form.odds, form.style);
  if (!price) return '';
  // The prop analyzer withholds the whole quote when the opposite price is filled in but illegal.
  // An empty opposite still has an edge. A valid opposite still has an edge.
  if (form.opposite.trim() !== '' && !parseBookPrice(form.opposite, form.style)) return '';
  const quote = quoteProp(sample, market, form.side, line, price, null);
  if (!quote || quote.edge === null || quote.breakEven === null || quote.expectedReturn === null) return '';
  return signedEdge(quote.edge);
}

function hitToneClass(rate: number | null): string {
  if (rate === null) return 'tone-muted';
  if (rate >= 0.6) return 'tone-good';
  if (rate >= 0.45) return 'tone-mid';
  return 'tone-low';
}

function compactHitCell(rows: readonly PlayerGameRow[], form: PropFormState, line: number | null, take?: number): string {
  if (line === null || !rows.length) return '<td class="board-hit-cell">—</td>';
  const valid = rows.filter((r) => historicalStatValue(r, form.market) !== null);
  const sample = take === undefined ? valid : valid.slice(-take);
  const grade = gradeHistoricalSeries(sample, form.market, form.side, line);
  if (grade.decided === 0) return '<td class="board-hit-cell">—</td>';
  const pct = Math.round((grade.rate ?? 0) * 100);
  return `<td class="board-hit-cell"><span class="hit-chip ${hitToneClass(grade.rate)}"><strong>${pct}%</strong><small>${grade.wins}/${grade.decided}</small></span></td>`;
}

interface BoardRow {
  athleteId: string;
  name: string;
  minutes: number;
  projection: number | null;
  line: number | null;
  over: string;
  under: string;
  overRate: number | null;
  underRate: number | null;
  edge: string;
  note: string | null;
  games: PlayerGameRow[];
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

function boardRows(
  game: RateGame,
  simulation: Simulation | null,
  form: PropFormState,
  athleteId: string | null,
  context: ProjectionContext | undefined,
  sort: BoardSort,
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
    const ownLine = sample || context ? defaultMarketLine(form.market, sample, context, player.athlete_id) : null;
    const rowLine = player.athlete_id === athleteId ? validViewer ?? ownLine : ownLine;
    let over = '';
    let under = '';
    let overRate: number | null = null;
    let underRate: number | null = null;
    let edge = '';
    if (sample && rowLine !== null && !missing && projection !== null && propEligible(sample, form.market)) {
      const pair = chancePair(sample, form.market, rowLine);
      overRate = pair?.over ?? null;
      underRate = pair?.under ?? null;
      over = overRate === null ? '' : percent(overRate);
      under = underRate === null ? '' : percent(underRate);
      edge = edgeText(sample, form.market, form, rowLine);
    }
    const games = context ? unpackPlayerGames(context.players[player.athlete_id]?.games) : [];
    return {
      athleteId: player.athlete_id,
      name: player.name,
      minutes: player.minutes_mean,
      projection,
      line: projection === null && simulation ? null : rowLine,
      over,
      under,
      overRate,
      underRate,
      edge,
      note,
      games,
    };
  });
  if (sort === 'over' && simulation) {
    rows.sort(byRate('overRate'));
    return rows;
  }
  if (sort === 'under' && simulation) {
    rows.sort(byRate('underRate'));
    return rows;
  }
  if (!simulation) {
    rows.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
    return rows;
  }
  rows.sort((a, b) => {
    if (a.projection === null && b.projection === null) return a.name.localeCompare(b.name);
    if (a.projection === null) return 1;
    if (b.projection === null) return -1;
    return b.projection - a.projection || a.name.localeCompare(b.name);
  });
  return rows;
}

export function projectionBoardHtml(
  game: RateGame,
  simulation: Simulation | null,
  form: PropFormState,
  eventId: string,
  athleteId: string | null,
  context?: ProjectionContext,
  sort: BoardSort = 'projection',
): string {
  const rows = boardRows(game, simulation, form, athleteId, context, sort);
  const hasHistory = Boolean(context);
  const line = validPropLine(form.line);
  const gradedLine = line !== null && !((form.market === 'dd' || form.market === 'td') && line !== 0.5) ? line : null;
  const sideText = form.side === 'under' ? 'Under' : 'Over';
  const body = rows
    .map((row) => {
      const selected = row.athleteId === athleteId;
      const projection = row.note ?? (row.projection === null ? '' : row.projection.toFixed(1));
      const lineCell = row.line === null ? '' : Number.isInteger(row.line) ? row.line.toFixed(1) : String(row.line);
      const historyCols = hasHistory
        ? `${compactHitCell(row.games, form, row.line, 5)}${compactHitCell(row.games, form, row.line, 10)}${compactHitCell(row.games.filter((gameRow) => gameRow.home), form, row.line)}${compactHitCell(row.games.filter((gameRow) => !gameRow.home), form, row.line)}`
        : '';
      return `<tr${selected ? ' class="is-selected"' : ''}>
        <th scope="row"><button type="button" class="projection-player" data-projection-player="${escapeHtml(row.athleteId)}" data-projection-event="${escapeHtml(eventId)}" aria-pressed="${selected ? 'true' : 'false'}">${escapeHtml(row.name)}</button></th>
        <td>${escapeHtml(projection)}</td>
        <td>${escapeHtml(lineCell)}</td>
        ${historyCols}
        <td>${row.over}</td>
        <td>${row.under}</td>
        <td>${row.edge ? escapeHtml(row.edge) : ''}</td>
      </tr>`;
    })
    .join('');
  const pickPrompt = !athleteId
    ? '<p class="panel-lede">Pick any player below to run 10,000 simulations and load their game log, hit windows, and on/off floor splits.</p>'
    : '';
  const waiting = simulation ? '' : '<p class="panel-lede">Projection, over, under, and edge stay blank until this game is simulated.</p>';
  const lineBadge = simulation
    ? `<p class="board-grade-note">${gradedLine !== null ? `Selected player graded at <strong>${sideText} ${gradedLine}</strong>. ` : ''}Every other line is the half-point under that player's simulated median, not a book number. Over and Under are the share of the 10,000 draws in which the player played. A player under 10 expected minutes, or whose average for this stat is near zero, is left blank so a 0.5 under is not treated as a lock.</p>`
    : '';
  const hitHead = hasHistory
    ? `<th title="${sideText} hit rate in the last 5 box scores">L5</th><th title="${sideText} hit rate in the last 10 box scores">L10</th><th title="${sideText} hit rate in every stored home game">Home</th><th title="${sideText} hit rate in every stored away game">Away</th>`
    : '';
  const sortBar = `<div class="mini-tabs board-sort" role="group" aria-label="Order the board">
      <button type="button" class="mini-tab" data-board-sort="projection" aria-pressed="${sort === 'projection' ? 'true' : 'false'}">Projection</button>
      <button type="button" class="mini-tab" data-board-sort="over" aria-pressed="${sort === 'over' ? 'true' : 'false'}">Highest over</button>
      <button type="button" class="mini-tab" data-board-sort="under" aria-pressed="${sort === 'under' ? 'true' : 'false'}">Highest under</button>
    </div>`;
  return `${pickPrompt}${waiting}${sortBar}${lineBadge}<div class="table-scroll"><table>
      <thead><tr><th>Player</th><th>Projection</th><th>Line</th>${hitHead}<th>Over</th><th>Under</th><th>Edge</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
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

function playedBlock(simulation: Simulation, athleteId: string, market: PropMarket): string {
  const line = simPlayer(simulation, athleteId);
  const played = line?.expectation?.played ?? null;
  const sample = simulation.playerDraws.get(athleteId) ?? null;
  if (!played || !sample) {
    return '<p class="prop-note">This player does not play in the simulations.</p>';
  }
  const share = line?.expectation ? `${(line.expectation.playRate * 100).toFixed(1)}%` : '—';
  const width = line?.expectation ? Math.max(0, Math.min(100, line.expectation.playRate * 100)).toFixed(1) : '0';
  const values = statMissing(sample, market) ? [] : playedValues(sample, market);
  const mean = playedMean(values);
  const headline = statMissing(sample, market)
    ? '<p class="prop-note">This stat is missing from the older card.</p>'
    : mean === null
      ? '<p class="prop-note">This player does not play in the simulations.</p>'
      : `<p class="projection-headline"><span class="stat-group-label">${escapeHtml(marketLabel(market))} · 10k projection</span><span class="projection-value">${mean.toFixed(1)}</span></p>`;
  return `${headline}
    <div class="play-meter"><p class="play-meter-label"><span>Simulated play share</span><span class="play-meter-value">${share}</span></p><span class="play-track" aria-hidden="true"><span class="play-fill" style="width:${width}%"></span></span></div>
    <p class="panel-lede">Means from the draws this player actually played.</p>
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
  const line = validPropLine(form.line);
  const graded = line !== null && !((form.market === 'dd' || form.market === 'td') && line !== 0.5) ? line : null;
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
  const line = validPropLine(form.line);
  const graded = line !== null && !((form.market === 'dd' || form.market === 'td') && line !== 0.5) ? line : null;
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
  return `<section class="projection-card history-panel" aria-label="Historical game record">
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
  const intro = `<p class="section-copy">Usage is the share of his team's plays he finishes — a shot, a free-throw trip, or a turnover — counted over the reconstructed minutes he is on the court. Across these ${onOff.games} games (${totalMin} min) it is <strong>${totalUsg.toFixed(1)}%</strong>.</p>`;
  if (!activeSplit) {
    return `<section class="projection-card onoff-panel" aria-label="On and off court usage">
        <div class="section-head">
          <h3 class="section-kicker">Who he shares the floor with</h3>
          <span class="meta-pill">${onOff.games} games with rebuilt lineups · ${escapeHtml(onOff.season_label)}</span>
        </div>
        ${intro}
        <p class="prop-note">A teammate split needs at least 20 reconstructed minutes both on and off the court.</p>
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

  return `<section class="projection-card onoff-panel" aria-label="On and off court usage">
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
        <p class="field-hint">Min is reconstructed minutes shared and apart. P/36 is points per 36 on-court minutes. A split needs 20 minutes on each side before it appears.</p>
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
      return `<tr>
          <th scope="row">${escapeHtml(shortCalendarDate(row.date))}</th>
          <td>${row.home ? 'vs ' : '@ '}${escapeHtml(oppAbbr)}</td>
          <td>${outcome} ${row.teamPts}-${row.oppPts}</td>
          <td>${row.min.toFixed(0)}</td>
          <td class="log-stat">${escapeHtml(valText)}</td>
          <td>${row.fgm}-${row.fga}</td>
          <td>${row.tpm}-${row.tpa}</td>
          <td>${row.ftm}-${row.fta}</td>
          <td>${row.usg === null ? '—' : `${row.usg.toFixed(1)}%`}</td>
          <td>${resCell}</td>
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
  return `<section class="projection-card gamelog-panel" aria-label="Recent game log">
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
    ? `<section class="aside-block" aria-label="Per minute rates">
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

  return `<section class="aside-block" aria-label="Opponent defense">
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
  const rows = context ? unpackPlayerGames(context.players[player.athlete_id]?.games) : [];
  const team = player.team_id === game.away.team_id ? game.away : game.home;
  const opponent = player.team_id === game.away.team_id ? game.home : game.away;
  const place = player.team_id === game.away.team_id ? 'at' : 'vs';
  const url = playerHeadshotUrl({ athlete_id: player.athlete_id, headshot_url: player.headshot_url ?? null });
  const position = player.position.trim();
  const injury = player.injury_status.trim() || 'not in the data';
  const call = callFor(player.name, rate, view.overrides);
  const sample = view.simulation?.playerDraws.get(player.athlete_id) ?? null;
  const form = view.form.market === 'dd' || view.form.market === 'td' ? { ...view.form, line: '0.5' } : view.form;
  const results = view.simulation
    ? renderPropResults(view.simulation, player.athlete_id, form, player)
    : '<div class="prop-prompt"><p class="prop-prompt-title">Add a line and a price</p><p class="prop-note">The price comparison appears after this game is simulated.</p></div>';
  const l10Ready = l10HistoricalValues(context, player.athlete_id, form.market).length > 0;
  const historyHtml = context ? historyPanelHtml(view, game, player, form, context) : '';
  const onOffHtml = context ? onOffPanelHtml(rate, player, view.overrides, context, view.selectedTeammateId) : '';
  const logHtml = context ? gameLogPanelHtml(view, player, form, context) : '';

  return `<article class="projection-card projection-detail">
      <div class="who">
        ${photoHtml(player.name, url)}
        <div class="who-copy">
          <h2 class="who-name">${escapeHtml(player.name)}</h2>
          <p class="who-team">${escapeHtml(sideName(team))} ${place} ${escapeHtml(sideName(opponent))}</p>
          <p class="tip">${escapeHtml(formatTip(game.start_time))}</p>
          <p class="who-pos">${position ? `<span class="chip">${escapeHtml(position)}</span>` : ''}<span class="chip">${escapeHtml(injury)}</span>${call ? `<span class="chip">${escapeHtml(call)}</span>` : ''}</p>
          ${url ? '' : '<p class="photo-note">Photo is not in the data.</p>'}
        </div>
      </div>
      ${factsHtml(player)}
      ${teammatesHtml(rate, player, view.overrides)}
      ${marketPills(form, sample, rows)}
      ${
        view.simulation
          ? playedBlock(view.simulation, player.athlete_id, form.market)
          : view.drawing
            ? inlineDrawingHtml(view.drawProgress)
            : `<div class="projection-unrun"><p class="prop-note" data-projection-status>Not simulated yet.</p><button type="button" data-projection-rerun="${escapeHtml(game.event_id)}">Simulate 10,000 games</button></div>`
      }
      ${lineTools(form, Boolean(sample && playedValues(sample, form.market).length), l10Ready)}
      <div class="projection-form">
        ${propFormMarkup(form)}
        <div data-model-chances>${modelChanceHtml(sample, form.market, form.line)}</div>
        <div data-prop-results aria-live="polite">${results}</div>
        <div data-projection-chart>${projectionChartHtml(sample, form.market, form.line)}</div>
      </div>
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
      const team = player.team_id === game.away.team_id ? game.away : game.home;
      const opponent = player.team_id === game.away.team_id ? game.home : game.away;
      const place = player.team_id === game.away.team_id ? 'at' : 'vs';
      hits.push(
        `<button type="button" class="ghost projection-hit" data-projection-player="${escapeHtml(player.athlete_id)}" data-projection-event="${escapeHtml(game.event_id)}"><span>${escapeHtml(player.name)}</span><span class="tip">${escapeHtml(sideAbbr(team))} ${place} ${escapeHtml(sideAbbr(opponent))} · ${escapeHtml(formatTip(game.start_time))}</span></button>`,
      );
    }
  }
  if (!hits.length) return '<p class="prop-note">No player on this slate matches that search.</p>';
  return hits.join('');
}

function gamesHtml(view: ProjectionView, game: SlateGame | null, rate: RateGame | null): string {
  const player = rate?.players.find((item) => item.athlete_id === view.athleteId) ?? null;
  const form = view.form.market === 'dd' || view.form.market === 'td' ? { ...view.form, line: '0.5' } : view.form;
  const contextRail =
    view.card.projection_context && game && player
      ? defenseAsideHtml(view, game, player, form, view.card.projection_context)
      : '';
  const games = view.slate.games
    .map((item) => {
      const selected = item.event_id === view.eventId;
      const spread = item.spread_caption ? `<p class="spread">${escapeHtml(item.spread_caption)}</p>` : '';
      const ready = view.readyEventIds?.has(item.event_id) ?? false;
      const status = statusLabel(item, view.now, view.slate.generated_at);
      return `<button type="button" class="projection-game" data-projection-game="${escapeHtml(item.event_id)}" aria-pressed="${selected ? 'true' : 'false'}">
          <span class="game-row-head"><span class="abbr">${escapeHtml(sideAbbr(item.away))} @ ${escapeHtml(sideAbbr(item.home))}</span>${ready ? '<span class="ready-dot" title="10,000 simulations cached">10k ready</span>' : ''}</span>
          <span class="tip">${escapeHtml(formatTip(item.start_time))}</span>
          <span class="status">${escapeHtml(status)}</span>
          ${spread}
        </button>`;
    })
    .join('');
  return `<aside class="projection-aside">
      ${contextRail}
      <section class="aside-block">
        <h2>Games</h2>
        <div class="projection-games">${games}</div>
      </section>
    </aside>`;
}

export interface SlateLean {
  eventId: string;
  athleteId: string;
  name: string;
  matchup: string;
  side: 'over' | 'under';
  line: number;
  projection: number;
  rate: number;
}

const SLATE_LEAN_LIMIT = 5;

/** Stronger side of each simulated player's own half-point hook. Games with no cached simulation are counted as waiting. */
export function slateLeans(
  slate: Slate,
  card: RateCard,
  market: PropMarket,
  simulations: ReadonlyMap<string, Simulation>,
): { over: SlateLean[]; under: SlateLean[]; waiting: number } {
  const over: SlateLean[] = [];
  const under: SlateLean[] = [];
  let waiting = 0;
  for (const listed of slate.games) {
    const rate = card.games.find((item) => item.event_id === listed.event_id);
    if (!rate || rate.simulation_error) continue;
    const simulation = simulations.get(listed.event_id);
    if (!simulation) {
      waiting += 1;
      continue;
    }
    const matchup = `${sideAbbr(listed.away)} @ ${sideAbbr(listed.home)}`;
    for (const player of rate.players) {
      if (player.replacement_level) continue;
      const sample = simulation.playerDraws.get(player.athlete_id);
      if (!sample || !propEligible(sample, market)) continue;
      const line = defaultMarketLine(market, sample, undefined, player.athlete_id);
      const projection = playedMean(playedValues(sample, market));
      if (line === null || projection === null) continue;
      const pair = chancePair(sample, market, line);
      if (!pair || pair.over === null || pair.under === null || pair.over === pair.under) continue;
      if ((market === 'dd' || market === 'td') && pair.over <= pair.under) continue;
      const lean: SlateLean = {
        eventId: listed.event_id,
        athleteId: player.athlete_id,
        name: player.name,
        matchup,
        side: pair.over > pair.under ? 'over' : 'under',
        line,
        projection,
        rate: pair.over > pair.under ? pair.over : pair.under,
      };
      (lean.side === 'over' ? over : under).push(lean);
    }
  }
  const byRate = (a: SlateLean, b: SlateLean) => b.rate - a.rate || a.name.localeCompare(b.name);
  over.sort(byRate);
  under.sort(byRate);
  return { over: over.slice(0, SLATE_LEAN_LIMIT), under: under.slice(0, SLATE_LEAN_LIMIT), waiting };
}

function leanColumn(title: string, rows: readonly SlateLean[], empty: string): string {
  const body = rows.length
    ? `<ul>${rows
        .map((row) => {
          const line = Number.isInteger(row.line) ? row.line.toFixed(1) : String(row.line);
          const side = row.side === 'over' ? 'Over' : 'Under';
          return `<li><button type="button" class="lean-row" data-projection-player="${escapeHtml(row.athleteId)}" data-projection-event="${escapeHtml(row.eventId)}"><span class="lean-name">${escapeHtml(row.name)}</span><span class="lean-meta">${escapeHtml(row.matchup)} · proj ${row.projection.toFixed(1)} · ${side} ${escapeHtml(line)}</span><strong>${escapeHtml(percent(row.rate))}</strong></button></li>`;
        })
        .join('')}</ul>`
    : `<p class="prop-note">${empty}</p>`;
  return `<div><h3>${title}</h3>${body}</div>`;
}

export function modelSidesInner(
  slate: Slate,
  card: RateCard,
  market: PropMarket,
  simulations: ReadonlyMap<string, Simulation>,
): string {
  const leans = slateLeans(slate, card, market, simulations);
  const ready = leans.over.length + leans.under.length;
  if (!ready && leans.waiting > 0) {
    return `<h2>${escapeHtml(marketLabel(market))}</h2><p class="section-sub">Simulations are still warming up. This list fills as each game finishes, so the slate does not have to be opened one game at a time.</p>`;
  }
  const waiting = leans.waiting
    ? `<p class="section-sub">${leans.waiting} ${leans.waiting === 1 ? 'game is' : 'games are'} still simulating.</p>`
    : '';
  return `<h2>${escapeHtml(marketLabel(market))}</h2><p class="section-sub">Rotation players only, on their own half-point hook. Short-minute and near-zero stats are left off, so a player who scores nothing is not listed as a lock. The hook is not a book line.</p>${waiting}<div class="lean-columns">${leanColumn('Over', leans.over, 'No rotation player leans over.')}${leanColumn('Under', leans.under, 'No rotation player leans under.')}</div>`;
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

export function renderProjections(view: ProjectionView): string {
  const game = view.slate.games.find((item) => item.event_id === view.eventId) ?? null;
  const rate = view.card.games.find((item) => item.event_id === view.eventId) ?? null;
  const detail = game && rate ? detailHtml(view, game, rate) : '';
  const boardMeter = view.drawing && !view.athleteId ? inlineDrawingHtml(view.drawProgress) : '';
  const board =
    game && rate
      ? `${boardMeter}<section class="team-box projection-board"><h2>${escapeHtml(marketLabel(view.form.market))} board</h2>${injuryReportHtml(rate, game)}<div data-projection-board>${projectionBoardHtml(rate, view.simulation, view.form, game.event_id, view.athleteId, view.card.projection_context, view.boardSort ?? 'projection')}</div></section>`
      : '<p class="state">Search a player, or pick a game. Historical trends load right away, and 10,000 simulations warm in the background.</p>';
  return `<div class="projection-page">
      <header class="projection-intro">
        <h2>Projections</h2>
        <p class="projection-note">A simulator, not a betting ticket. 10,000 simulated games paired with ESPN box-score history and reconstructed lineup stints. The line is the viewer's line; a spread under a game is display only and the simulator does not read it.</p>
      </header>
      <div class="projection-layout">
        <div class="projection-main">
          <label class="field projection-search"><span class="field-label">Player</span><input data-projection-search type="search" value="${escapeHtml(view.query)}" placeholder="Search a player on the slate" autocomplete="off"></label>
          <div data-projection-hits class="projection-hits">${searchHitsHtml(view.slate, view.card, view.query)}</div>
          <section class="model-sides" data-model-sides aria-label="Where the simulations lean">${modelSidesInner(view.slate, view.card, view.form.market, view.cachedSimulations ?? new Map())}</section>
          ${detail}
          ${board}
        </div>
        ${gamesHtml(view, game, rate)}
      </div>
    </div>`;
}

// Re-export medianOf for convenience in tests and controls.
export { medianOf };
