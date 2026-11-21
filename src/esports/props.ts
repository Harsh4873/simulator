import { chicagoDate, formatTip, shiftChicagoDate } from '../date.ts';
import { escapeHtml } from '../slate.ts';
import { CS2_STATS, DOTA_STATS, LOL_STATS, MIN_GAMES } from './config.ts';

export const ESPORTS_MODEL_NAME = 'esports-player-projections-v1';
/** Files published before projections carry this name and still parse. */
export const LEGACY_ESPORTS_MODEL_NAME = 'esports-player-means-v1';

export const ESPORTS_MODEL_NOTE =
  `Each projection is that player's own rate from his earlier games, newest weighted most and pulled toward the field when he has few: CS2 kills and headshots per round over maps 1 and 2 (each map 13 to about 30 rounds), Dota 2 and League of Legends per game. The displayed game is never part of its own projection. The ranges are calibrated on the same players' earlier games so 8 in 10 results land inside, and the plain average is shown under each projection. No match winner and no posted line were used.`;

export type EsportsStat = (typeof DOTA_STATS)[number] | (typeof LOL_STATS)[number] | (typeof CS2_STATS)[number];

export interface EsportsProp {
  stat: EsportsStat;
  /** Unrounded mean. Null when fewer than MIN_GAMES earlier values are present. */
  mean: number | null;
  /** The player's value in this game once it is played, on the same scale as the mean (per map for CS2). */
  actual?: number | null;
  /** Calibrated projection: CS2 over maps 1-2, Dota 2 and League of Legends for this game. */
  projection?: EsportsProjection | null;
}

export interface EsportsProjection {
  scope: 'maps12' | 'game';
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

/** How a stat's projection did on the same players' earlier games. */
export interface EsportsCheck {
  title: 'Dota 2' | 'League of Legends' | 'CS2';
  stat: EsportsStat;
  rows: number;
  coverage: number;
  mae: number;
  dispersion: number;
  bias: number;
}

export interface EsportsPlayer {
  name: string;
  team: string;
  props: EsportsProp[];
}

export type EsportsStatus = 'upcoming' | 'live' | 'finished';

export interface EsportsMatch {
  id: string;
  start_time: string;
  teams: [string, string];
  competition: string | null;
  players: EsportsPlayer[];
  /** Older files omit the result fields. */
  status?: EsportsStatus;
  /** One of `teams` once the match is decided. */
  winner?: string | null;
  /** Maps won by each of `teams` (CS2 series). Null for a single game. */
  score?: [number, number] | null;
}

export interface EsportsTitle {
  title: 'Dota 2' | 'League of Legends' | 'CS2';
  source: string;
  matches: EsportsMatch[];
}

export interface EsportsModel {
  name: typeof ESPORTS_MODEL_NAME | typeof LEGACY_ESPORTS_MODEL_NAME;
  fitted: boolean;
  note: string;
  checks?: EsportsCheck[];
}

export interface EsportsDocument {
  sport: 'esports';
  generated_at: string;
  timezone: 'America/Chicago';
  dates: [string, string];
  model: EsportsModel;
  titles: EsportsTitle[];
}

export interface CountRow {
  id: string;
  start: number;
  value: number | null;
}

export interface SeriesRow {
  id: string;
  start: number;
  total: number | null;
  maps: number;
}

const STATS = new Set<string>([...DOTA_STATS, ...LOL_STATS, ...CS2_STATS]);
const TITLES = new Set<EsportsTitle['title']>(['Dota 2', 'League of Legends', 'CS2']);
const BANNED_KEY = /^(odds|spread|moneyline|price|line|away_win|home_win)$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const STAT_LABEL: Record<EsportsStat, string> = {
  kills: 'Kills',
  deaths: 'Deaths',
  assists: 'Assists',
  cs: 'CS',
  headshots: 'Headshots',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function banned(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (BANNED_KEY.test(key) || banned(child, depth + 1)) return true;
  }
  return false;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Present numbers only. A missing value is left out, and fewer than MIN_GAMES present values is null. */
export function meanOf(values: readonly (number | null | undefined)[]): number | null {
  const kept: number[] = [];
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) kept.push(value);
  }
  if (kept.length < MIN_GAMES) return null;
  return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

/** Arithmetic mean of earlier rows. The displayed id is excluded, and a row that is not earlier is excluded. */
export function earlierMean(rows: readonly CountRow[], currentId: string, currentStart: number): number | null {
  const values: (number | null)[] = [];
  for (const row of rows) {
    if (row.id === currentId || !(row.start < currentStart)) continue;
    values.push(row.value);
  }
  return meanOf(values);
}

/**
 * Mean of per-map series values. Each earlier series contributes its total divided by its map count.
 * A series with no maps, or a missing total, is left out. The displayed series is excluded.
 */
export function cs2PerMapMean(rows: readonly SeriesRow[], currentId: string, currentStart: number): number | null {
  const values: number[] = [];
  for (const row of rows) {
    if (row.id === currentId || !(row.start < currentStart)) continue;
    if (row.maps < 1 || typeof row.total !== 'number' || !Number.isFinite(row.total)) continue;
    values.push(row.total / row.maps);
  }
  return meanOf(values);
}

/** Cargo counts are strings. An empty string is missing. "0" is zero. */
export function cargoCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One decimal, the same rendering the NBA forecast tile uses. Null is the words "not fitted" and no digit. */
export function formatStat(mean: number | null): string {
  if (mean === null || !Number.isFinite(mean)) return 'not fitted';
  return mean.toFixed(1);
}

function anyMean(titles: readonly EsportsTitle[]): boolean {
  for (const title of titles) {
    for (const match of title.matches) {
      for (const player of match.players) {
        for (const prop of player.props) {
          if (prop.mean !== null) return true;
        }
      }
    }
  }
  return false;
}

export function esportsDocument(titles: readonly EsportsTitle[], now: Date, checks: readonly EsportsCheck[] = []): EsportsDocument {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  return {
    sport: 'esports',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    model: {
      name: ESPORTS_MODEL_NAME,
      fitted: anyMean(titles),
      note: ESPORTS_MODEL_NOTE,
      ...(checks.length ? { checks: checks.map((check) => ({ ...check })) } : {}),
    },
    titles: titles.map((title) => ({
      title: title.title,
      source: title.source,
      matches: title.matches.map((match) => ({
        id: match.id,
        start_time: match.start_time,
        teams: [match.teams[0], match.teams[1]],
        competition: match.competition,
        ...(match.status ? { status: match.status } : {}),
        ...(match.winner !== undefined ? { winner: match.winner } : {}),
        ...(match.score !== undefined ? { score: match.score } : {}),
        players: match.players.map((player) => ({
          name: player.name,
          team: player.team,
          props: player.props.map((prop) => ({
            stat: prop.stat,
            mean: prop.mean,
            ...(prop.actual !== undefined ? { actual: prop.actual } : {}),
            ...(prop.projection !== undefined ? { projection: prop.projection } : {}),
          })),
        })),
      })),
    })),
  };
}

function propOf(value: unknown): EsportsProp | null {
  const row = record(value);
  if (!row) return null;
  const stat = text(row.stat);
  if (!stat || !STATS.has(stat)) return null;
  if (row.mean !== null && finite(row.mean) === null) return null;
  const prop: EsportsProp = { stat: stat as EsportsStat, mean: row.mean === null ? null : finite(row.mean) };
  if (row.actual !== undefined) {
    if (row.actual !== null && (finite(row.actual) === null || (row.actual as number) < 0)) return null;
    prop.actual = row.actual === null ? null : finite(row.actual);
  }
  if (row.projection !== undefined) {
    const projection = projectionOf(row.projection);
    if (projection === undefined) return null;
    prop.projection = projection;
  }
  return prop;
}

function projectionOf(value: unknown): EsportsProjection | null | undefined {
  if (value === null) return null;
  const row = record(value);
  if (!row || (row.scope !== 'maps12' && row.scope !== 'game')) return undefined;
  const mean = finite(row.mean);
  const p10 = finite(row.p10);
  const p50 = finite(row.p50);
  const p90 = finite(row.p90);
  if (mean === null || p10 === null || p50 === null || p90 === null || p10 < 0 || !(p10 <= p50 && p50 <= p90)) return undefined;
  return { scope: row.scope, mean, p10, p50, p90 };
}

function checkOf(value: unknown): EsportsCheck | null {
  const row = record(value);
  if (!row || typeof row.title !== 'string' || !TITLES.has(row.title as EsportsTitle['title']) || typeof row.stat !== 'string' || !STATS.has(row.stat)) return null;
  const numbers = [row.rows, row.coverage, row.mae, row.dispersion, row.bias];
  if (!numbers.every((item) => finite(item) !== null) || !Number.isInteger(row.rows) || (row.coverage as number) < 0 || (row.coverage as number) > 1) return null;
  return { title: row.title as EsportsCheck['title'], stat: row.stat as EsportsStat, rows: row.rows as number, coverage: row.coverage as number, mae: row.mae as number, dispersion: row.dispersion as number, bias: row.bias as number };
}

const STATUSES = new Set<EsportsStatus>(['upcoming', 'live', 'finished']);

/** Result fields are optional. When present they must name a team in the match and count maps as whole numbers. */
function resultOf(row: Record<string, unknown>, teams: [string, string]): Pick<EsportsMatch, 'status' | 'winner' | 'score'> | null {
  const out: Pick<EsportsMatch, 'status' | 'winner' | 'score'> = {};
  if (row.status !== undefined) {
    if (typeof row.status !== 'string' || !STATUSES.has(row.status as EsportsStatus)) return null;
    out.status = row.status as EsportsStatus;
  }
  if (row.winner !== undefined) {
    if (row.winner !== null && (typeof row.winner !== 'string' || !teams.includes(row.winner))) return null;
    out.winner = row.winner;
  }
  if (row.score !== undefined) {
    if (row.score !== null) {
      const score = row.score;
      if (!Array.isArray(score) || score.length !== 2 || !score.every((value) => Number.isInteger(value) && value >= 0 && value <= 9)) return null;
      out.score = [score[0] as number, score[1] as number];
    } else out.score = null;
  }
  return out;
}

function playerOf(value: unknown): EsportsPlayer | null {
  const row = record(value);
  if (!row || !Array.isArray(row.props) || row.props.length === 0) return null;
  const name = text(row.name);
  const team = text(row.team);
  if (!name || !team) return null;
  const props: EsportsProp[] = [];
  for (const item of row.props) {
    const prop = propOf(item);
    if (!prop) return null;
    props.push(prop);
  }
  return { name, team, props };
}

function matchOf(value: unknown): EsportsMatch | null {
  const row = record(value);
  if (!row || !Array.isArray(row.players) || row.players.length === 0) return null;
  const id = text(row.id);
  const start = text(row.start_time);
  if (!id || !start || Number.isNaN(Date.parse(start))) return null;
  if (!Array.isArray(row.teams) || row.teams.length !== 2) return null;
  const left = text(row.teams[0]);
  const right = text(row.teams[1]);
  if (!left || !right) return null;
  if (!('competition' in row)) return null;
  const competition = row.competition === null ? null : text(row.competition);
  if (row.competition !== null && competition === null) return null;
  const players: EsportsPlayer[] = [];
  for (const item of row.players) {
    const player = playerOf(item);
    if (!player) return null;
    players.push(player);
  }
  const result = resultOf(row, [left, right]);
  if (!result) return null;
  return { id, start_time: new Date(start).toISOString(), teams: [left, right], competition, ...result, players };
}

function titleOf(value: unknown): EsportsTitle | null {
  const row = record(value);
  if (!row || typeof row.title !== 'string' || !TITLES.has(row.title as EsportsTitle['title'])) return null;
  const source = text(row.source);
  if (!source || !Array.isArray(row.matches) || row.matches.length === 0) return null;
  const matches: EsportsMatch[] = [];
  for (const item of row.matches) {
    const match = matchOf(item);
    if (!match) return null;
    matches.push(match);
  }
  return { title: row.title as EsportsTitle['title'], source, matches };
}

function modelOf(value: unknown): EsportsModel | null {
  const row = record(value);
  if (!row || (row.fitted !== true && row.fitted !== false)) return null;
  if (row.name !== ESPORTS_MODEL_NAME && row.name !== LEGACY_ESPORTS_MODEL_NAME) return null;
  const note = text(row.note);
  if (!note) return null;
  const fitted = row.fitted === true;
  if (row.checks === undefined) return { name: row.name, fitted, note };
  if (!Array.isArray(row.checks)) return null;
  const checks: EsportsCheck[] = [];
  for (const item of row.checks) {
    const check = checkOf(item);
    if (!check) return null;
    checks.push(check);
  }
  return { name: row.name, fitted, note, checks };
}

/** Rejects a file that carries a price, a line, or a win chance, or that is not a player-mean document. */
export function parseEsportsDocument(raw: string): EsportsDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (banned(value)) return null;
  const row = record(value);
  if (!row || row.sport !== 'esports' || row.timezone !== 'America/Chicago') return null;
  const generated = text(row.generated_at);
  if (!generated || Number.isNaN(Date.parse(generated))) return null;
  if (!Array.isArray(row.dates) || row.dates.length !== 2) return null;
  const [first, second] = row.dates;
  if (typeof first !== 'string' || typeof second !== 'string' || !DAY.test(first) || !DAY.test(second)) return null;
  const model = modelOf(row.model);
  if (!model || !Array.isArray(row.titles) || row.titles.length === 0) return null;
  const titles: EsportsTitle[] = [];
  for (const item of row.titles) {
    const title = titleOf(item);
    if (!title) return null;
    titles.push(title);
  }
  return {
    sport: 'esports',
    generated_at: new Date(generated).toISOString(),
    timezone: 'America/Chicago',
    dates: [first, second],
    model,
    titles,
  };
}

function whenLabel(iso: string, now: Date): string {
  const day = chicagoDate(new Date(iso));
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
  if (day === today) return `Today · ${clock}`;
  if (day === yesterday) return `Yesterday · ${clock}`;
  return formatTip(iso);
}

/** The played value under a projection: whole counts as they are, CS2 per-map values to one decimal. */
function actualText(actual: number, perMap: boolean): string {
  const shown = Number.isInteger(actual) ? String(actual) : actual.toFixed(1);
  return perMap ? `${shown} a map` : shown;
}

const SCOPE_LABEL: Record<EsportsProjection['scope'], string> = { maps12: 'maps 1-2', game: 'this game' };

function projectionCell(prop: EsportsProp | undefined, perMap: boolean): string {
  if (!prop) return '<td>—</td>';
  const played =
    typeof prop.actual === 'number' && Number.isFinite(prop.actual)
      ? `<span class="pct" data-actual>Played ${escapeHtml(actualText(prop.actual, perMap))}</span>`
      : '';
  const average = prop.mean === null ? 'avg not fitted' : `avg ${formatStat(prop.mean)}${perMap ? ' a map' : ''}`;
  if (prop.projection) {
    const projection = prop.projection;
    return `<td data-projection><span class="stat">${Math.round(projection.p50)}</span><span class="pct">${Math.round(projection.p10)}–${Math.round(projection.p90)}</span><span class="pct">${escapeHtml(average)}</span>${played}</td>`;
  }
  return `<td><span class="stat">${escapeHtml(formatStat(prop.mean))}</span>${played}</td>`;
}

/** Upcoming, live or final. Files from before the status field show nothing extra. */
export function resultText(match: Pick<EsportsMatch, 'status'>): string | null {
  if (!match.status) return null;
  return match.status === 'upcoming' ? 'Upcoming' : match.status === 'live' ? 'Live' : 'Final';
}

const CHIP_STATE: Record<EsportsStatus, string> = { upcoming: 'pre', live: 'live', finished: 'post' };

/**
 * One match as a table: a row per player under his team, a column per projected stat with the median, the 10th to
 * 90th range and the plain average, and what he did once the game is played.
 */
function renderMatch(match: EsportsMatch, now: Date, perMap: boolean): string {
  const where = match.competition ? `<p class="where">${escapeHtml(match.competition)}</p>` : '';
  const result = resultText(match);
  const chip = result && match.status ? `<span class="chip" data-state="${CHIP_STATE[match.status]}" data-result>${escapeHtml(result)}</span>` : '';
  const stats: EsportsStat[] = [];
  for (const player of match.players) for (const prop of player.props) if (!stats.includes(prop.stat)) stats.push(prop.stat);
  const scoped = (stat: EsportsStat) => match.players.flatMap((player) => player.props).find((prop) => prop.stat === stat && prop.projection)?.projection?.scope ?? null;
  const head = stats
    .map((stat) => {
      const scope = scoped(stat);
      return `<th scope="col">${escapeHtml(STAT_LABEL[stat])}${scope ? `<span class="th-sub">${escapeHtml(SCOPE_LABEL[scope])}</span>` : ''}</th>`;
    })
    .join('');
  const teams = [match.teams[0], match.teams[1], ...new Set(match.players.map((player) => player.team).filter((team) => team !== match.teams[0] && team !== match.teams[1]))];
  const body = teams
    .map((team) => {
      const players = match.players.filter((player) => player.team === team);
      if (!players.length) return '';
      const rows = players
        .map((player) => `<tr><th scope="row">${escapeHtml(player.name)}</th>${stats.map((stat) => projectionCell(player.props.find((prop) => prop.stat === stat), perMap)).join('')}</tr>`)
        .join('');
      return `<tr class="team-row"><th colspan="${stats.length + 1}" scope="rowgroup">${escapeHtml(team)}</th></tr>${rows}`;
    })
    .join('');
  return `<article class="game-card esports-card">
    <div class="card-top"><span class="chip chip-time">${escapeHtml(whenLabel(match.start_time, now))}</span>${chip}</div>
    <h2 class="esports-matchup">${escapeHtml(match.teams[0])} <span class="at">vs</span> ${escapeHtml(match.teams[1])}</h2>
    ${where}
    <div class="table-scroll"><table class="esports-table"><thead><tr><th scope="col">Player</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
  </article>`;
}

/** How the projections did on the same players' earlier games, one line per title. */
function checksMarkup(checks: readonly EsportsCheck[] | undefined): string {
  if (!checks?.length) return '';
  const titles = [...new Set(checks.map((check) => check.title))];
  const parts = titles.map((title) => {
    const mine = checks.filter((check) => check.title === title && check.rows > 0);
    const rows = Math.max(...mine.map((check) => check.rows), 0);
    const coverage = mine.map((check) => `${STAT_LABEL[check.stat].toLowerCase()} ${Math.round(check.coverage * 100)}%`).join(', ');
    return `${title}: ${rows.toLocaleString('en-US')} earlier ${title === 'CS2' ? 'series' : 'games'}, inside the range ${coverage}`;
  });
  return `<p class="note" data-checks>Checked by projecting each earlier game from the ones before it. ${escapeHtml(parts.join('. '))}.</p>`;
}

export function renderEsports(doc: EsportsDocument, now: Date): string {
  const sources = doc.titles.map((title) => title.source).join(', ');
  const built = `Published ${formatTip(doc.generated_at)} · ${sources}`;
  const matches = doc.titles.reduce((sum, title) => sum + title.matches.length, 0);
  const meta = `Esports · ${matches} ${matches === 1 ? 'match' : 'matches'} across ${doc.titles.map((title) => title.title).join(', ')}`;
  const head = `<div class="feed-head"><div class="feed-titles"><p class="slate-meta">${escapeHtml(meta)}</p><p class="status captured">${escapeHtml(built)}</p></div><details class="method-note"><summary>How these projections work</summary><p class="note">${escapeHtml(doc.model.note)}</p>${checksMarkup(doc.model.checks)}</details></div>`;
  const sections = doc.titles.map((title) => {
    const cards = title.matches.map((match) => renderMatch(match, now, title.title === 'CS2')).join('');
    return `<section class="slate-day"><h2 class="slate-title">${escapeHtml(title.title)}</h2><div class="slate">${cards}</div></section>`;
  }).join('');
  return `${head}${sections}`;
}
