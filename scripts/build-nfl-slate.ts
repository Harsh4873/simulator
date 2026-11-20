import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import { parseFeedSlate, type FeedGame, type FeedSlate } from '../src/feed.ts';
import { ELO_MODEL_NAME, fitElo, projectHomeWin, type EloGame } from '../src/nfl/elo.ts';
import { espnRegularWeeks, espnSeasonType, espnSeasonYear, espnWeek, historyWeeks, parseEspnScoreboard, type EspnGame } from '../src/nfl/espn.ts';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const OUT = 'public/data/nfl.json';

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`ESPN NFL scoreboard failed (${response.status})`);
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

function toCard(game: EspnGame, projection: FeedGame['projection'], note: string): FeedGame {
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
  const fit = history.length ? fitElo(history) : null;
  const show = fit !== null && fit.holdout_brier < 0.25;
  const brier = fit ? fit.holdout_brier.toFixed(3) : null;
  const modelNote = !fit
    ? 'Projection is not fitted. Not enough completed games to test a score-only Elo.'
    : show
      ? `Elo win chance from completed ${year} scores. K ${fit.k}, home advantage ${fit.hfa} Elo points, ${fit.margin ? 'updates scaled by the winning margin' : 'win or loss only'}; chosen on earlier games after a warm-up. Holdout Brier ${brier} on the latest ${fit.holdout_games} games, which the choice did not see. No market line was used.`
      : `Projection is not fitted. The score-only Elo did not beat a coin flip on held-out games (Brier ${brier} on ${fit.holdout_games} games).`;
  const note = show ? 'Elo win chance from completed scores before this game. Not a spread or a total.' : 'Projection is not fitted.';
  const card = (game: EspnGame): FeedGame => {
    if (!show || !fit) return toCard(game, null, note);
    // A played game keeps the chance it had before kickoff. A game still to come uses the current ratings.
    const homeWin = fit.pregame_home_win.get(game.id) ?? projectHomeWin(fit, game.home.abbreviation, game.away.abbreviation, game.neutral_site);
    const awayWin = 1 - homeWin;
    return toCard(
      game,
      {
        kind: 'game',
        away_win: awayWin,
        home_win: homeWin,
        summary: `${game.away.abbreviation} ${percent(awayWin)} · ${game.home.abbreviation} ${percent(homeWin)}`,
      },
      note,
    );
  };
  const games = slateGames.sort((a, b) => a.start_time.localeCompare(b.start_time)).map(card);
  const later = upcoming.map(card);
  publish({
    sport: 'nfl',
    source: 'ESPN NFL scoreboard',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    games,
    later,
    model: { fitted: show, name: show ? ELO_MODEL_NAME : 'none', note: modelNote, holdout_games: fit?.holdout_games ?? null, holdout_brier: fit?.holdout_brier ?? null },
  });
  console.log(`NFL slate: ${games.length} games in ${yesterday}..${today}, ${later.length} later this week; projection ${show ? 'shown' : 'not fitted'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildNflSlate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
