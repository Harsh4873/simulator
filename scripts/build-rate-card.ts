import { mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chicagoDate } from '../src/date.ts';
import { fitPlayers, hasFreeThrowAttempts, type InjuryInput, type RosterPlayer } from '../src/fit.ts';
import { fitMatchup, fitCurrentRoles, eligibleEvents } from '../src/team-model.ts';
import { createHash } from 'node:crypto';
import { validateGeneration } from '../src/validate-card.ts';
import { parseCompletedSummary, parseSummary, type CompletedEvent } from '../src/parse-summary.ts';
import type { OutcomeRow, RateCard, SeasonType, ShootingCache, ShootingRow, Slate, SlateGame, TeamSide } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLATE_PATH = join(ROOT, 'public/data/slate.json');
const RATE_CARD_PATH = join(ROOT, 'public/data/rate-card.json');
const CACHE_PATH = join(ROOT, 'data/shooting-cache.json');
// Development replay can reuse already validated events while refreshing current feeds.
const SUMMARY_CAP = process.argv.includes('--cached-summaries') ? 0 : 400;
const SUMMARY_CONCURRENCY = 8;
const SUMMARY_TIMEOUT_MS = 20_000;
const JSON_TIMEOUT_MS = 20_000;
const GZIP_TIMEOUT_MS = 60_000;
const SIGNED_NUMBER = /[+-]\d+(?:\.\d+)?/;
const SEASON_TYPES: Record<number, SeasonType> = {
  1: 'preseason',
  2: 'regular',
  3: 'postseason',
  4: 'offseason',
  5: 'play-in',
};
const KEPT_STATS = new Set(['points', 'totalRebounds', 'assists', 'three_pointers_made', 'steals', 'blocks', 'turnovers']);
const COLUMNS = ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'pts', 'reb', 'ast'] as const;

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams';
const INJURIES = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const OUTCOME_GZIP =
  'https://raw.githubusercontent.com/Harsh4873/pickledger/main/data/player_props_training/nba_outcome_history.jsonl.gz';

function rosterUrl(teamId: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/roster`;
}

function summaryUrl(eventId: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function numericDescending(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
  return compareText(b, a);
}

export function orderPendingEventIds(
  eventIds: readonly string[],
  input: {
    slateTeamIds: readonly string[];
    eventTeamIds: ReadonlyMap<string, readonly string[]>;
  },
): string[] {
  const slateTeams = new Set(input.slateTeamIds);
  const groupOf = (eventId: string): number => {
    const teams = input.eventTeamIds.get(eventId) ?? [];
    for (const teamId of teams) {
      if (slateTeams.has(teamId)) return 0;
    }
    return 1;
  };
  return [...eventIds].sort((a, b) => {
    const group = groupOf(a) - groupOf(b);
    if (group !== 0) return group;
    return numericDescending(a, b);
  });
}

function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function containsToken(haystack: string, token: string): boolean {
  const source = haystack.toLowerCase();
  const needle = token.trim().toLowerCase();
  if (!needle) return false;
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 || !/[a-z0-9]/.test(source[at - 1] ?? '');
    const afterAt = at + needle.length;
    const after = afterAt >= source.length || !/[a-z0-9]/.test(source[afterAt] ?? '');
    if (before && after) return true;
    from = at + 1;
  }
  return false;
}

export function nbaPicks(payload: unknown): unknown[] {
  if (!isRecord(payload) || !isRecord(payload.nba) || !Array.isArray(payload.nba.picks)) return [];
  return payload.nba.picks;
}

export function spreadCaption(picks: unknown[], awayName: string, homeName: string): string | null {
  const names = `${awayName} ${homeName}`;
  const matches: { pick: string; spread: number | null }[] = [];
  for (const row of picks) {
    if (!isRecord(row) || typeof row.pick !== 'string') continue;
    const pick = row.pick;
    if (!SIGNED_NUMBER.test(pick) || pick.includes(' ML ')) continue;
    const awayNick = String(row.away_team ?? '').trim();
    const homeNick = String(row.home_team ?? '').trim();
    if (!awayNick || !homeNick) continue;
    const inNames = containsToken(names, awayNick) && containsToken(names, homeNick);
    const inPick = containsToken(pick, awayNick) && containsToken(pick, homeNick);
    if (!inNames && !inPick) continue;
    const spread = Number(row.predicted_spread);
    matches.push({ pick, spread: Number.isFinite(spread) ? spread : null });
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].pick;
  const first = matches[0].spread;
  const agree =
    first !== null && matches.every((item) => item.spread !== null && Math.abs(item.spread - first) < 1e-9);
  if (!agree) return null;
  const texts = new Set(matches.map((item) => item.pick));
  return texts.size === 1 ? matches[0].pick : null;
}

function firstCompetition(event: Record<string, unknown>): Record<string, unknown> {
  const competitions = Array.isArray(event.competitions) ? event.competitions : [];
  return isRecord(competitions[0]) ? competitions[0] : {};
}

function seasonTypeOf(event: Record<string, unknown>): SeasonType | null {
  const season = isRecord(event.season) ? event.season : {};
  const typeId = Number(season.type);
  if (Number.isInteger(typeId) && SEASON_TYPES[typeId]) return SEASON_TYPES[typeId];
  const slug = String(season.slug ?? '').trim().toLowerCase();
  if (!slug) return null;
  if (slug.includes('pre')) return 'preseason';
  if (slug.includes('post') || slug.includes('playoff')) return 'postseason';
  if (slug.includes('regular')) return 'regular';
  if (slug.includes('play-in') || slug.includes('playin')) return 'play-in';
  if (slug.includes('off')) return 'offseason';
  return null;
}

function seasonYear(event: Record<string, unknown>, fallback: number): number {
  const season = isRecord(event.season) ? event.season : {};
  const year = Number(season.year);
  return Number.isInteger(year) && year > 0 ? year : fallback;
}

function fallbackSeason(payload: Record<string, unknown>, date: string): number {
  const season = isRecord(payload.season) ? payload.season : {};
  const year = Number(season.year);
  if (Number.isInteger(year) && year > 0) return year;
  const [calendarYear, month] = date.split('-').map((part) => Number(part));
  if (!calendarYear || !month) return calendarYear || 0;
  return month >= 8 ? calendarYear + 1 : calendarYear;
}

function utcStamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function eventStart(event: Record<string, unknown>): string {
  const competition = firstCompetition(event);
  const raw = String(event.date || competition.date || '');
  return raw ? utcStamp(raw) : '';
}

function eventStatus(event: Record<string, unknown>): { status_state: string; completed: boolean | null } {
  const competition = firstCompetition(event);
  const status = isRecord(competition.status) ? competition.status : isRecord(event.status) ? event.status : {};
  const type = isRecord(status.type) ? status.type : {};
  const raw = typeof type.state === 'string' ? type.state.trim().toLowerCase() : '';
  return {
    status_state: raw || 'unknown',
    completed: typeof type.completed === 'boolean' ? type.completed : null,
  };
}

function espnCdnUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.startsWith('https://a.espncdn.com/') ? trimmed : null;
}

function teamSide(competitor: Record<string, unknown>): TeamSide | null {
  const team = isRecord(competitor.team) ? competitor.team : {};
  const teamId = String(team.id ?? competitor.id ?? '').trim();
  if (!teamId) return null;
  const side: TeamSide = {
    team_id: teamId,
    name: String(team.displayName || team.name || team.shortDisplayName || teamId),
    abbreviation: String(team.abbreviation || ''),
  };
  const logo = espnCdnUrl(team.logo);
  if (logo) side.logo_url = logo;
  return side;
}

export function gamesFromScoreboard(payload: unknown, date: string, picks: unknown[]): SlateGame[] {
  const root = isRecord(payload) ? payload : {};
  if (!Array.isArray(root.events)) throw new Error('Invalid scoreboard');
  const events = root.events;
  const seasonFallback = fallbackSeason(root, date);
  const games: SlateGame[] = [];
  for (const event of events) {
    if (!isRecord(event)) throw new Error('Invalid scoreboard event');
    const eventId = String(event.id ?? '').trim();
    if (!eventId) throw new Error('Missing scoreboard event id');
    const competition = firstCompetition(event);
    const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
    let away: TeamSide | null = null;
    let home: TeamSide | null = null;
    for (const competitor of competitors) {
      if (!isRecord(competitor)) continue;
      const side = String(competitor.homeAway ?? '');
      if (side === 'away') away = teamSide(competitor);
      if (side === 'home') home = teamSide(competitor);
    }
    if (!away || !home || away.team_id === home.team_id) throw new Error('Incomplete scoreboard matchup');
    const status = eventStatus(event);
    games.push({
      event_id: eventId,
      date,
      start_time: eventStart(event),
      season: seasonYear(event, seasonFallback),
      season_type: seasonTypeOf(event),
      status_state: status.status_state,
      completed: status.completed,
      away,
      home,
      neutral_site: competition.neutralSite === true,
      spread_caption: spreadCaption(picks, away.name, home.name),
    });
  }
  games.sort((a, b) => compareText(a.start_time, b.start_time) || compareText(a.event_id, b.event_id));
  return games;
}

function pushRosterPlayer(out: RosterPlayer[], teamId: string, item: unknown): void {
  if (!isRecord(item)) return;
  const athleteId = String(item.id ?? '').trim();
  if (!athleteId) return;
  const position = isRecord(item.position) ? String(item.position.abbreviation ?? '').trim() : '';
  const player: RosterPlayer = {
    athlete_id: athleteId,
    name: String(item.displayName || item.fullName || athleteId).trim(),
    team_id: teamId,
    position,
  };
  const headshot = isRecord(item.headshot) ? espnCdnUrl(item.headshot.href) : null;
  if (headshot) player.headshot_url = headshot;
  out.push(player);
}

export function parseRoster(teamId: string, payload: unknown): RosterPlayer[] {
  const root = isRecord(payload) ? payload : {};
  const athletes = Array.isArray(root.athletes) ? root.athletes : [];
  const out: RosterPlayer[] = [];
  for (const entry of athletes) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.items)) {
      for (const item of entry.items) pushRosterPlayer(out, teamId, item);
    } else {
      pushRosterPlayer(out, teamId, entry);
    }
  }
  return out;
}

export function parseInjuries(payload: unknown): InjuryInput[] {
  const root = isRecord(payload) ? payload : {};
  if (!Array.isArray(root.injuries)) throw new Error('Invalid injury report');
  const groups = root.injuries;
  const injuries: InjuryInput[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.injuries)) throw new Error('Invalid injury group');
    for (const item of group.injuries) {
      if (!isRecord(item)) throw new Error('Invalid injury item');
      const athlete = isRecord(item.athlete) ? item.athlete : {};
      const links=Array.isArray(athlete.links)?athlete.links:[];
      const linkedIds=links.filter(isRecord).flatMap(link=>{const match=String(link.href??'').match(/^https:\/\/(?:www\.)?espn\.com\/nba\/player\/(?:[^?]*\/)?_\/id\/(\d+)(?:\/|$)/);return match?[match[1]]:[];});
      const uniqueIds=[...new Set(linkedIds)];
      if(uniqueIds.length>1)throw new Error('Conflicting injury identity');
      const athleteId = String(athlete.id ?? uniqueIds[0] ?? '').trim();
      const name = String(athlete.displayName || athlete.fullName || '').trim();
      if ((!athleteId && !name) || typeof item.status !== 'string' || !item.status.trim()) throw new Error('Missing injury identity or designation');
      injuries.push({ athlete_id: athleteId, name, status: String((isRecord(item.type) && item.type.description) || item.status || 'unknown') });
    }
  }
  return injuries;
}

export function teamIdsFromIndex(payload: unknown): string[] {
  const root = isRecord(payload) ? payload : {};
  const sports = Array.isArray(root.sports) ? root.sports : [];
  const ids: string[] = [];
  for (const sport of sports) {
    if (!isRecord(sport) || !Array.isArray(sport.leagues)) continue;
    for (const league of sport.leagues) {
      if (!isRecord(league) || !Array.isArray(league.teams)) continue;
      for (const entry of league.teams) {
        if (!isRecord(entry) || !isRecord(entry.team)) continue;
        const id = String(entry.team.id ?? '').trim();
        if (id) ids.push(id);
      }
    }
  }
  return ids;
}

export function parseOutcomeLines(text: string): OutcomeRow[] {
  const rows = new Map<string, OutcomeRow>();
  const conflicts = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    if (String(value.sport ?? '').toUpperCase() !== 'NBA') continue;
    const season = Number(value.season);
    if (season !== 2026 && season !== 2027) continue;
    const statKey = String(value.stat_key ?? '');
    if (!KEPT_STATS.has(statKey)) continue;
    const athleteId = String(value.athlete_id ?? '').trim();
    const eventId = String(value.event_id ?? '').trim();
    if (!athleteId || !eventId) continue;
    const actual = Number(value.actual);
    const minutes = Number(value.minutes);
    if (value.actual === null || value.actual === undefined || value.actual === '' || value.minutes === null || value.minutes === undefined || value.minutes === '' || !Number.isInteger(actual) || actual < 0 || !Number.isFinite(minutes) || minutes < 0 || minutes > 90 || !String(value.team_id ?? '').trim()) continue;
    if (value.status === 'pending' || value.result === 'pending') continue;
    const key = `${season}:${eventId}:${athleteId}:${statKey}`;
    const row: OutcomeRow = {
      season,
      athlete_id: athleteId,
      team_id: String(value.team_id ?? '').trim(),
      event_id: eventId,
      stat_key: statKey,
      actual, minutes,
    };
    const previous = rows.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) conflicts.add(key);
    rows.set(key, row);
  }
  for (const key of conflicts) rows.delete(key);
  return [...rows.values()];
}

function teamsByEvent(rows: OutcomeRow[]): Map<string, string[]> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.event_id || !row.team_id) continue;
    let set = grouped.get(row.event_id);
    if (!set) {
      set = new Set();
      grouped.set(row.event_id, set);
    }
    set.add(row.team_id);
  }
  const map = new Map<string, string[]>();
  for (const [eventId, teams] of grouped) map.set(eventId, [...teams]);
  return map;
}

function eventSeasons(rows: OutcomeRow[]): Map<string, number> {
  const votes = new Map<string, Map<number, number>>();
  for (const row of rows) {
    let bucket = votes.get(row.event_id);
    if (!bucket) {
      bucket = new Map();
      votes.set(row.event_id, bucket);
    }
    const increment = row.stat_key === 'points' ? 2 : 1;
    bucket.set(row.season, (bucket.get(row.season) ?? 0) + increment);
  }
  const seasons = new Map<string, number>();
  for (const [eventId, bucket] of votes) {
    let bestSeason = 0;
    let bestVotes = -1;
    for (const [season, count] of bucket) {
      if (count > bestVotes || (count === bestVotes && season > bestSeason)) {
        bestSeason = season;
        bestVotes = count;
      }
    }
    if (bestSeason) seasons.set(eventId, bestSeason);
  }
  return seasons;
}

function loadCache(): ShootingCache {
  const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Partial<ShootingCache>;
  return {
    schema_version: 1,
    fetched_event_ids: Array.isArray(parsed.fetched_event_ids) ? parsed.fetched_event_ids.map((id) => String(id)) : [],
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
  };
}

function mergeShooting(cache: ShootingCache, season: number, games: ReturnType<typeof parseSummary>): void {
  const index = new Map<string, ShootingRow>();
  for (const row of cache.rows) index.set(`${row.athlete_id}|${row.team_id}|${row.season}`, row);
  for (const game of games) {
    const key = `${game.athlete_id}|${game.team_id}|${season}`;
    const existing = index.get(key);
    if (!existing) {
      index.set(key, {
        athlete_id: game.athlete_id,
        team_id: game.team_id,
        season,
        games: 1,
        minutes: game.minutes,
        fgm: game.fgm,
        fga: game.fga,
        tpm: game.tpm,
        tpa: game.tpa,
        ftm: game.ftm,
        fta: game.fta,
        reb: game.reb,
        ast: game.ast,
        pts: game.pts,
      });
      continue;
    }
    existing.games += 1;
    existing.minutes += game.minutes;
    existing.fgm += game.fgm;
    existing.fga += game.fga;
    existing.tpm += game.tpm;
    existing.tpa += game.tpa;
    existing.ftm += game.ftm;
    existing.fta += game.fta;
    existing.reb += game.reb;
    existing.ast += game.ast;
    existing.pts += game.pts;
  }
  cache.rows = [...index.values()];
}

export function eventOutcomes(events: CompletedEvent[]): OutcomeRow[] {
  return events.flatMap(e => e.players.flatMap(p => ([['points',p.pts],['totalRebounds',p.reb],['assists',p.ast],['steals',p.stl],['blocks',p.blk],['turnovers',p.tov]] as const)
    .filter(([,v]) => v !== undefined).map(([stat_key,actual]) => ({season:e.season,event_id:e.event_id,team_id:p.team_id,athlete_id:p.athlete_id,minutes:p.minutes,stat_key,actual:actual!}))));
}

function finishCache(cache: ShootingCache): void {
  cache.fetched_event_ids = [...new Set(cache.fetched_event_ids)].sort(compareText);
  cache.rows.sort(
    (a, b) => a.season - b.season || compareText(a.team_id, b.team_id) || compareText(a.athlete_id, b.athlete_id),
  );
}

export async function fetchWithRetry(url: string | URL, timeoutMs: number): Promise<Response> {
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
      if(response.ok)return response;
      if(![408,429,500,502,503,504].includes(response.status)||attempt===2)throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();
    }catch(error){
      if(attempt===2 || (error instanceof Error && /^HTTP /.test(error.message)))throw error;
    }
    await new Promise(resolve=>setTimeout(resolve,250*2**attempt));
  }
  throw new Error('Fetch retries exhausted');
}
async function fetchJson(url: string | URL, timeoutMs: number): Promise<unknown> {
  return (await fetchWithRetry(url,timeoutMs)).json() as Promise<unknown>;
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index] as T);
    }
  };
  if (items.length === 0) return results;
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}

export async function buildRateCard(): Promise<void> {
  const now = new Date();
  const date = chicagoDate(now);
  const generatedAt = stamp(now);
  const scoreboardUrl = new URL(SCOREBOARD);
  scoreboardUrl.searchParams.set('dates', date.replaceAll('-', ''));
  scoreboardUrl.searchParams.set('limit', '100');
  let scoreboard: unknown;
  try {
    scoreboard = await fetchJson(scoreboardUrl, JSON_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`scoreboard failed: ${message(error)}`);
  }

  const [teamIndex, injuryPayload, gzipText] = await Promise.all([
    fetchJson(TEAMS, JSON_TIMEOUT_MS).catch((error: unknown) => {
      console.error(`team index failed: ${message(error)}`);
      throw error;
    }),
    fetchJson(INJURIES, JSON_TIMEOUT_MS).catch((error: unknown) => {
      throw new Error(`injuries failed: ${message(error)}`);
    }),
    fetchWithRetry(OUTCOME_GZIP,GZIP_TIMEOUT_MS)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${OUTCOME_GZIP}`);
        return gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
      })
      .catch((error: unknown) => {
        console.error(`outcome history failed: ${message(error)}`);
        return null;
      }),
  ]);

  const picks: unknown[] = [];
  const games = gamesFromScoreboard(scoreboard, date, picks);
  const slate: Slate = {
    schema_version: 1,
    generated_at: generatedAt,
    date,
    timezone: 'America/Chicago',
    games,
  };

  const slateTeamIds = [...new Set(games.flatMap((game) => [game.away.team_id, game.home.team_id]))];
  const teamIds = teamIndex ? teamIdsFromIndex(teamIndex) : slateTeamIds;
  const rosterIds = teamIds.length > 0 ? teamIds : slateTeamIds;
  const rosterGroups = await mapLimit(rosterIds, SUMMARY_CONCURRENCY, async (teamId) => {
    try {
      return parseRoster(teamId, await fetchJson(rosterUrl(teamId), JSON_TIMEOUT_MS));
    } catch (error) {
      console.error(`roster ${teamId} failed: ${message(error)}`);
      throw error;
    }
  });
  const roster = rosterGroups.flat();
  const injuries = parseInjuries(injuryPayload);
  const outcomes = gzipText === null ? null : parseOutcomeLines(gzipText);
  if (!outcomes?.length) throw new Error('Required outcome history is empty');
  for (const team of slateTeamIds) if (!roster.some(p => p.team_id === team)) throw new Error(`Missing roster ${team}`);
  const cache = loadCache();
  const previousCache = serialize(cache);
  let summariesFetched = 0;
  let summariesFailed = 0;

  if (outcomes) {
    const fetched = new Set((cache.events ?? []).map(e => e.event_id));
    const seasons = eventSeasons(outcomes);
    const recent = cache.events!.slice(-20).map(e=>e.event_id).filter(id=>seasons.has(id));
    const pending = [...recent, ...orderPendingEventIds(
      [...seasons.keys()].filter((eventId) => !fetched.has(eventId)),
      { slateTeamIds, eventTeamIds: teamsByEvent(outcomes) },
    )].slice(0, SUMMARY_CAP);
    await mapLimit(pending, SUMMARY_CONCURRENCY, async (eventId) => {
      try {
        const event = parseCompletedSummary(await fetchJson(summaryUrl(eventId), SUMMARY_TIMEOUT_MS), eventId);
        if (Date.parse(event.start_time) >= now.getTime()) throw new Error('Future summary');
        cache.events = cache.events!.filter(e=>e.event_id!==eventId);
        cache.events.push(event);
        const rows = event.players;
        fetched.add(eventId);
        summariesFetched += 1;
        const season = seasons.get(eventId);
        if (season) mergeShooting(cache, season, rows);
      } catch (error) {
        summariesFailed += 1;
        console.error(`summary ${eventId} failed: ${message(error)}`);
      }
    });
    cache.fetched_event_ids = [...fetched];
  }

  cache.events!.sort((a,b) => compareText(a.start_time,b.start_time) || compareText(a.event_id,b.event_id));
  // Legacy aggregates lack event lineage; rebuild solely from validated regular-season boxes.
  cache.rows = [];
  const trainingEvents = eligibleEvents(cache.events!,generatedAt);
  for (const event of trainingEvents) mergeShooting(cache,event.season,event.players);
  finishCache(cache);
  const nextCache = `${JSON.stringify(cache,null,2)}\n`;
  if (nextCache !== previousCache) writeFileSync(CACHE_PATH, nextCache);

  let rateCardPublished = false;
  if (outcomes && hasFreeThrowAttempts(cache.rows)) {
    const fitted = fitPlayers({ roster, injuries, outcomes: eventOutcomes(trainingEvents), shooting: cache.rows });
    fitCurrentRoles(fitted.players, trainingEvents, games[0]?.season ?? 2027);
    const covered = games.length === 0 || fitted.players.some((player) => slateTeamIds.includes(player.team_id));
    if (fitted.publish && covered) {
      const rateCard: RateCard = {
        schema_version: 1,
        generated_at: generatedAt,
        date,
        iterations: 10000,
        model_version: 'possessions-v1',
        source_cutoff: generatedAt,
        generator_sha: process.env.GENERATOR_SHA ?? process.env.GITHUB_SHA ?? 'local-uncommitted',
        input_hash: createHash('sha256').update(serialize({roster,injuries,events:trainingEvents})).digest('hex'),
        columns: [...COLUMNS],
        games: games.flatMap((game) => {
          const awayPlayers = fitted.players
            .filter((player) => player.team_id === game.away.team_id)
            .sort((a, b) => compareText(a.athlete_id, b.athlete_id));
          const homePlayers = fitted.players
            .filter((player) => player.team_id === game.home.team_id)
            .sort((a, b) => compareText(a.athlete_id, b.athlete_id));
          const players = [...awayPlayers, ...homePlayers];
          if (players.length === 0) return [];
          return [
            {
              event_id: game.event_id,
              away_team_id: game.away.team_id,
              home_team_id: game.home.team_id,
              players,
              context: fitMatchup(trainingEvents,game,generatedAt),
            },
          ];
        }),
      };
      mkdirSync(dirname(RATE_CARD_PATH), { recursive: true });
      validateGeneration(slate, rateCard);
      writeFileSync(`${SLATE_PATH}.tmp`, serialize(slate));
      writeFileSync(`${RATE_CARD_PATH}.tmp`, serialize(rateCard));
      renameSync(`${RATE_CARD_PATH}.tmp`, RATE_CARD_PATH);
      renameSync(`${SLATE_PATH}.tmp`, SLATE_PATH);
      const upcoming = new Set(games.filter(g => Date.parse(g.start_time)>now.getTime() && g.status_state==='pre').map(g=>g.event_id));
      if(upcoming.size){
        const archive=join(ROOT,'data/forecast-archive',date);
        mkdirSync(archive,{recursive:true});
        writeFileSync(join(archive,`${generatedAt.replaceAll(':','-')}.json`),serialize({slate:{...slate,games:slate.games.filter(g=>upcoming.has(g.event_id))},card:{...rateCard,games:rateCard.games.filter(g=>upcoming.has(g.event_id))}}));
      }
      rateCardPublished = true;
    }
  }

  if (!rateCardPublished) throw new Error('Rate card publication refused: incomplete required coverage');
  process.stdout.write(
    `${JSON.stringify({
      date,
      events: games.length,
      summaries_fetched: summariesFetched,
      summaries_failed: summariesFailed,
      shooting_rows: cache.rows.length,
      rate_card_published: rateCardPublished,
    })}\n`,
  );
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  buildRateCard().catch((error: unknown) => {
    console.error(message(error));
    process.exit(1);
  });
}
