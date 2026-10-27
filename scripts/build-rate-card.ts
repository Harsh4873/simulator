import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chicagoDate } from '../src/date.ts';
import { fitPlayers, hasFreeThrowAttempts, type InjuryInput, type RosterPlayer } from '../src/fit.ts';
import { parseSummary } from '../src/parse-summary.ts';
import type { OutcomeRow, RateCard, SeasonType, ShootingCache, ShootingRow, Slate, SlateGame, TeamSide } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLATE_PATH = join(ROOT, 'public/data/slate.json');
const RATE_CARD_PATH = join(ROOT, 'public/data/rate-card.json');
const CACHE_PATH = join(ROOT, 'data/shooting-cache.json');
const SUMMARY_CAP = 400;
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
const KEPT_STATS = new Set(['points', 'totalRebounds', 'assists', 'three_pointers_made']);
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

function modelCacheUrl(date: string): string {
  return `https://raw.githubusercontent.com/Harsh4873/pickledger/main/data/model_cache/${date}.json`;
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

function teamSide(competitor: Record<string, unknown>): TeamSide | null {
  const team = isRecord(competitor.team) ? competitor.team : {};
  const teamId = String(team.id ?? competitor.id ?? '').trim();
  if (!teamId) return null;
  return {
    team_id: teamId,
    name: String(team.displayName || team.name || team.shortDisplayName || teamId),
    abbreviation: String(team.abbreviation || ''),
  };
}

export function gamesFromScoreboard(payload: unknown, date: string, picks: unknown[]): SlateGame[] {
  const root = isRecord(payload) ? payload : {};
  const events = Array.isArray(root.events) ? root.events : [];
  const seasonFallback = fallbackSeason(root, date);
  const games: SlateGame[] = [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    const eventId = String(event.id ?? '').trim();
    if (!eventId) continue;
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
    if (!away || !home) continue;
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
  out.push({
    athlete_id: athleteId,
    name: String(item.displayName || item.fullName || athleteId).trim(),
    team_id: teamId,
    position,
  });
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
  const groups = Array.isArray(root.injuries) ? root.injuries : [];
  const injuries: InjuryInput[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.injuries)) continue;
    for (const item of group.injuries) {
      if (!isRecord(item)) continue;
      const athlete = isRecord(item.athlete) ? item.athlete : {};
      const athleteId = String(athlete.id ?? '').trim();
      const name = String(athlete.displayName || athlete.fullName || '').trim();
      if (!athleteId && !name) continue;
      injuries.push({ athlete_id: athleteId, name, status: String(item.status ?? '') });
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
  const rows: OutcomeRow[] = [];
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
    rows.push({
      season,
      athlete_id: athleteId,
      team_id: String(value.team_id ?? '').trim(),
      event_id: eventId,
      stat_key: statKey,
      actual: Number.isFinite(actual) ? actual : 0,
      minutes: Number.isFinite(minutes) ? minutes : 0,
    });
  }
  return rows;
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

function finishCache(cache: ShootingCache): void {
  cache.fetched_event_ids = [...new Set(cache.fetched_event_ids)].sort(compareText);
  cache.rows.sort(
    (a, b) => a.season - b.season || compareText(a.team_id, b.team_id) || compareText(a.athlete_id, b.athlete_id),
  );
}

async function fetchJson(url: string | URL, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${url.toString()}`);
  return response.json() as Promise<unknown>;
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

async function buildRateCard(): Promise<void> {
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

  const [teamIndex, injuryPayload, spreadPayload, gzipText] = await Promise.all([
    fetchJson(TEAMS, JSON_TIMEOUT_MS).catch((error: unknown) => {
      console.error(`team index failed: ${message(error)}`);
      return null;
    }),
    fetchJson(INJURIES, JSON_TIMEOUT_MS).catch((error: unknown) => {
      console.error(`injuries failed: ${message(error)}`);
      return null;
    }),
    fetchJson(modelCacheUrl(date), JSON_TIMEOUT_MS).catch((error: unknown) => {
      console.error(`spread cache failed: ${message(error)}`);
      return null;
    }),
    fetch(OUTCOME_GZIP, { signal: AbortSignal.timeout(GZIP_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${OUTCOME_GZIP}`);
        return gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
      })
      .catch((error: unknown) => {
        console.error(`outcome history failed: ${message(error)}`);
        return null;
      }),
  ]);

  const picks = spreadPayload ? nbaPicks(spreadPayload) : [];
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
      return [];
    }
  });
  const roster = rosterGroups.flat();
  const injuries = injuryPayload ? parseInjuries(injuryPayload) : [];
  const outcomes = gzipText === null ? null : parseOutcomeLines(gzipText);
  const cache = loadCache();
  const previousCache = serialize(cache);
  let summariesFetched = 0;
  let summariesFailed = 0;

  if (outcomes) {
    const fetched = new Set(cache.fetched_event_ids);
    const seasons = eventSeasons(outcomes);
    const pending = [...seasons.keys()].filter((eventId) => !fetched.has(eventId)).sort(compareText).slice(0, SUMMARY_CAP);
    await mapLimit(pending, SUMMARY_CONCURRENCY, async (eventId) => {
      try {
        const rows = parseSummary(await fetchJson(summaryUrl(eventId), SUMMARY_TIMEOUT_MS));
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

  finishCache(cache);
  const nextCache = serialize(cache);
  writeFileSync(SLATE_PATH, serialize(slate));
  if (nextCache !== previousCache) writeFileSync(CACHE_PATH, nextCache);

  let rateCardPublished = false;
  if (outcomes && hasFreeThrowAttempts(cache.rows)) {
    const fitted = fitPlayers({ roster, injuries, outcomes, shooting: cache.rows });
    const covered = games.length === 0 || fitted.players.some((player) => slateTeamIds.includes(player.team_id));
    if (fitted.publish && covered) {
      const rateCard: RateCard = {
        schema_version: 1,
        generated_at: generatedAt,
        date,
        iterations: 10000,
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
            },
          ];
        }),
      };
      mkdirSync(dirname(RATE_CARD_PATH), { recursive: true });
      writeFileSync(RATE_CARD_PATH, serialize(rateCard));
      rateCardPublished = true;
    }
  }

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
