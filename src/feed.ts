import { chicagoDate, formatTip, shiftChicagoDate } from './date.ts';
import { paletteStyle } from './display.ts';
import { escapeHtml } from './slate.ts';
import type { PublishedCalibration, TeamPlan } from './nfl/projection.ts';

export type FeedSport = 'nfl';
export type FeedStatus = 'scheduled' | 'in_progress' | 'final';

export interface FeedSide {
  name: string;
  abbreviation: string;
  score: number | null;
  logo_url: string | null;
  color: string | null;
  alternate_color: string | null;
  /** Overall win-loss(-tie) record as the scoreboard lists it. Older files omit it. */
  record?: string | null;
}

/** A chance computed from results. Never a price, spread, or total. */
export interface FeedProjection {
  kind: 'game' | 'series' | 'map';
  away_win: number;
  home_win: number;
  summary: string;
}

export interface FeedGame {
  id: string;
  start_time: string;
  status: FeedStatus;
  /** NFL cards are away at home. */
  listed: boolean;
  away: FeedSide;
  home: FeedSide;
  venue: string | null;
  neutral_site: boolean;
  competition: string | null;
  projection: FeedProjection | null;
  projection_note: string;
  /** Simulated game and player projections. Older files omit it. */
  sim?: FeedGameSim | null;
}

export const FEED_STATS = ['pass_yds', 'pass_td', 'int', 'pass_cmp', 'rush_yds', 'car', 'rec', 'rec_yds', 'tgt'] as const;
export type FeedStat = (typeof FEED_STATS)[number];

/** Mean, median and the 10th to 90th percentile range of simulated values. */
export interface FeedBand {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface FeedPlayerSim {
  id: string;
  name: string;
  side: 'away' | 'home';
  position: string;
  status: string | null;
  /** Share of draws the player was active. */
  play: number;
  stats: Partial<Record<FeedStat, FeedBand>>;
  /** Chance of a rushing or receiving touchdown when he plays. */
  td: number;
  /** What he recorded, once the game is final. */
  actual?: Partial<Record<FeedStat, number>> | null;
}

export interface FeedGameSim {
  draws: number;
  away_points: FeedBand;
  home_points: FeedBand;
  /** Home minus away. */
  margin: FeedBand;
  /** Both teams' points. */
  combined: FeedBand;
  home_win: number;
  players: FeedPlayerSim[];
  /** What the page needs to play the game itself: both team plans and the calibration. Older files omit it. */
  plan?: FeedSimPlan | null;
}

export interface FeedSimPlan {
  neutral: boolean;
  home: TeamPlan;
  away: TeamPlan;
  calibration: PublishedCalibration;
}

/** Walk-forward check of the simulation on earlier weeks of the season. */
export interface FeedValidation {
  games: number;
  from_week: number | null;
  through_week: number | null;
  win_brier: number;
  margin_mae: number;
  td_brier: number;
  /** Share of outcomes inside the published 10th to 90th range, per stat. */
  coverage: Partial<Record<FeedStat | 'margin' | 'combined', number>>;
  mae: Partial<Record<FeedStat, number>>;
}

export interface FeedModel {
  fitted: boolean;
  name: string;
  note: string;
  holdout_games: number | null;
  holdout_brier: number | null;
  validation?: FeedValidation | null;
}

export interface FeedSlate {
  sport: FeedSport;
  source: string;
  generated_at: string;
  timezone: 'America/Chicago';
  dates: [string, string];
  games: FeedGame[];
  later: FeedGame[];
  model: FeedModel;
}

const STATUSES = new Set<FeedStatus>(['scheduled', 'in_progress', 'final']);
const KINDS = new Set<FeedProjection['kind']>(['game', 'series', 'map']);
const BANNED_KEY = /^(odds|spread|moneyline|price|total|decimal|vig|book|line)$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const RECORD = /^\d{1,2}-\d{1,2}(-\d{1,2})?$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function banned(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (BANNED_KEY.test(key) || banned(child, depth + 1)) return true;
  }
  return false;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function scoreOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function sideOf(value: unknown): FeedSide | null {
  const row = record(value);
  if (!row) return null;
  const name = text(row.name);
  const abbreviation = text(row.abbreviation);
  const score = scoreOf(row.score);
  if (!name || !abbreviation || score === undefined) return null;
  const logo = typeof row.logo_url === 'string' && row.logo_url.startsWith('https://a.espncdn.com/') ? row.logo_url : null;
  if (row.logo_url !== null && logo === null) return null;
  const color = typeof row.color === 'string' && HEX.test(row.color) ? row.color : null;
  if (row.color !== null && color === null) return null;
  const alternate = typeof row.alternate_color === 'string' && HEX.test(row.alternate_color) ? row.alternate_color : null;
  if (row.alternate_color !== null && alternate === null) return null;
  if (!('record' in row) || row.record === undefined) return { name, abbreviation, score, logo_url: logo, color, alternate_color: alternate };
  if (row.record !== null && (typeof row.record !== 'string' || !RECORD.test(row.record))) return null;
  return { name, abbreviation, score, logo_url: logo, color, alternate_color: alternate, record: row.record };
}

function projectionOf(value: unknown): FeedProjection | null | undefined {
  if (value === null) return null;
  const row = record(value);
  if (!row || typeof row.kind !== 'string' || !KINDS.has(row.kind as FeedProjection['kind'])) return undefined;
  const away = row.away_win;
  const home = row.home_win;
  const summary = text(row.summary);
  if (typeof away !== 'number' || typeof home !== 'number' || !summary) return undefined;
  if (!Number.isFinite(away) || !Number.isFinite(home) || away < 0 || home < 0 || away > 1 || home > 1) return undefined;
  if (Math.abs(away + home - 1) > 0.02) return undefined;
  return { kind: row.kind as FeedProjection['kind'], away_win: away, home_win: home, summary };
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const chance = (value: unknown): value is number => finiteNumber(value) && value >= 0 && value <= 1;
const STAT_SET = new Set<string>(FEED_STATS);

function bandOf(value: unknown): FeedBand | null {
  const row = record(value);
  if (!row || !finiteNumber(row.mean) || !finiteNumber(row.p10) || !finiteNumber(row.p50) || !finiteNumber(row.p90)) return null;
  if (!(row.p10 <= row.p50 + 1e-9 && row.p50 <= row.p90 + 1e-9)) return null;
  return { mean: row.mean, p10: row.p10, p50: row.p50, p90: row.p90 };
}

function statMap<T>(value: unknown, read: (item: unknown) => T | null): Partial<Record<FeedStat, T>> | null {
  const row = record(value);
  if (!row) return null;
  const out: Partial<Record<FeedStat, T>> = {};
  for (const [key, item] of Object.entries(row)) {
    if (!STAT_SET.has(key)) return null;
    const parsed = read(item);
    if (parsed === null) return null;
    out[key as FeedStat] = parsed;
  }
  return out;
}

function playerSimOf(value: unknown): FeedPlayerSim | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id);
  const name = text(row.name);
  const position = text(row.position);
  if (!id || !name || !position || (row.side !== 'away' && row.side !== 'home') || !chance(row.play) || !chance(row.td)) return null;
  if (row.status !== null && text(row.status) === null) return null;
  const stats = statMap(row.stats, bandOf);
  if (!stats) return null;
  let actual: FeedPlayerSim['actual'];
  if (row.actual !== undefined) {
    actual = row.actual === null ? null : statMap(row.actual, (item) => (finiteNumber(item) ? item : null));
    if (actual === undefined || (row.actual !== null && actual === null)) return null;
  }
  return { id, name, side: row.side, position, status: row.status === null ? null : text(row.status), play: row.play, stats, td: row.td, ...(actual !== undefined ? { actual } : {}) };
}

const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const within = (value: unknown, lo: number, hi: number): value is number => finiteNumber(value) && value >= lo && value <= hi;

function teamPlanOf(value: unknown): TeamPlan | null {
  const row = record(value);
  if (!row || !Array.isArray(row.players) || row.players.length > 30) return null;
  const abbr = text(row.abbr);
  if (!abbr || !within(row.points, 0, 70) || !within(row.passAtt, 0, 90) || !within(row.rushAtt, 0, 80) || !within(row.drives, 3, 25) || !chance(row.tdPointShare) || !chance(row.passTdShare)) return null;
  const players: TeamPlan['players'] = [];
  for (const item of row.players) {
    const player = record(item);
    const id = text(player?.id);
    const name = text(player?.name);
    if (!player || !id || !name || typeof player.position !== 'string' || !POSITIONS.has(player.position)) return null;
    if (player.status !== null && text(player.status) === null) return null;
    if (!chance(player.play) || !chance(player.targetShare) || !chance(player.catchRate) || !within(player.ypr, 0, 40) || !chance(player.tdPerRec)) return null;
    if (!chance(player.carryShare) || !within(player.ypc, -10, 20) || !chance(player.tdPerCarry) || !chance(player.intRate) || !within(player.lastPassAtt, 0, 100) || !within(player.weightedPassAtt, 0, 1000)) return null;
    players.push({
      id,
      name,
      position: player.position as TeamPlan['players'][number]['position'],
      status: player.status === null ? null : text(player.status),
      play: player.play,
      targetShare: player.targetShare,
      catchRate: player.catchRate,
      ypr: player.ypr,
      tdPerRec: player.tdPerRec,
      carryShare: player.carryShare,
      ypc: player.ypc,
      tdPerCarry: player.tdPerCarry,
      intRate: player.intRate,
      lastPassAtt: player.lastPassAtt,
      weightedPassAtt: player.weightedPassAtt,
    });
  }
  return { abbr, points: row.points, passAtt: row.passAtt, rushAtt: row.rushAtt, drives: row.drives, tdPointShare: row.tdPointShare, passTdShare: row.passTdShare, players };
}

function calibrationOf(value: unknown): PublishedCalibration | null {
  const row = record(value);
  const td = record(row?.td);
  const ranges = record(row?.ranges);
  const bias = record(row?.bias);
  if (!row || !td || !ranges || !bias || !within(row.sigma, 0, 2) || !within(row.temperature, 0.1, 5) || !finiteNumber(td.a) || !finiteNumber(td.b)) return null;
  const rangeOut: PublishedCalibration['ranges'] = {};
  for (const [key, item] of Object.entries(ranges)) {
    if ((!STAT_SET.has(key) && key !== 'margin' && key !== 'combined') || !within(item, 0.1, 5)) return null;
    rangeOut[key as FeedStat] = item;
  }
  const biasOut: Record<string, number> = {};
  for (const [key, item] of Object.entries(bias)) {
    const [position, stat] = key.split(':');
    if (!position || !stat || !POSITIONS.has(position) || !STAT_SET.has(stat) || !within(item, 0.2, 5)) return null;
    biasOut[key] = item;
  }
  return { sigma: row.sigma, temperature: row.temperature, td: { a: td.a, b: td.b }, ranges: rangeOut, bias: biasOut };
}

function planOf(value: unknown): FeedSimPlan | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const row = record(value);
  if (!row || typeof row.neutral !== 'boolean') return undefined;
  const home = teamPlanOf(row.home);
  const away = teamPlanOf(row.away);
  const calibration = calibrationOf(row.calibration);
  if (!home || !away || !calibration) return undefined;
  return { neutral: row.neutral, home, away, calibration };
}

function simOf(value: unknown): FeedGameSim | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const row = record(value);
  if (!row || !Number.isInteger(row.draws) || !chance(row.home_win) || !Array.isArray(row.players)) return undefined;
  const away = bandOf(row.away_points);
  const home = bandOf(row.home_points);
  const margin = bandOf(row.margin);
  const combined = bandOf(row.combined);
  if (!away || !home || !margin || !combined) return undefined;
  const players: FeedPlayerSim[] = [];
  for (const item of row.players) {
    const player = playerSimOf(item);
    if (!player) return undefined;
    players.push(player);
  }
  const plan = planOf(row.plan);
  if (row.plan !== undefined && plan === undefined) return undefined;
  return { draws: row.draws as number, away_points: away, home_points: home, margin, combined, home_win: row.home_win, players, ...(plan !== undefined ? { plan } : {}) };
}

function validationOf(value: unknown): FeedValidation | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const row = record(value);
  if (!row || !Number.isInteger(row.games) || !finiteNumber(row.win_brier) || !finiteNumber(row.margin_mae) || !finiteNumber(row.td_brier)) return undefined;
  const week = (item: unknown) => item === null || (Number.isInteger(item) && (item as number) > 0);
  if (!week(row.from_week) || !week(row.through_week)) return undefined;
  const coverageRow = record(row.coverage);
  const maeRow = record(row.mae);
  if (!coverageRow || !maeRow) return undefined;
  const coverage: FeedValidation['coverage'] = {};
  for (const [key, item] of Object.entries(coverageRow)) {
    if ((!STAT_SET.has(key) && key !== 'margin' && key !== 'combined') || !chance(item)) return undefined;
    coverage[key as FeedStat] = item;
  }
  const mae = statMap(maeRow, (item) => (finiteNumber(item) && item >= 0 ? item : null));
  if (!mae) return undefined;
  return {
    games: row.games as number,
    from_week: row.from_week as number | null,
    through_week: row.through_week as number | null,
    win_brier: row.win_brier,
    margin_mae: row.margin_mae,
    td_brier: row.td_brier,
    coverage,
    mae,
  };
}

function gameOf(value: unknown): FeedGame | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id);
  const start = text(row.start_time);
  const status = row.status;
  const note = text(row.projection_note);
  const away = sideOf(row.away);
  const home = sideOf(row.home);
  const projection = projectionOf(row.projection);
  if (!id || !start || Number.isNaN(Date.parse(start)) || typeof status !== 'string' || !STATUSES.has(status as FeedStatus)) return null;
  if (!note || !away || !home || projection === undefined || typeof row.listed !== 'boolean') return null;
  if (row.neutral_site !== true && row.neutral_site !== false) return null;
  const venue = row.venue === null ? null : text(row.venue);
  const competition = row.competition === null ? null : text(row.competition);
  if (row.venue !== null && venue === null) return null;
  if (row.competition !== null && competition === null) return null;
  if ((status === 'scheduled' && (away.score !== null || home.score !== null)) || (status !== 'scheduled' && (away.score === null || home.score === null))) return null;
  const sim = simOf(row.sim);
  if (row.sim !== undefined && sim === undefined) return null;
  return {
    id,
    start_time: new Date(start).toISOString(),
    status: status as FeedStatus,
    listed: row.listed,
    away,
    home,
    venue,
    neutral_site: row.neutral_site,
    competition,
    projection,
    projection_note: note,
    ...(sim !== undefined ? { sim } : {}),
  };
}

function modelOf(value: unknown): FeedModel | null {
  const row = record(value);
  if (!row || typeof row.fitted !== 'boolean') return null;
  const name = text(row.name);
  const note = text(row.note);
  if (!name || !note) return null;
  const games = row.holdout_games;
  const brier = row.holdout_brier;
  if (games !== null && (typeof games !== 'number' || !Number.isInteger(games) || games < 0)) return null;
  if (brier !== null && (typeof brier !== 'number' || !Number.isFinite(brier) || brier < 0 || brier > 1)) return null;
  const validation = validationOf(row.validation);
  if (row.validation !== undefined && validation === undefined) return null;
  return { fitted: row.fitted, name, note, holdout_games: games, holdout_brier: brier, ...(validation !== undefined ? { validation } : {}) };
}

/** Rejects a file that carries a price, spread, or total, or that does not match the feed shape. */
export function parseFeedSlate(text: string, sport: FeedSport): FeedSlate | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (banned(value)) return null;
  const row = record(value);
  if (!row || row.sport !== sport || row.timezone !== 'America/Chicago' || typeof row.source !== 'string' || !row.source.trim()) return null;
  const generated = textOfTime(row.generated_at);
  if (!generated || !Array.isArray(row.dates) || row.dates.length !== 2) return null;
  const dates = row.dates;
  if (typeof dates[0] !== 'string' || typeof dates[1] !== 'string' || !DAY.test(dates[0]) || !DAY.test(dates[1])) return null;
  if (!Array.isArray(row.games) || !Array.isArray(row.later)) return null;
  const games: FeedGame[] = [];
  for (const item of row.games) {
    const game = gameOf(item);
    if (!game) return null;
    games.push(game);
  }
  const later: FeedGame[] = [];
  for (const item of row.later) {
    const game = gameOf(item);
    if (!game) return null;
    later.push(game);
  }
  const model = modelOf(row.model);
  if (!model) return null;
  return { sport, source: row.source.trim(), generated_at: generated, timezone: 'America/Chicago', dates: [dates[0], dates[1]], games, later, model };
}

function textOfTime(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function logoMarkup(side: FeedSide): string {
  const url = side.logo_url;
  const mono = `<span class="mono"${url ? ' hidden' : ''}>${escapeHtml(side.abbreviation)}</span>`;
  const image = url ? `<img referrerpolicy="no-referrer" alt="${escapeHtml(side.name)}" src="${escapeHtml(url)}" width="56" height="56">` : '';
  return `<span class="logo">${image}${mono}</span>`;
}

function sideMarkup(side: FeedSide, role: 'Away' | 'Home' | null): string {
  const roleHtml = role ? `<span class="side-role">${role}</span>` : '';
  const recordHtml = side.record ? `<span class="side-role" data-record>${escapeHtml(side.record)}</span>` : '';
  return `<span class="side">${logoMarkup(side)}<span class="side-copy">${roleHtml}<span class="abbr">${escapeHtml(side.abbreviation)}</span><span class="name">${escapeHtml(side.name)}</span>${recordHtml}</span></span>`;
}

function chip(status: FeedStatus): string {
  if (status === 'final') return '<span class="chip" data-state="post">Final</span>';
  if (status === 'in_progress') return '<span class="chip" data-state="live">In progress</span>';
  return '<span class="chip" data-state="pre">Scheduled</span>';
}

function statusLine(game: FeedGame): string {
  const word = game.status === 'in_progress' ? 'in progress' : game.status;
  if (game.status === 'scheduled' || game.away.score === null || game.home.score === null) return word;
  return `${word} · ${game.away.abbreviation} ${game.away.score}, ${game.home.abbreviation} ${game.home.score}`;
}

function tipClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

function renderGame(game: FeedGame): string {
  const where = game.listed
    ? game.competition
    : game.neutral_site
      ? 'Neutral site'
      : game.venue ?? (game.home.name ? `At ${game.home.name}` : null);
  const between = game.listed ? 'vs' : '@';
  const leftRole = game.listed ? null : 'Away';
  const rightRole = game.listed ? null : 'Home';
  const whereHtml = where ? `<p class="where">${escapeHtml(where)}</p>` : '';
  const competition = game.listed ? '' : game.competition ? `<p class="tag">${escapeHtml(game.competition)}</p>` : '';
  const accent = (side: FeedSide) => ({ color: side.color ?? undefined, alternate_color: side.alternate_color ?? undefined });
  return `<article class="game-card" style="${paletteStyle(accent(game.away), accent(game.home))}">
    <div class="card-top"><span class="chip chip-time">${escapeHtml(tipClock(game.start_time))}</span>${chip(game.status)}</div>
    <h2 class="matchup">${sideMarkup(game.away, leftRole)}<span class="at">${between}</span>${sideMarkup(game.home, rightRole)}</h2>
    ${whereHtml}
    <p class="tip">${escapeHtml(formatTip(game.start_time))}</p>
    <p class="status">${escapeHtml(statusLine(game))}</p>
    ${competition}
    ${cardBody(game)}
  </article>`;
}

/**
 * A game with a published plan reads like an NBA card: the matchup, then Simulate, which opens the box score. An older
 * file without a plan keeps its projection on the card, and a game with no simulation keeps its note.
 */
function cardBody(game: FeedGame): string {
  if (game.sim?.plan) return `<div class="card-actions"><button type="button" data-nfl-simulate="${escapeHtml(game.id)}">Simulate</button></div>`;
  if (game.sim) return simMarkup(game, game.sim);
  const projection = game.projection ? `<p class="status" data-projection>${escapeHtml(game.projection.summary)}</p>` : '';
  return `${projection}<p class="note">${escapeHtml(game.projection_note)}</p>`;
}

const STAT_LABEL: Record<FeedStat, string> = {
  pass_yds: 'Pass yds',
  pass_td: 'Pass TD',
  int: 'INT',
  pass_cmp: 'Completions',
  rush_yds: 'Rush yds',
  car: 'Carries',
  rec: 'Receptions',
  rec_yds: 'Rec yds',
  tgt: 'Targets',
};
const YARDS = new Set<FeedStat>(['pass_yds', 'rush_yds', 'rec_yds']);

/** Points and yards as whole numbers; a count is whole when it is, else one decimal. */
function statText(stat: FeedStat | 'points', value: number): string {
  if (stat === 'points' || YARDS.has(stat as FeedStat) || Number.isInteger(value)) return String(Math.round(value));
  return value.toFixed(1);
}

/** A widened range can reach below what a stat can be: counts, passing and receiving yards stop at 0. */
const FLOOR: Partial<Record<FeedStat | 'points' | 'margin', number>> = { rush_yds: -10, margin: Number.NEGATIVE_INFINITY };

function rangeText(stat: FeedStat | 'points' | 'margin', band: FeedBand): string {
  const floor = FLOOR[stat] ?? 0;
  const shown = stat === 'margin' ? 'points' : stat;
  return `${statText(shown, Math.max(floor, band.p10))} to ${statText(shown, band.p90)}`;
}

function signedMargin(sim: FeedGameSim, game: FeedGame): string {
  const mean = sim.margin.mean;
  if (Math.abs(mean) < 0.5) return 'Even';
  return `${mean > 0 ? game.home.abbreviation : game.away.abbreviation} by ${Math.abs(mean).toFixed(1)}`;
}

function playerTiles(player: FeedPlayerSim): string {
  return (Object.entries(player.stats) as [FeedStat, FeedBand][])
    .map(([stat, band]) => {
      const did = player.actual && typeof player.actual[stat] === 'number' ? `<p class="tile-sub" data-actual>Played ${escapeHtml(statText(stat, player.actual[stat]!))}</p>` : '';
      return `<div class="tile"><p class="tile-label">${escapeHtml(STAT_LABEL[stat])}</p><p class="tile-value">${escapeHtml(statText(stat, band.p50))}</p><p class="tile-sub">${escapeHtml(rangeText(stat, band))}</p>${did}</div>`;
    })
    .join('');
}

function playerMarkup(player: FeedPlayerSim): string {
  const status = player.status ? ` · ${escapeHtml(player.status)}` : '';
  const plays = player.play < 0.99 ? ` · plays in ${Math.round(player.play * 100)}% of draws` : '';
  return `<div class="panel-section" data-nfl-player="${escapeHtml(player.id)}"><p class="who-name">${escapeHtml(player.name)}</p><p class="who-team">${escapeHtml(player.position)}${status}${plays} · anytime TD ${Math.round(player.td * 100)}%</p><div class="tiles">${playerTiles(player)}</div></div>`;
}

function simMarkup(game: FeedGame, sim: FeedGameSim): string {
  const team = (side: 'away' | 'home') => {
    const players = sim.players.filter((player) => player.side === side);
    if (!players.length) return '';
    const name = side === 'away' ? game.away.abbreviation : game.home.abbreviation;
    return `<section class="nfl-team"><h3 class="stat-group-label">${escapeHtml(name)}</h3>${players.map(playerMarkup).join('')}</section>`;
  };
  const awayWin = 1 - sim.home_win;
  const away = escapeHtml(game.away.abbreviation);
  const home = escapeHtml(game.home.abbreviation);
  const chance = (share: number) => `${Math.round(share * 100)}%`;
  return `<div class="nfl-sim" data-sim>
    <p class="feed-proj-score"><span class="feed-proj-label">Projected</span><span class="feed-proj-line">${away} ${escapeHtml(statText('points', sim.away_points.mean))} <span class="feed-proj-dash">–</span> ${escapeHtml(statText('points', sim.home_points.mean))} ${home}</span></p>
    <div class="winbar feed-winbar" role="img" aria-label="Win chance ${away} ${chance(awayWin)}, ${home} ${chance(sim.home_win)}"><span class="seg seg-away" style="flex-grow: ${awayWin}"></span><span class="seg seg-home" style="flex-grow: ${sim.home_win}"></span></div>
    <p class="feed-proj-chances"><span>${away} ${chance(awayWin)}</span><span>${escapeHtml(signedMargin(sim, game))}</span><span>${home} ${chance(sim.home_win)}</span></p>
    <p class="feed-proj-range">Margin ${escapeHtml(rangeText('margin', sim.margin))} for ${home} · ${escapeHtml(rangeText('points', sim.combined))} points, 8 in 10 games</p>
    ${sim.plan ? '' : `<details class="nfl-players"><summary>Player projections</summary><p class="note">Big number is the median of the draws he plays in; below it, the 10th to 90th percentile.</p>${team('away')}${team('home')}</details>`}
  </div>`;
}

function dayTitle(gameDate: string, today: string): string {
  if (gameDate === today) return 'Today';
  if (gameDate === shiftChicagoDate(today, -1)) return 'Yesterday';
  return gameDate;
}

function section(title: string, games: readonly FeedGame[]): string {
  const cards = games.map((game) => renderGame(game)).join('');
  return `<section class="slate-day"><h2 class="slate-title">${escapeHtml(title)}</h2><div class="slate">${cards}</div></section>`;
}

export function renderFeedSlate(slate: FeedSlate, now: Date): string {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  const sportName = 'NFL';
  const current = slate.dates[0] === yesterday && slate.dates[1] === today;
  const stale = current
    ? ''
    : `<p class="state" role="alert">This ${sportName} slate was published for ${escapeHtml(slate.dates[0])} and ${escapeHtml(slate.dates[1])}, not the current Chicago window.</p>`;
  const built = `Published ${formatTip(slate.generated_at)} · ${slate.source}`;
  const next = [...slate.games, ...slate.later].filter((game) => game.status === 'scheduled' && Date.parse(game.start_time) > now.getTime()).map((game) => game.start_time).sort()[0];
  const count = slate.games.length + slate.later.filter((game) => chicagoDate(new Date(game.start_time)) > today).length;
  const meta = [`${sportName} · ${count} ${count === 1 ? 'game' : 'games'}`, next ? `next kickoff ${formatTip(next)}` : ''].filter(Boolean).join(' · ');
  const head = `<div class="feed-head"><div class="feed-titles"><p class="slate-meta">${escapeHtml(meta)}</p><p class="status captured">${escapeHtml(built)}</p></div><details class="method-note"><summary>How these projections work</summary><p class="note">${escapeHtml(slate.model.note)}</p>${validationMarkup(slate.model.validation)}</details></div>`;
  const byDate = new Map<string, FeedGame[]>();
  for (const game of slate.games) {
    const day = chicagoDate(new Date(game.start_time));
    const list = byDate.get(day) ?? [];
    list.push(game);
    byDate.set(day, list);
  }
  const days = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  const windowHtml = days.map((day) => section(dayTitle(day, today), byDate.get(day) ?? [])).join('');
  const upcoming = slate.later.filter((game) => chicagoDate(new Date(game.start_time)) > today);
  const empty =
    slate.games.length > 0
      ? windowHtml
      : `<p class="state">No ${sportName} games today or yesterday.${upcoming.length ? ' The rest of this week is below.' : ''}</p>`;
  const laterDays = new Map<string, FeedGame[]>();
  for (const game of [...upcoming].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
    const day = chicagoDate(new Date(game.start_time));
    laterDays.set(day, [...(laterDays.get(day) ?? []), game]);
  }
  const later = [...laterDays.entries()].map(([day, games]) => section(laterTitle(day), games)).join('');
  return `${stale}${head}${empty}${later}`;
}

/** How the simulation did on earlier weeks it projected without seeing them. */
function validationMarkup(validation: FeedValidation | null | undefined): string {
  if (!validation || !validation.games) return '';
  const weeks = validation.from_week && validation.through_week ? `weeks ${validation.from_week} to ${validation.through_week}` : 'earlier weeks';
  const covered = (['rec_yds', 'rush_yds', 'pass_yds'] as const)
    .filter((stat) => typeof validation.coverage[stat] === 'number')
    .map((stat) => `${STAT_LABEL[stat].toLowerCase()} ${Math.round(validation.coverage[stat]! * 100)}%`)
    .join(', ');
  return `<p class="note" data-validation>Checked on ${escapeHtml(weeks)} (${validation.games} games), each projected only from the weeks before it: win Brier ${validation.win_brier.toFixed(3)} (a coin is 0.250), margin off by ${validation.margin_mae.toFixed(1)} points on average. The 10th to 90th ranges are calibrated on those weeks to hold 8 in 10 results${covered ? `: ${escapeHtml(covered)}` : ''}.</p>`;
}

/** "Sunday, Nov 22" for a Chicago date. */
function laterTitle(day: string): string {
  const noon = new Date(`${day}T18:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric' }).format(noon);
}
