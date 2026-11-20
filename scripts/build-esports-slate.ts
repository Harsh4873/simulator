import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import { BO3_API, CS2_STATS, DOTA_STATS, ESPORTS_USER_AGENT, LEAGUEPEDIA_API, LOL_STATS, OPENDOTA_API } from '../src/esports/config.ts';
import {
  cargoCount,
  cs2PerMapMean,
  earlierMean,
  esportsDocument,
  parseEsportsDocument,
  type EsportsMatch,
  type EsportsPlayer,
  type EsportsProp,
  type EsportsTitle,
  type SeriesRow,
} from '../src/esports/props.ts';

const OUT = 'public/data/esports.json';
const PRO_MATCH_PAGES = 3;
const SHOWN_MATCH_DETAILS = 6;
const HISTORY_LIMIT = 100;
const FALLBACK_MATCHES = 4;
const CARGO_LIMIT = '500';
const CS_PAGE_LIMIT = 20;
const CS_DISCIPLINE = 1;
const CARGO_FIELDS = [
  'ScoreboardPlayers.Link',
  'ScoreboardPlayers.Team',
  'ScoreboardPlayers.Kills',
  'ScoreboardPlayers.Deaths',
  'ScoreboardPlayers.Assists',
  'ScoreboardPlayers.CS',
  'ScoreboardPlayers.GameId',
  'ScoreboardGames.Team1',
  'ScoreboardGames.Team2',
  'ScoreboardGames.Tournament',
  'ScoreboardGames.DateTime_UTC',
  'ScoreboardGames.Winner',
].join(',');
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function realName(value: unknown): string | null {
  const name = text(value);
  if (!name || /^(tbd|tba|unknown)$/i.test(name)) return null;
  return name;
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

let dotaAt = 0;

async function paceDota(): Promise<void> {
  const wait = dotaAt - Date.now();
  dotaAt = Math.max(Date.now(), dotaAt) + 1100;
  if (wait > 0) await sleep(wait);
}

async function dotaGet(path: string): Promise<unknown> {
  const url = `${OPENDOTA_API}${path}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await paceDota();
    const response = await fetch(url, {
      headers: { 'user-agent': ESPORTS_USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429) {
      await sleep(5000);
      continue;
    }
    if (!response.ok) throw new Error(`OpenDota failed (${response.status})`);
    return response.json();
  }
  throw new Error('OpenDota rate limit');
}

async function bo3Get(path: string): Promise<unknown> {
  const url = `${BO3_API}${path}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: { 'user-agent': ESPORTS_USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429 || response.status === 503) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!response.ok) throw new Error(`BO3.gg failed (${response.status})`);
    return response.json();
  }
  throw new Error('BO3.gg rate limit');
}

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function selectForTitle<T extends { start_time: string }>(rows: readonly T[], now: Date, cap: number | null): T[] {
  const ordered = [...rows].sort((left, right) => Date.parse(right.start_time) - Date.parse(left.start_time));
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  const windowed = ordered.filter((row) => {
    const day = chicagoDate(new Date(row.start_time));
    return day === today || day === yesterday;
  });
  const chosen = windowed.length > 0 ? windowed : ordered.slice(0, FALLBACK_MATCHES);
  return cap === null ? chosen : chosen.slice(0, cap);
}

function publish(doc: ReturnType<typeof esportsDocument>): void {
  const raw = `${JSON.stringify(doc)}\n`;
  if (!parseEsportsDocument(raw)) throw new Error('Esports slate failed validation');
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, raw);
  renameSync(tmp, OUT);
}

interface ProGame {
  id: number;
  startMs: number;
  start_time: string;
  radiant: string;
  dire: string;
  league: string;
  /** OpenDota lists finished pro games only. */
  radiantWin: boolean | null;
}

function realPro(row: Record<string, unknown>): ProGame | null {
  const id = row.match_id;
  const start = row.start_time;
  const radiant = realName(row.radiant_name);
  const dire = realName(row.dire_name);
  const league = text(row.league_name);
  if (typeof id !== 'number' || !Number.isFinite(id) || typeof start !== 'number' || !(start > 0)) return null;
  if (!radiant || !dire || !league) return null;
  const startMs = start * 1000;
  const radiantWin = typeof row.radiant_win === 'boolean' ? row.radiant_win : null;
  return { id, startMs, start_time: new Date(startMs).toISOString(), radiant, dire, league, radiantWin };
}

/** The winning side's name, when the game says who won and the two names differ. */
function sideWinner(teams: [string, string], firstWon: boolean | null): string | null {
  if (firstWon === null || teams[0] === teams[1]) return null;
  return firstWon ? teams[0] : teams[1];
}

interface DotaHist {
  matchId: number;
  start: number;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

function readDotaHistory(payload: unknown): DotaHist[] {
  if (!Array.isArray(payload)) return [];
  const rows: DotaHist[] = [];
  const seen = new Set<number>();
  for (const item of payload) {
    const row = record(item);
    if (!row) continue;
    const matchId = row.match_id;
    const start = row.start_time;
    if (typeof matchId !== 'number' || !Number.isFinite(matchId) || seen.has(matchId)) continue;
    if (typeof start !== 'number' || !Number.isFinite(start)) continue;
    seen.add(matchId);
    rows.push({
      matchId,
      start: start * 1000,
      kills: countOf(row.kills),
      deaths: countOf(row.deaths),
      assists: countOf(row.assists),
    });
  }
  return rows;
}

function dotaProps(
  history: readonly DotaHist[],
  listed: ReadonlySet<number>,
  matchId: number,
  startMs: number,
  played: Record<(typeof DOTA_STATS)[number], number | null>,
): EsportsProp[] {
  const kept = history.filter((row) => listed.has(row.matchId));
  return DOTA_STATS.map((stat) => ({
    stat,
    mean: earlierMean(kept.map((row) => ({ id: String(row.matchId), start: row.start, value: row[stat] })), String(matchId), startMs),
    actual: played[stat],
  }));
}

async function buildDota(now: Date): Promise<EsportsTitle | null> {
  const listed = new Set<number>();
  const games: ProGame[] = [];
  const seen = new Set<number>();
  let before: number | null = null;
  for (let page = 0; page < PRO_MATCH_PAGES; page += 1) {
    const path = before === null ? '/proMatches' : `/proMatches?less_than_match_id=${before}`;
    const payload = await dotaGet(path);
    if (!Array.isArray(payload) || payload.length === 0) break;
    let minId = Infinity;
    for (const item of payload) {
      const row = record(item);
      if (!row || typeof row.match_id !== 'number' || !Number.isFinite(row.match_id)) continue;
      listed.add(row.match_id);
      if (row.match_id < minId) minId = row.match_id;
      const game = realPro(row);
      if (!game || seen.has(game.id)) continue;
      seen.add(game.id);
      games.push(game);
    }
    if (!Number.isFinite(minId) || (before !== null && minId >= before)) break;
    before = minId;
  }
  const shown = selectForTitle(games, now, SHOWN_MATCH_DETAILS);
  const historyCache = new Map<number, DotaHist[]>();
  const matches: EsportsMatch[] = [];
  for (const game of shown) {
    let detail: unknown;
    try {
      detail = await dotaGet(`/matches/${game.id}`);
    } catch (error) {
      console.error(`esports Dota 2 match ${game.id} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
      continue;
    }
    const body = record(detail);
    const roster = body && Array.isArray(body.players) ? body.players : [];
    const players: { accountId: number | null; name: string; team: string; played: Record<(typeof DOTA_STATS)[number], number | null> }[] = [];
    for (const item of roster) {
      const player = record(item);
      if (!player || typeof player.player_slot !== 'number' || !Number.isFinite(player.player_slot)) continue;
      const name = text(player.name) ?? text(player.personaname);
      if (!name) continue;
      const accountId = typeof player.account_id === 'number' && Number.isInteger(player.account_id) && player.account_id > 0 ? player.account_id : null;
      const played = { kills: countOf(player.kills), deaths: countOf(player.deaths), assists: countOf(player.assists) };
      players.push({ accountId, name, team: player.player_slot < 128 ? game.radiant : game.dire, played });
    }
    if (players.length === 0) continue;
    const built: EsportsPlayer[] = [];
    for (const player of players) {
      let history: DotaHist[] = [];
      if (player.accountId !== null) {
        const cached = historyCache.get(player.accountId);
        if (cached) history = cached;
        else {
          try {
            history = readDotaHistory(await dotaGet(`/players/${player.accountId}/matches?limit=${HISTORY_LIMIT}`));
          } catch (error) {
            console.error(`esports Dota 2 player ${player.accountId} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
            history = [];
          }
          historyCache.set(player.accountId, history);
        }
      }
      built.push({ name: player.name, team: player.team, props: dotaProps(history, listed, game.id, game.startMs, player.played) });
    }
    const teams: [string, string] = [game.radiant, game.dire];
    const radiantWin = body && typeof body.radiant_win === 'boolean' ? body.radiant_win : game.radiantWin;
    matches.push({
      id: String(game.id),
      start_time: game.start_time,
      teams,
      competition: game.league,
      status: 'finished',
      winner: sideWinner(teams, radiantWin),
      score: null,
      players: built,
    });
  }
  if (matches.length === 0) return null;
  return { title: 'Dota 2', source: 'OpenDota', matches };
}

interface LolFlat {
  gameId: string;
  stamp: string;
  startMs: number;
  start_time: string;
  team1: string;
  team2: string;
  tournament: string | null;
  player: string;
  team: string;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  cs: number | null;
  /** 1 when Team1 won the game, 2 when Team2 did. */
  winner: 1 | 2 | null;
}

function cargoFailed(body: unknown): boolean {
  const row = record(body);
  if (!row || !Array.isArray(row.cargoquery)) return true;
  return Boolean(row.error);
}

async function cargoFetch(where: string, order: boolean): Promise<unknown | null> {
  const params = new URLSearchParams({
    action: 'cargoquery',
    format: 'json',
    tables: 'ScoreboardPlayers,ScoreboardGames',
    join_on: 'ScoreboardPlayers.GameId=ScoreboardGames.GameId',
    fields: CARGO_FIELDS,
    where,
    limit: CARGO_LIMIT,
  });
  if (order) params.set('order_by', 'ScoreboardGames.DateTime_UTC DESC');
  try {
    const response = await fetch(`${LEAGUEPEDIA_API}?${params}`, {
      headers: { 'user-agent': ESPORTS_USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || cargoFailed(body)) return null;
    return body;
  } catch {
    return null;
  }
}

async function cargoRows(where: string): Promise<LolFlat[] | null> {
  let body = await cargoFetch(where, true);
  if (body === null) body = await cargoFetch(where, false);
  if (body === null) return null;
  const row = record(body);
  const list = row && Array.isArray(row.cargoquery) ? row.cargoquery : [];
  const parsed: LolFlat[] = [];
  for (const item of list) {
    const wrapped = record(item);
    const fields = wrapped ? record(wrapped.title) : null;
    if (!fields) continue;
    const gameId = text(fields.GameId);
    const stamp = text(fields['DateTime UTC']);
    const team1 = realName(fields.Team1);
    const team2 = realName(fields.Team2);
    const player = text(fields.Link);
    const team = realName(fields.Team);
    if (!gameId || !stamp || !STAMP.test(stamp) || !team1 || !team2 || !player || !team) continue;
    const startMs = Date.parse(`${stamp.replace(' ', 'T')}Z`);
    if (!Number.isFinite(startMs)) continue;
    parsed.push({
      gameId,
      stamp,
      startMs,
      start_time: new Date(startMs).toISOString(),
      team1,
      team2,
      tournament: text(fields.Tournament),
      player,
      team,
      kills: cargoCount(fields.Kills),
      deaths: cargoCount(fields.Deaths),
      assists: cargoCount(fields.Assists),
      cs: cargoCount(fields.CS),
      winner: cargoCount(fields.Winner) === 1 ? 1 : cargoCount(fields.Winner) === 2 ? 2 : null,
    });
  }
  return parsed;
}

function dedupeLol(rows: readonly LolFlat[]): LolFlat[] {
  const seen = new Set<string>();
  const kept: LolFlat[] = [];
  for (const row of rows) {
    const key = `${row.gameId}\n${row.player}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

interface LolGame {
  id: string;
  start_time: string;
  startMs: number;
  teams: [string, string];
  competition: string | null;
  winner: 1 | 2 | null;
  players: { name: string; team: string }[];
}

function groupLol(rows: readonly LolFlat[]): LolGame[] {
  const games = new Map<string, LolGame>();
  for (const row of rows) {
    let game = games.get(row.gameId);
    if (!game) {
      game = { id: row.gameId, start_time: row.start_time, startMs: row.startMs, teams: [row.team1, row.team2], competition: row.tournament, winner: row.winner, players: [] };
      games.set(row.gameId, game);
    }
    if (game.players.some((player) => player.name === row.player)) continue;
    game.players.push({ name: row.player, team: row.team });
  }
  return [...games.values()];
}

function lolValue(row: LolFlat, stat: (typeof LOL_STATS)[number]): number | null {
  return stat === 'kills' ? row.kills : stat === 'deaths' ? row.deaths : stat === 'assists' ? row.assists : row.cs;
}

function lolProps(player: string, game: LolGame, rows: readonly LolFlat[]): EsportsProp[] {
  const history = rows.filter((row) => row.player === player);
  const played = history.find((row) => row.gameId === game.id) ?? null;
  return LOL_STATS.map((stat) => ({
    stat,
    mean: earlierMean(history.map((row) => ({ id: row.gameId, start: row.startMs, value: lolValue(row, stat) })), game.id, game.startMs),
    actual: played ? lolValue(played, stat) : null,
  }));
}

function chicagoNextStart(now: Date): string {
  const tomorrow = shiftChicagoDate(chicagoDate(now), 1);
  for (const hour of [5, 6, 4, 7]) {
    const instant = Date.parse(`${tomorrow}T${String(hour).padStart(2, '0')}:00:00Z`);
    if (chicagoDate(new Date(instant)) === tomorrow && chicagoDate(new Date(instant - 60_000)) !== tomorrow) {
      return `${tomorrow} ${String(hour).padStart(2, '0')}:00:00`;
    }
  }
  return `${tomorrow} 06:00:00`;
}

/** Players per history query: about 40 recent games each stays under the 500-row Cargo limit. */
const LOL_HISTORY_CHUNK = 10;

/** A Cargo string literal, or null for a name that cannot be quoted safely. */
function cargoQuoted(name: string): string | null {
  return /^[^'"\\;]+$/.test(name) ? `'${name}'` : null;
}

/**
 * Each shown player's own games. The latest rows across every league reach back only a few days, so a player in a
 * smaller league would otherwise have no earlier games to average.
 */
async function lolPlayerHistory(players: readonly string[]): Promise<LolFlat[]> {
  const quoted = [...new Set(players)].map(cargoQuoted).filter((name): name is string => name !== null);
  const rows: LolFlat[] = [];
  for (let index = 0; index < quoted.length; index += LOL_HISTORY_CHUNK) {
    const names = quoted.slice(index, index + LOL_HISTORY_CHUNK).join(',');
    const chunk = await cargoRows(`ScoreboardPlayers.Link IN (${names}) AND ScoreboardGames.DateTime_UTC >= '2025-01-01 00:00:00'`);
    if (chunk === null) {
      console.error('esports League of Legends player history was not loaded for one batch');
      continue;
    }
    rows.push(...chunk);
  }
  return rows;
}

async function buildLol(now: Date): Promise<EsportsTitle | null> {
  const upper = chicagoNextStart(now);
  const first = await cargoRows(`ScoreboardGames.DateTime_UTC >= '2025-01-01 00:00:00' AND ScoreboardGames.DateTime_UTC < '${upper}'`);
  if (first === null) throw new Error('Leaguepedia request failed');
  let rows = first;
  if (first.length > 0) {
    const oldest = first.reduce((min, row) => (row.stamp < min ? row.stamp : min), first[0]!.stamp);
    if (!STAMP.test(oldest)) throw new Error('Leaguepedia request failed');
    const second = await cargoRows(`ScoreboardGames.DateTime_UTC >= '2025-01-01 00:00:00' AND ScoreboardGames.DateTime_UTC < '${oldest}'`);
    if (second === null) throw new Error('Leaguepedia request failed');
    rows = dedupeLol([...first, ...second]);
  }
  const shown = selectForTitle(groupLol(rows), now, null);
  const history = dedupeLol([...rows, ...(await lolPlayerHistory(shown.flatMap((game) => game.players.map((player) => player.name))))]);
  const matches: EsportsMatch[] = [];
  for (const game of shown) {
    const players = game.players.map((player) => ({ name: player.name, team: player.team, props: lolProps(player.name, game, history) }));
    if (players.length === 0) continue;
    // Leaguepedia scoreboards are filed after a game ends.
    matches.push({
      id: game.id,
      start_time: game.start_time,
      teams: game.teams,
      competition: game.competition,
      status: 'finished',
      winner: game.winner === null ? null : sideWinner(game.teams, game.winner === 1),
      score: null,
      players,
    });
  }
  if (matches.length === 0) return null;
  return { title: 'League of Legends', source: 'Leaguepedia', matches };
}

interface CsTeam {
  name: string;
  slug: string;
  id: number | null;
}

interface CsMatch {
  id: string;
  start_time: string;
  startMs: number;
  status: 'finished' | 'upcoming' | 'current';
  teams: [CsTeam, CsTeam];
  competition: string | null;
  /** Maps won by team1 and team2, when the feed has both. */
  score: [number, number] | null;
  winnerId: number | null;
}

function csTeam(value: unknown, fallbackId: unknown): CsTeam | null {
  const row = record(value);
  if (!row) return null;
  const name = realName(row.name);
  const slug = text(row.slug);
  if (!name || !slug) return null;
  const rawId = typeof row.id === 'number' ? row.id : fallbackId;
  return { name, slug, id: typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : null };
}

const mapCount = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9 ? value : null);

/** Esports status from BO3's. A finished series names its winner by team id. */
export function csResult(match: Pick<CsMatch, 'status' | 'teams' | 'score' | 'winnerId'>): Pick<EsportsMatch, 'status' | 'winner' | 'score'> {
  const status = match.status === 'current' ? 'live' : match.status;
  if (status === 'upcoming') return { status, winner: null, score: null };
  const winner = match.winnerId === null ? null : match.teams.find((team) => team.id === match.winnerId)?.name ?? null;
  return { status, winner: status === 'finished' && match.teams[0].name !== match.teams[1].name ? winner : null, score: match.score };
}

/**
 * Up to five players a side for a match that has not finished: a team page lists its whole active roster, so the five
 * who played most recently stand in for the lineup. A finished match keeps the players whose history includes it.
 */
export function likelyLineup<T extends { slug: string; name: string }>(roster: readonly T[], lastPlayed: (slug: string) => number): T[] {
  return [...roster]
    .sort((a, b) => lastPlayed(b.slug) - lastPlayed(a.slug) || a.name.localeCompare(b.name))
    .slice(0, 5);
}

function readCsMatch(value: unknown): CsMatch | null {
  const row = record(value);
  if (!row || row.discipline_id !== CS_DISCIPLINE) return null;
  const status = row.status;
  if (status !== 'finished' && status !== 'upcoming' && status !== 'current') return null;
  const start = text(row.start_date);
  const startMs = start ? Date.parse(start) : NaN;
  if (!start || !Number.isFinite(startMs)) return null;
  const id = row.id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const left = csTeam(row.team1, row.team1_id);
  const right = csTeam(row.team2, row.team2_id);
  if (!left || !right) return null;
  const tournament = record(row.tournament);
  const first = mapCount(row.team1_score);
  const second = mapCount(row.team2_score);
  return {
    id: String(id),
    start_time: new Date(startMs).toISOString(),
    startMs,
    status,
    teams: [left, right],
    competition: tournament ? text(tournament.name) : null,
    score: status !== 'upcoming' && first !== null && second !== null ? [first, second] : null,
    winnerId: typeof row.winner_team_id === 'number' && Number.isInteger(row.winner_team_id) ? row.winner_team_id : null,
  };
}

function csQuery(offset: number, limit: number): string {
  const params = new URLSearchParams({
    discipline_id: String(CS_DISCIPLINE),
    sort: '-start_date',
    with: 'teams,tournament',
  });
  params.set('page[offset]', String(offset));
  params.set('page[limit]', String(limit));
  return `/matches?${params}`;
}

async function csSlice(offset: number, limit: number): Promise<{ total: number; rows: unknown[] }> {
  const payload = await bo3Get(csQuery(offset, limit));
  const row = record(payload);
  const total = row ? record(row.total) : null;
  const count = total && typeof total.count === 'number' && Number.isFinite(total.count) ? total.count : 0;
  return { total: count, rows: row && Array.isArray(row.results) ? row.results : [] };
}

function rowStart(value: unknown): number {
  const row = record(value);
  return row && typeof row.start_date === 'string' ? Date.parse(row.start_date) : NaN;
}

async function csPageOffset(cutoff: number): Promise<number> {
  const first = await csSlice(0, 1);
  if (first.total <= 0) return 0;
  const earliest = rowStart(first.rows[0]);
  if (Number.isFinite(earliest) && earliest < cutoff) return 0;
  let lo = 0;
  let hi = Math.max(0, first.total - 1);
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const page = await csSlice(mid, 1);
    const start = rowStart(page.rows[0]);
    if (Number.isFinite(start) && start < cutoff) hi = mid;
    else lo = mid;
  }
  return hi;
}

interface CsPlayer {
  slug: string;
  name: string;
}

async function csRoster(slug: string): Promise<CsPlayer[]> {
  try {
    const payload = await bo3Get(`/teams/${encodeURIComponent(slug)}`);
    const row = record(payload);
    const players = row && Array.isArray(row.players) ? row.players : [];
    const list: CsPlayer[] = [];
    for (const item of players) {
      const player = record(item);
      if (!player || player.status !== 1) continue;
      const playerSlug = text(player.slug);
      const name = text(player.nickname);
      if (!playerSlug || !name) continue;
      list.push({ slug: playerSlug, name });
    }
    return list;
  } catch (error) {
    console.error(`esports CS2 roster ${slug} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
    return [];
  }
}

interface CsHist {
  id: string;
  start: number;
  maps: number;
  kills: number | null;
  headshots: number | null;
  deaths: number | null;
  assists: number | null;
}

function readCsHistory(payload: unknown): CsHist[] {
  if (!Array.isArray(payload)) return [];
  const rows: CsHist[] = [];
  for (const item of payload) {
    const row = record(item);
    if (!row) continue;
    const id = row.match_id;
    const start = typeof row.match_start_date === 'string' ? Date.parse(row.match_start_date) : NaN;
    if ((typeof id !== 'number' && typeof id !== 'string') || !Number.isFinite(start)) continue;
    const stats = Array.isArray(row.stats) ? record(row.stats[0]) : null;
    const value = (key: string): number | null => (stats ? countOf(stats[key]) : null);
    rows.push({
      id: String(id),
      start,
      maps: Array.isArray(row.for_game_ids) ? row.for_game_ids.length : 0,
      kills: value('kills'),
      headshots: value('headshots'),
      deaths: value('death'),
      assists: value('assists'),
    });
  }
  return rows;
}

async function csHistory(slug: string): Promise<CsHist[]> {
  try {
    return readCsHistory(await bo3Get(`/players/${encodeURIComponent(slug)}/matches_list_stats/general`));
  } catch (error) {
    console.error(`esports CS2 player ${slug} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
    return [];
  }
}

function csTotal(row: CsHist, stat: (typeof CS2_STATS)[number]): number | null {
  return stat === 'kills' ? row.kills : stat === 'headshots' ? row.headshots : stat === 'deaths' ? row.deaths : row.assists;
}

function csProps(history: readonly CsHist[], matchId: string, startMs: number): EsportsProp[] {
  const played = history.find((row) => row.id === matchId) ?? null;
  return CS2_STATS.map((stat) => {
    const rows: SeriesRow[] = history.map((row) => ({ id: row.id, start: row.start, maps: row.maps, total: csTotal(row, stat) }));
    // This series on the mean's scale: its total over the maps played.
    const total = played ? csTotal(played, stat) : null;
    const actual = played && played.maps > 0 && total !== null ? Number((total / played.maps).toFixed(2)) : null;
    return { stat, mean: cs2PerMapMean(rows, matchId, startMs), actual };
  });
}

async function buildCs(now: Date): Promise<EsportsTitle | null> {
  const tomorrow = shiftChicagoDate(chicagoDate(now), 1);
  let cutoff = Date.parse(`${tomorrow}T06:00:00Z`);
  for (const hour of [5, 6, 4, 7]) {
    const instant = Date.parse(`${tomorrow}T${String(hour).padStart(2, '0')}:00:00Z`);
    if (chicagoDate(new Date(instant)) === tomorrow && chicagoDate(new Date(instant - 60_000)) !== tomorrow) {
      cutoff = instant;
      break;
    }
  }
  const offset = await csPageOffset(cutoff);
  const page = await csSlice(offset, CS_PAGE_LIMIT);
  const matches = page.rows.map((row) => readCsMatch(row)).filter((match): match is CsMatch => match !== null);
  const shown = selectForTitle(matches, now, null);
  const slugs = [...new Set(shown.flatMap((match) => [match.teams[0].slug, match.teams[1].slug]))];
  const rosters = new Map<string, CsPlayer[]>();
  const rosterRows = await mapPool(slugs, 4, async (slug) => ({ slug, players: await csRoster(slug) }));
  for (const row of rosterRows) rosters.set(row.slug, row.players);
  const needed = new Set<string>();
  for (const match of shown) {
    for (const team of match.teams) {
      for (const player of rosters.get(team.slug) ?? []) needed.add(player.slug);
    }
  }
  const histories = new Map<string, CsHist[]>();
  const historyRows = await mapPool([...needed], 4, async (slug) => ({ slug, rows: await csHistory(slug) }));
  for (const row of historyRows) histories.set(row.slug, row.rows);
  const built: EsportsMatch[] = [];
  for (const match of shown) {
    const players: EsportsPlayer[] = [];
    const seen = new Set<string>();
    for (const team of match.teams) {
      const roster = (rosters.get(team.slug) ?? []).filter((player) => !seen.has(player.slug));
      const lineup =
        match.status === 'finished'
          ? roster.filter((player) => (histories.get(player.slug) ?? []).some((row) => row.id === match.id))
          : likelyLineup(roster, (slug) => {
              // Only series before this one count toward who is in the lineup.
              const before = (histories.get(slug) ?? []).filter((row) => row.start < match.startMs).map((row) => row.start);
              return before.length ? Math.max(...before) : Number.NEGATIVE_INFINITY;
            });
      for (const player of lineup) {
        seen.add(player.slug);
        const props = csProps(histories.get(player.slug) ?? [], match.id, match.startMs);
        players.push({ name: player.name, team: team.name, props: match.status === 'finished' ? props : props.map(({ stat, mean }) => ({ stat, mean })) });
      }
    }
    if (players.length === 0) continue;
    built.push({
      id: match.id,
      start_time: match.start_time,
      teams: [match.teams[0].name, match.teams[1].name],
      competition: match.competition,
      ...csResult(match),
      players,
    });
  }
  if (built.length === 0) return null;
  return { title: 'CS2', source: 'BO3.gg', matches: built };
}

async function loadTitle(name: string, build: () => Promise<EsportsTitle | null>): Promise<EsportsTitle | null> {
  try {
    const title = await build();
    if (!title || title.matches.length === 0) {
      console.error(`esports ${name} was not loaded: no player rows`);
      return null;
    }
    const players = title.matches.reduce((sum, match) => sum + match.players.length, 0);
    const fitted = title.matches.reduce((sum, match) => sum + match.players.reduce((inner, player) => inner + player.props.filter((prop) => prop.mean !== null).length, 0), 0);
    console.log(`esports ${name}: ${title.matches.length} matches, ${players} players, ${fitted} fitted stats`);
    return title;
  } catch (error) {
    console.error(`esports ${name} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
    return null;
  }
}

export async function buildEsportsSlate(now = new Date()): Promise<void> {
  const loaded = await Promise.all([
    loadTitle('Dota 2', () => buildDota(now)),
    loadTitle('League of Legends', () => buildLol(now)),
    loadTitle('CS2', () => buildCs(now)),
  ]);
  const titles = loaded.filter((title): title is EsportsTitle => title !== null);
  if (titles.length === 0) throw new Error('Esports slate was not updated');
  const doc = esportsDocument(titles, now);
  publish(doc);
  console.log(`Esports slate: ${titles.map((title) => title.title).join(', ')}; fitted ${doc.model.fitted}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildEsportsSlate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
