import { chicagoDate, formatTip, shiftChicagoDate } from './date.ts';
import { paletteStyle } from './display.ts';
import { escapeHtml } from './slate.ts';

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
}

export interface FeedModel {
  fitted: boolean;
  name: string;
  note: string;
  holdout_games: number | null;
  holdout_brier: number | null;
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
  return { fitted: row.fitted, name, note, holdout_games: games, holdout_brier: brier };
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
    ${game.projection ? `<p class="status">${escapeHtml(game.projection.summary)}</p>` : ''}
    <p class="note">${escapeHtml(game.projection_note)}</p>
  </article>`;
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
  const head = `<div class="slate-head"><p class="slate-meta">${escapeHtml(sportName)}</p><p class="status captured">${escapeHtml(built)}</p><p class="note">${escapeHtml(slate.model.note)}</p></div>`;
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

/** "Sunday, Nov 22" for a Chicago date. */
function laterTitle(day: string): string {
  const noon = new Date(`${day}T18:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'short', day: 'numeric' }).format(noon);
}
