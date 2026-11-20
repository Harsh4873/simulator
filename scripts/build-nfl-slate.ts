import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import { parseFeedSlate, type FeedBand, type FeedGame, type FeedGameSim, type FeedPlayerSim, type FeedSlate, type FeedStat, type FeedValidation } from '../src/feed.ts';
import { packGame, parseNflCache, parseNflSummary, serializeNflCache, unpackGame, type NflBoxGame, type NflCache } from '../src/nfl/boxscore.ts';
import { ELO_MODEL_NAME, fitElo, projectHomeWin, type EloGame } from '../src/nfl/elo.ts';
import {
  espnRegularWeeks,
  espnSeasonType,
  espnSeasonYear,
  espnWeek,
  historyWeeks,
  parseEspnScoreboard,
  parseInjuries,
  parseRoster,
  type EspnGame,
} from '../src/nfl/espn.ts';
import { planGame, playedRoster, simulateGame, walkForward, type Band, type GameProjection, type RosterEntry, type WalkForwardResult } from '../src/nfl/projection.ts';
import { fnv1a } from '../src/rng.ts';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';
const ROSTER = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams';
const OUT = 'public/data/nfl.json';
const CACHE = 'data/nfl-cache.json';
export const SIM_MODEL_NAME = 'nfl-sim-v1';
const SIM_DRAWS = 10_000;
/** A whole season of box scores is about 270 games; a first run fills the cache in one go. */
const NEW_SUMMARIES_PER_RUN = 300;
/** The simulation replaces the Elo only with this many walk-forward games behind it. */
const MIN_CHECKED_GAMES = 30;
const SHOWN_PER_TEAM = 8;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`ESPN NFL request failed (${response.status})`);
  return response.json();
}

function stamp(date: string): string {
  return date.replaceAll('-', '');
}

function percent(chance: number): string {
  return `${(chance * 100).toFixed(1)}%`;
}

function publish(slate: FeedSlate): void {
  const raw = `${JSON.stringify(slate)}\n`;
  if (!parseFeedSlate(raw, 'nfl')) throw new Error('NFL slate failed validation');
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, raw);
  renameSync(tmp, OUT);
}

function toCard(game: EspnGame, projection: FeedGame['projection'], note: string, sim: FeedGameSim | null = null): FeedGame {
  return {
    id: game.id,
    start_time: game.start_time,
    status: game.status,
    listed: false,
    away: game.away,
    home: game.home,
    venue: game.venue,
    neutral_site: game.neutral_site,
    competition: null,
    projection,
    projection_note: note,
    ...(sim ? { sim } : {}),
  };
}

/**
 * The current week's games after the Chicago window, earliest first. The NFL plays Thursday, Sunday and Monday, so a
 * today-and-yesterday window is empty most days; these give the page the rest of the week.
 */
export function laterGames(week: readonly EspnGame[], windowIds: ReadonlySet<string>, today: string): EspnGame[] {
  const seen = new Set<string>();
  return week
    .filter((game) => {
      if (seen.has(game.id) || windowIds.has(game.id)) return false;
      seen.add(game.id);
      return chicagoDate(new Date(game.start_time)) > today;
    })
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
}

function loadCache(season: number): NflCache {
  if (existsSync(CACHE)) {
    const parsed = parseNflCache(readFileSync(CACHE, 'utf8'));
    if (parsed && parsed.season === season) return parsed;
  }
  return { schema_version: 1, season, games: [] };
}

/** Adds box scores for completed games the cache does not hold yet. A summary that fails is tried again next run. */
async function fillCache(cache: NflCache, completed: readonly string[]): Promise<number> {
  const known = new Set(cache.games.map((game) => game.id));
  const missing = completed.filter((id) => !known.has(id)).slice(0, NEW_SUMMARIES_PER_RUN);
  let cursor = 0;
  let added = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < missing.length) {
        const id = missing[cursor++]!;
        try {
          const game = parseNflSummary(await getJson(`${SUMMARY}?event=${id}`));
          if (!game || game.season !== cache.season) continue;
          cache.games.push(packGame(game));
          added += 1;
        } catch (error) {
          console.error(`NFL box score ${id} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
    }),
  );
  return added;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

function publishedBand(band: Band): FeedBand {
  return { mean: round1(band.mean), p10: round1(band.p10), p50: round1(band.p50), p90: round1(band.p90) };
}

const COUNT_FLOOR: Partial<Record<FeedStat, number>> = { rush_yds: -10 };

/** Yards and counts are whole numbers: quantiles are rounded, and a widened range stops where the stat can. */
export function publishedStatBand(stat: FeedStat, band: Band): FeedBand {
  const floor = COUNT_FLOOR[stat] ?? 0;
  const whole = (value: number) => Math.max(floor, Math.round(value));
  return { mean: round1(Math.max(floor, band.mean)), p10: whole(band.p10), p50: whole(band.p50), p90: whole(band.p90) };
}

/**
 * Rows for one side: the quarterback who starts in most draws, up to three backs by carries, and up to five
 * receivers by targets. A backup passer who only throws when the starter sits is left off.
 */
export function pickShown<T extends { position: string; stats: Partial<Record<FeedStat, Band>> }>(players: readonly T[]): T[] {
  const mean = (player: T, stat: FeedStat) => player.stats[stat]?.mean ?? 0;
  const qb = players.find((player) => player.position === 'QB' && (player.stats.pass_yds?.p50 ?? 0) > 0);
  const backs = players
    .filter((player) => player.position === 'RB' && mean(player, 'car') >= 2)
    .sort((a, b) => mean(b, 'car') - mean(a, 'car'))
    .slice(0, 3);
  const catchers = players
    .filter((player) => player.position !== 'QB' && !backs.includes(player) && mean(player, 'tgt') >= 1.5)
    .sort((a, b) => mean(b, 'tgt') - mean(a, 'tgt'))
    .slice(0, 5);
  return [...(qb ? [qb] : []), ...backs, ...catchers].slice(0, SHOWN_PER_TEAM + 1);
}

/** Rows the page shows for each side, with what each player recorded once the game is final. */
function shownPlayers(projection: GameProjection, actual: NflBoxGame | null): FeedPlayerSim[] {
  const lines = new Map(actual ? [...actual.home.players, ...actual.away.players].map((line) => [line.id, line]) : []);
  const out: FeedPlayerSim[] = [];
  for (const side of ['away', 'home'] as const) {
    const players = pickShown(projection.players.filter((player) => player.side === side));
    for (const player of players) {
      const stats: Partial<Record<FeedStat, FeedBand>> = {};
      for (const [stat, band] of Object.entries(player.stats) as [FeedStat, Band][]) stats[stat] = publishedStatBand(stat, band);
      const line = lines.get(player.id);
      const actualStats: Partial<Record<FeedStat, number>> | null = line
        ? Object.fromEntries((Object.keys(stats) as FeedStat[]).map((stat) => [stat, line[stat]]))
        : null;
      out.push({
        id: player.id,
        name: player.name,
        side,
        position: player.position,
        status: player.status,
        play: round3(player.play),
        stats,
        td: round3(player.td),
        ...(actual ? { actual: actualStats } : {}),
      });
    }
  }
  return out;
}

function publishedSim(projection: GameProjection, actual: NflBoxGame | null): FeedGameSim {
  return {
    draws: projection.draws,
    away_points: publishedBand(projection.away_points),
    home_points: publishedBand(projection.home_points),
    margin: publishedBand(projection.margin),
    combined: publishedBand(projection.combined),
    home_win: round3(projection.home_win),
    players: shownPlayers(projection, actual),
  };
}

function publishedValidation(walk: WalkForwardResult): FeedValidation {
  return {
    games: walk.games,
    from_week: walk.fromWeek,
    through_week: walk.throughWeek,
    win_brier: walk.winBrier,
    margin_mae: walk.marginMae,
    td_brier: walk.tdBrier,
    coverage: walk.coverage,
    mae: walk.mae,
  };
}

/** Offensive roster with this game's injury-report status. A roster that fails leaves the team on its usage alone. */
async function rosterFor(teamId: string | null, injuries: ReadonlyMap<string, string>, cache: Map<string, Promise<RosterEntry[] | null>>): Promise<RosterEntry[] | null> {
  if (!teamId) return null;
  let pending = cache.get(teamId);
  if (!pending) {
    pending = getJson(`${ROSTER}/${teamId}/roster`)
      .then((payload) => parseRoster(payload).map((player) => ({ id: player.id, name: player.name, position: player.position, status: null })))
      .catch((error: unknown) => {
        console.error(`NFL roster ${teamId} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
        return null;
      });
    cache.set(teamId, pending);
  }
  const roster = await pending;
  return roster ? roster.map((player) => ({ ...player, status: injuries.get(player.id) ?? null })) : null;
}

export async function buildNflSlate(now = new Date()): Promise<void> {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  const [todayPayload, yesterdayPayload, weekPayload] = await Promise.all([
    getJson(`${SCOREBOARD}?dates=${stamp(today)}`),
    getJson(`${SCOREBOARD}?dates=${stamp(yesterday)}`),
    getJson(SCOREBOARD).catch((error: unknown) => {
      console.error(`NFL current week was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }),
  ]);
  const windowGames = [...parseEspnScoreboard(yesterdayPayload), ...parseEspnScoreboard(todayPayload)];
  const seen = new Set<string>();
  const slateGames = windowGames.filter((game) => {
    if (seen.has(game.id)) return false;
    seen.add(game.id);
    const day = chicagoDate(new Date(game.start_time));
    return day === today || day === yesterday;
  });
  const upcoming = weekPayload === null ? [] : laterGames(parseEspnScoreboard(weekPayload), new Set(slateGames.map((game) => game.id)), today);
  const year = espnSeasonYear(todayPayload) ?? espnSeasonYear(yesterdayPayload) ?? Number(today.slice(0, 4));
  const week = espnWeek(weekPayload) ?? espnWeek(todayPayload) ?? espnWeek(yesterdayPayload) ?? 1;
  const seasonType = espnSeasonType(weekPayload) ?? espnSeasonType(todayPayload) ?? 2;
  const regularWeeks = espnRegularWeeks(weekPayload ?? todayPayload);
  const history: EloGame[] = [];
  const historyIds = new Set<string>();
  for (const slot of historyWeeks(seasonType, week, regularWeeks)) {
    try {
      const payload = await getJson(`${SCOREBOARD}?dates=${year}&seasontype=${slot.seasonType}&week=${slot.week}`);
      for (const game of parseEspnScoreboard(payload)) {
        // Playoff results are results too: they keep moving the ratings once the regular season is over.
        if (historyIds.has(game.id) || game.status !== 'final' || (game.season_type !== 2 && game.season_type !== 3) || game.season_year !== year) continue;
        if (game.home.score === null || game.away.score === null) continue;
        historyIds.add(game.id);
        history.push({
          id: game.id,
          start_time: game.start_time,
          home: game.home.abbreviation,
          away: game.away.abbreviation,
          home_score: game.home.score,
          away_score: game.away.score,
          neutral: game.neutral_site,
        });
      }
    } catch (error) {
      console.error(`NFL ${slot.seasonType === 3 ? 'postseason ' : ''}week ${slot.week} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // Box scores for the simulation. The cache keeps them between runs, so a run fetches only newly finished games.
  const cache = loadCache(year);
  const added = await fillCache(cache, history.map((game) => game.id));
  if (added) {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, serializeNflCache(cache));
  }
  const boxGames = cache.games.map(unpackGame);
  let walk: WalkForwardResult | null = null;
  try {
    walk = boxGames.length >= 60 ? walkForward(boxGames) : null;
  } catch (error) {
    console.error(`NFL walk-forward check failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const useSim = walk !== null && walk.games >= MIN_CHECKED_GAMES && walk.winBrier < 0.25;

  const fit = history.length ? fitElo(history) : null;
  const showElo = fit !== null && fit.holdout_brier < 0.25;
  const brier = fit ? fit.holdout_brier.toFixed(3) : null;
  const eloNote = !fit
    ? 'Projection is not fitted. Not enough completed games to test a score-only Elo.'
    : showElo
      ? `Elo win chance from completed ${year} scores. K ${fit.k}, home advantage ${fit.hfa} Elo points, ${fit.margin ? 'updates scaled by the winning margin' : 'win or loss only'}; chosen on earlier games after a warm-up. Holdout Brier ${brier} on the latest ${fit.holdout_games} games, which the choice did not see. No market line was used.`
      : `Projection is not fitted. The score-only Elo did not beat a coin flip on held-out games (Brier ${brier} on ${fit.holdout_games} games).`;
  const eloCard = (game: EspnGame): FeedGame => {
    const note = showElo ? 'Elo win chance from completed scores before this game. Not a spread or a total.' : 'Projection is not fitted.';
    if (!showElo || !fit) return toCard(game, null, note);
    const homeWin = fit.pregame_home_win.get(game.id) ?? projectHomeWin(fit, game.home.abbreviation, game.away.abbreviation, game.neutral_site);
    return toCard(game, { kind: 'game', away_win: 1 - homeWin, home_win: homeWin, summary: `${game.away.abbreviation} ${percent(1 - homeWin)} · ${game.home.abbreviation} ${percent(homeWin)}` }, note);
  };

  const rosters = new Map<string, Promise<RosterEntry[] | null>>();
  const byId = new Map(boxGames.map((game) => [game.id, game]));
  const simCard = async (game: EspnGame): Promise<FeedGame> => {
    if (!useSim || !walk) return eloCard(game);
    try {
      let injuries = new Map<string, string>();
      try {
        injuries = parseInjuries(await getJson(`${SUMMARY}?event=${game.id}`));
      } catch (error) {
        console.error(`NFL injury report ${game.id} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      let [home, away] = await Promise.all([rosterFor(game.home_id, injuries, rosters), rosterFor(game.away_id, injuries, rosters)]);
      const played = game.status === 'final' ? byId.get(game.id) : undefined;
      if (played) {
        // A final game is projected from who took part: today's roster can be missing someone hurt in it.
        const positions = new Map([...(home ?? []), ...(away ?? [])].map((player) => [player.id, player.position]));
        const side = (abbr: string) => (played.home.abbr === abbr ? played.home : played.away);
        home = playedRoster(side(game.home.abbreviation), positions);
        away = playedRoster(side(game.away.abbreviation), positions);
      }
      // A played or live game is projected as it stood at kickoff.
      const asOf = Math.min(now.getTime(), Date.parse(game.start_time));
      const plans = planGame(boxGames, game.home.abbreviation, game.away.abbreviation, game.neutral_site, asOf, { home, away });
      const result = simulateGame(plans.home, plans.away, game.neutral_site, SIM_DRAWS, fnv1a(`nfl:${game.id}`), walk.calibration);
      const projection = result.projection;
      const homeWin = projection.home_win;
      const sim = publishedSim(projection, game.status === 'final' ? byId.get(game.id) ?? null : null);
      return toCard(
        game,
        { kind: 'game', away_win: round3(1 - homeWin), home_win: round3(homeWin), summary: `${game.away.abbreviation} ${percent(1 - homeWin)} · ${game.home.abbreviation} ${percent(homeWin)}` },
        'Simulated from box scores before kickoff, with this game\'s injury report. Not a spread or a total.',
        sim,
      );
    } catch (error) {
      console.error(`NFL simulation ${game.id} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return eloCard(game);
    }
  };
  const games: FeedGame[] = [];
  for (const game of slateGames.sort((a, b) => a.start_time.localeCompare(b.start_time))) games.push(await simCard(game));
  const later: FeedGame[] = [];
  for (const game of upcoming) later.push(await simCard(game));
  const simNote = walk
    ? `Each game is played ${SIM_DRAWS.toLocaleString('en-US')} times from ${boxGames.length} completed ${year} box scores: team points from offense and defense ratings, drive by drive, and each player's targets, carries, yards and touchdowns from his recent share of his team's. Players listed out or doubtful sit; questionable players play three draws in four. Win chances, ranges and player means are calibrated on earlier weeks. No market line was used.`
    : eloNote;
  publish({
    sport: 'nfl',
    source: 'ESPN NFL scoreboard and box scores',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    games,
    later,
    model: useSim && walk
      ? { fitted: true, name: SIM_MODEL_NAME, note: simNote, holdout_games: walk.games, holdout_brier: walk.winBrier, validation: publishedValidation(walk) }
      : { fitted: showElo, name: showElo ? ELO_MODEL_NAME : 'none', note: eloNote, holdout_games: fit?.holdout_games ?? null, holdout_brier: fit?.holdout_brier ?? null },
  });
  console.log(
    `NFL slate: ${games.length} games in ${yesterday}..${today}, ${later.length} later this week; ${useSim ? `simulated from ${boxGames.length} box scores (${added} new), walk-forward Brier ${walk!.winBrier} on ${walk!.games} games` : `Elo ${showElo ? 'shown' : 'not fitted'}`}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildNflSlate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
