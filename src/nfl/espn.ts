import type { FeedSide, FeedStatus } from '../feed.ts';

export interface EspnGame {
  id: string;
  start_time: string;
  status: FeedStatus;
  away: FeedSide;
  home: FeedSide;
  venue: string | null;
  neutral_site: boolean;
  season_year: number | null;
  season_type: number | null;
  home_score: number | null;
  away_score: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function colorOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

function logoOf(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('https://a.espncdn.com/') ? value : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function statusOf(value: unknown): FeedStatus {
  const row = record(value);
  const type = record(row?.type);
  const state = type?.state;
  if (state === 'post' || type?.completed === true) return 'final';
  if (state === 'in') return 'in_progress';
  return 'scheduled';
}

const RECORD = /^\d{1,2}-\d{1,2}(-\d{1,2})?$/;

/** The overall win-loss(-tie) record ESPN lists for a competitor, or null. */
function recordOf(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(record).filter((row) => row !== null);
  const total = rows.find((row) => row.type === 'total' || row.name === 'overall') ?? rows[0];
  const summary = typeof total?.summary === 'string' ? total.summary.trim() : '';
  return RECORD.test(summary) ? summary : null;
}

function sideOf(value: unknown, status: FeedStatus): { side: FeedSide; homeAway: 'home' | 'away' } | null {
  const row = record(value);
  const team = record(row?.team);
  if (!row || !team) return null;
  const name = typeof team.displayName === 'string' ? team.displayName.trim() : '';
  const abbreviation = typeof team.abbreviation === 'string' ? team.abbreviation.trim() : '';
  const homeAway = row.homeAway === 'home' || row.homeAway === 'away' ? row.homeAway : null;
  if (!name || !abbreviation || !homeAway) return null;
  const rawScore = numberOf(row.score);
  const score = status === 'scheduled' ? null : rawScore;
  if (status !== 'scheduled' && score === null) return null;
  return {
    homeAway,
    side: {
      name,
      abbreviation,
      score,
      logo_url: logoOf(team.logo),
      color: colorOf(team.color),
      alternate_color: colorOf(team.alternateColor),
      record: recordOf(row.records),
    },
  };
}

/** Reads the scoreboard's games and ignores every odds object on it. */
export function parseEspnScoreboard(payload: unknown): EspnGame[] {
  const root = record(payload);
  const events = root?.events;
  if (!Array.isArray(events)) throw new Error('Invalid NFL scoreboard');
  const games: EspnGame[] = [];
  for (const event of events) {
    const row = record(event);
    const competition = record(Array.isArray(row?.competitions) ? row.competitions[0] : null);
    if (!row || !competition || typeof row.id !== 'string' || typeof row.date !== 'string' || Number.isNaN(Date.parse(row.date))) continue;
    const status = statusOf(competition.status);
    const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
    const sides = competitors.map((competitor) => sideOf(competitor, status)).filter((side) => side !== null);
    const away = sides.find((side) => side.homeAway === 'away');
    const home = sides.find((side) => side.homeAway === 'home');
    if (!away || !home) continue;
    const season = record(row.season);
    const venue = record(competition.venue);
    const venueName = typeof venue?.fullName === 'string' && venue.fullName.trim() ? venue.fullName.trim() : null;
    games.push({
      id: row.id,
      start_time: new Date(row.date).toISOString(),
      status,
      away: away.side,
      home: home.side,
      venue: venueName,
      neutral_site: competition.neutralSite === true,
      season_year: numberOf(season?.year),
      season_type: numberOf(season?.type),
      away_score: away.side.score,
      home_score: home.side.score,
    });
  }
  return games;
}

export function espnWeek(payload: unknown): number | null {
  const week = record(record(payload)?.week);
  const number = week?.number;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null;
}

export function espnSeasonYear(payload: unknown): number | null {
  const leagues = record(payload)?.leagues;
  const league = record(Array.isArray(leagues) ? leagues[0] : null);
  const season = record(league?.season);
  const year = season?.year;
  return typeof year === 'number' && Number.isInteger(year) ? year : null;
}

/** 1 preseason, 2 regular season, 3 postseason, 4 off season. */
export function espnSeasonType(payload: unknown): number | null {
  const root = record(payload);
  const direct = numberOf(record(root?.season)?.type);
  if (direct !== null) return direct;
  const leagues = root?.leagues;
  const league = record(Array.isArray(leagues) ? leagues[0] : null);
  return numberOf(record(record(league?.season)?.type)?.type);
}

export const NFL_REGULAR_WEEKS = 18;

/** Regular-season weeks on the league calendar, or 18 when the calendar does not list them. */
export function espnRegularWeeks(payload: unknown): number {
  const leagues = record(payload)?.leagues;
  const league = record(Array.isArray(leagues) ? leagues[0] : null);
  const calendar = Array.isArray(league?.calendar) ? league.calendar : [];
  for (const item of calendar) {
    const block = record(item);
    if (block?.label === 'Regular Season' && Array.isArray(block.entries) && block.entries.length > 0) return block.entries.length;
  }
  return NFL_REGULAR_WEEKS;
}

/**
 * The scoreboard weeks that hold this season's completed games. During the regular season that is weeks 1 through the
 * current one. In the postseason ESPN restarts the week count at 1, so it is every regular-season week and then the
 * postseason weeks so far. Preseason and off season have none.
 */
export function historyWeeks(seasonType: number | null, week: number, regularWeeks = NFL_REGULAR_WEEKS): { seasonType: 2 | 3; week: number }[] {
  const regular = (through: number) => Array.from({ length: Math.max(0, through) }, (_, index) => ({ seasonType: 2 as const, week: index + 1 }));
  if (seasonType === 2) return regular(Math.min(week, regularWeeks));
  if (seasonType === 3) return [...regular(regularWeeks), ...Array.from({ length: Math.max(0, week) }, (_, index) => ({ seasonType: 3 as const, week: index + 1 }))];
  return [];
}
