import { chicagoDate, formatTip, shiftChicagoDate } from '../date.ts';
import { escapeHtml } from '../slate.ts';
import { CS2_STATS, DOTA_STATS, LOL_STATS, MIN_GAMES } from './config.ts';

export const ESPORTS_MODEL_NAME = 'esports-player-means-v1';

export const ESPORTS_MODEL_NOTE =
  `Each number is that player's arithmetic mean of the stat on earlier games, and the displayed game is excluded. Dota 2 and League of Legends treat one game as one map. CS2 divides each earlier series total by that series' map count, then takes the mean of those per-map values. A stat with fewer than ${MIN_GAMES} earlier games is not fitted. No match winner and no posted line were used.`;

export type EsportsStat = (typeof DOTA_STATS)[number] | (typeof LOL_STATS)[number] | (typeof CS2_STATS)[number];

export interface EsportsProp {
  stat: EsportsStat;
  /** Unrounded mean. Null when fewer than MIN_GAMES earlier values are present. */
  mean: number | null;
}

export interface EsportsPlayer {
  name: string;
  team: string;
  props: EsportsProp[];
}

export interface EsportsMatch {
  id: string;
  start_time: string;
  teams: [string, string];
  competition: string | null;
  players: EsportsPlayer[];
}

export interface EsportsTitle {
  title: 'Dota 2' | 'League of Legends' | 'CS2';
  source: string;
  matches: EsportsMatch[];
}

export interface EsportsModel {
  name: typeof ESPORTS_MODEL_NAME;
  fitted: boolean;
  note: string;
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

export function esportsDocument(titles: readonly EsportsTitle[], now: Date): EsportsDocument {
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
    },
    titles: titles.map((title) => ({
      title: title.title,
      source: title.source,
      matches: title.matches.map((match) => ({
        id: match.id,
        start_time: match.start_time,
        teams: [match.teams[0], match.teams[1]],
        competition: match.competition,
        players: match.players.map((player) => ({
          name: player.name,
          team: player.team,
          props: player.props.map((prop) => ({ stat: prop.stat, mean: prop.mean })),
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
  return { stat: stat as EsportsStat, mean: row.mean === null ? null : finite(row.mean) };
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
  return { id, start_time: new Date(start).toISOString(), teams: [left, right], competition, players };
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
  if (row.name !== ESPORTS_MODEL_NAME) return null;
  const note = text(row.note);
  if (!note) return null;
  const fitted = row.fitted === true;
  return { name: ESPORTS_MODEL_NAME, fitted, note };
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

function renderPlayer(player: EsportsPlayer): string {
  const tiles = player.props.map((prop) => {
    const shown = formatStat(prop.mean);
    return `<div class="tile"><p class="tile-label">${escapeHtml(STAT_LABEL[prop.stat])}</p><p class="tile-value">${escapeHtml(shown)}</p></div>`;
  }).join('');
  return `<div class="panel-section"><p class="who-name">${escapeHtml(player.name)}</p><p class="who-team">${escapeHtml(player.team)}</p><div class="tiles">${tiles}</div></div>`;
}

function renderMatch(match: EsportsMatch, now: Date): string {
  const where = match.competition ? `<p class="where">${escapeHtml(match.competition)}</p>` : '';
  const players = match.players.map((player) => renderPlayer(player)).join('');
  return `<article class="game-card"><h2 class="matchup">${escapeHtml(match.teams[0])} <span class="at">vs</span> ${escapeHtml(match.teams[1])}</h2>${where}<p class="status">${escapeHtml(whenLabel(match.start_time, now))}</p>${players}</article>`;
}

export function renderEsports(doc: EsportsDocument, now: Date): string {
  const sources = doc.titles.map((title) => title.source).join(', ');
  const built = `Published ${formatTip(doc.generated_at)} · ${sources}`;
  const head = `<div class="slate-head"><p class="slate-meta">Esports</p><p class="status captured">${escapeHtml(built)}</p><p class="note">${escapeHtml(doc.model.note)}</p></div>`;
  const sections = doc.titles.map((title) => {
    const cards = title.matches.map((match) => renderMatch(match, now)).join('');
    return `<section class="slate-day"><h2 class="slate-title">${escapeHtml(title.title)}</h2><div class="slate">${cards}</div></section>`;
  }).join('');
  return `${head}${sections}`;
}
