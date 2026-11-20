import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import { parseFeedSlate, type FeedGame, type FeedSide, type FeedSlate } from '../src/feed.ts';
import { LIQUIPEDIA_GAP_MS, LIQUIPEDIA_USER_AGENT } from '../src/esports/config.ts';
import { isPlaceholderTeam, mapResultsFrom, parentTitle, parseTicker, parseTournamentPage, selectTournamentTitles, type MapResult, type TickerMatch } from '../src/esports/liquipedia.ts';
import { mapBrier, projectionFor, projectionNote, ratingsBefore, type TeamState } from '../src/esports/ratings.ts';

const OUT = 'public/data/esports.json';
const API = 'https://liquipedia.net/counterstrike/api.php';
const TITLE_LIMIT = 22;
const LATER_MS = 14 * 86_400_000;
const MIN_SCORED = 24;

let lastCall = 0;

async function waitTurn(): Promise<void> {
  const elapsed = Date.now() - lastCall;
  if (elapsed < LIQUIPEDIA_GAP_MS) await new Promise((resolve) => setTimeout(resolve, LIQUIPEDIA_GAP_MS - elapsed));
  lastCall = Date.now();
}

async function liquipedia(params: Record<string, string>): Promise<unknown> {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitTurn();
    const response = await fetch(url, {
      headers: { 'user-agent': LIQUIPEDIA_USER_AGENT, 'accept-encoding': 'gzip' },
      signal: AbortSignal.timeout(30000),
    });
    lastCall = Date.now();
    if (response.status === 429) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20000));
        continue;
      }
      throw new Error('Liquipedia rate limit');
    }
    if (!response.ok) throw new Error(`Liquipedia failed (${response.status})`);
    return response.json();
  }
  throw new Error('Liquipedia rate limit');
}

const pages = new Map<string, string | null>();

async function pageText(title: string): Promise<string | null> {
  const key = title.trim().replaceAll(' ', '_');
  if (pages.has(key)) return pages.get(key) ?? null;
  const payload = await liquipedia({ action: 'parse', page: key.replaceAll('_', ' '), prop: 'text' });
  const row = payload as { error?: { code?: string }; parse?: { text?: { '*'?: string } } };
  if (row.error?.code === 'missingtitle') {
    pages.set(key, null);
    return null;
  }
  if (row.error) throw new Error(`Liquipedia ${title} failed`);
  const html = row.parse?.text?.['*'];
  const text = typeof html === 'string' ? html : null;
  pages.set(key, text);
  return text;
}

function publish(slate: FeedSlate): void {
  const raw = `${JSON.stringify(slate)}\n`;
  if (!parseFeedSlate(raw, 'esports')) throw new Error('Esports slate failed validation');
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, raw);
  renameSync(tmp, OUT);
}

function side(team: TickerMatch['away'], score: number | null): FeedSide {
  return { name: team.name, abbreviation: team.abbreviation, score, logo_url: null, color: null, alternate_color: null };
}

function tierFor(title: string, tiers: ReadonlyMap<string, string>): string | null {
  return tiers.get(title) ?? tiers.get(parentTitle(title) ?? '') ?? null;
}

function card(match: TickerMatch, projection: FeedGame['projection'], note: string, ratings: Map<string, TeamState> | null): FeedGame {
  let fullNote = note;
  if (projection && ratings) {
    const left = ratings.get(match.away.name);
    const right = ratings.get(match.home.name);
    if (left && right) fullNote = `${match.status === 'final' ? 'Pre-match. ' : ''}${projectionNote(projection, match.away.name, left, match.home.name, right)}`;
  }
  return {
    id: match.id,
    start_time: match.start_time,
    status: match.status,
    listed: true,
    away: side(match.away, match.away_score),
    home: side(match.home, match.home_score),
    venue: null,
    neutral_site: true,
    competition: [match.tournament, match.format_label].filter(Boolean).join(' · ') || null,
    projection,
    projection_note: fullNote,
  };
}

export async function buildEsportsSlate(now = new Date()): Promise<void> {
  const tickerHtml = await pageText('Liquipedia:Matches');
  if (!tickerHtml) throw new Error('Liquipedia matches page was empty');
  const ticker = parseTicker(tickerHtml, now);
  const category = await liquipedia({
    action: 'query',
    list: 'categorymembers',
    cmtitle: 'Category:S-Tier Tournaments',
    cmlimit: '50',
    cmsort: 'timestamp',
    cmdir: 'desc',
  });
  const members = ((category as { query?: { categorymembers?: { title?: string }[] } }).query?.categorymembers ?? [])
    .map((member) => member.title ?? '')
    .filter(Boolean);
  const titles = selectTournamentTitles(ticker.map((match) => match.tournament_title), members, TITLE_LIMIT);
  const tiers = new Map<string, string>();
  const results: MapResult[] = [];
  let fetches = 0;
  for (const title of titles) {
    if (fetches >= 24) break;
    fetches += 1;
    let html: string | null = null;
    try {
      html = await pageText(title);
    } catch (error) {
      console.error(`esports ${title} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
      if (error instanceof Error && error.message.includes('rate limit')) break;
      continue;
    }
    if (!html) continue;
    let parsed = parseTournamentPage(html);
    if (!parsed.tier) {
      const parent = parentTitle(title);
      if (parent && fetches < 24) {
        fetches += 1;
        let parentHtml: string | null = null;
        try {
          parentHtml = await pageText(parent);
        } catch (error) {
          console.error(`esports ${parent} was not loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        if (parentHtml) {
          const parentParsed = parseTournamentPage(parentHtml);
          if (parentParsed.tier) tiers.set(parent, parentParsed.tier);
          if (!parsed.tier && parentParsed.tier) parsed = { ...parsed, tier: parentParsed.tier };
          if (parentParsed.tier === 'S-Tier') results.push(...mapResultsFrom(parentParsed, now));
        }
      }
    }
    if (parsed.tier) tiers.set(title, parsed.tier);
    if (parsed.tier === 'S-Tier') results.push(...mapResultsFrom({ ...parsed, tier: 'S-Tier' }, now));
    console.log(`esports ${title}: ${parsed.tier ?? 'no tier'}`);
  }
  const slate = composeEsportsSlate(ticker, tiers, results, now);
  publish(slate);
  console.log(`Esports slate: ${slate.games.length} in window, ${slate.later.length} tier-1 later; projection ${slate.model.fitted ? 'shown' : 'not fitted'}`);
}

export function composeEsportsSlate(ticker: TickerMatch[], tiers: Map<string, string>, results: MapResult[], now: Date): FeedSlate {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  const unique = new Map<string, MapResult>();
  for (const result of results) unique.set(`${result.day}|${result.map}|${result.winner}|${result.loser}`, result);
  const maps = [...unique.values()];
  const scored = mapBrier(maps);
  const show = scored.games >= MIN_SCORED && scored.brier < 0.25;
  const brierText = scored.brier.toFixed(3);
  const modelNote = maps.length === 0
    ? 'Projection is not fitted. No completed tier-1 maps were available from Liquipedia.'
    : !show
      ? scored.games < MIN_SCORED
        ? `Projection is not fitted. Not enough earlier tier-1 maps to test the Glicko-2 chance (${scored.games} scored).`
        : `Projection is not fitted. The tier-1 Glicko-2 map chance did not beat a coin flip on held-out maps (Brier ${brierText} on ${scored.games} maps).`
      : `Global Glicko-2 fit on ${maps.length} completed tier-1 maps from Liquipedia S-tier events. Holdout map Brier ${brierText} on ${scored.games} maps where both teams already had 3 maps. A series chance treats every map as an independent draw at that rate. Veto, round simulation, and calibration are not fitted. No market line was used.`;
  const cache = new Map<string, Map<string, TeamState>>();
  const ratingsOn = (day: string) => {
    const cached = cache.get(day);
    if (cached) return cached;
    const ratings = ratingsBefore(maps, day);
    cache.set(day, ratings);
    return ratings;
  };
  const project = (match: TickerMatch): { projection: FeedGame['projection']; note: string; ratings: Map<string, TeamState> | null } => {
    const tier = tierFor(match.tournament_title, tiers);
    if (tier !== null && tier !== 'S-Tier') return { projection: null, note: 'Projection is not fitted. This event is not tier-1.', ratings: null };
    if (!show || tier === null) return { projection: null, note: 'Projection is not fitted.', ratings: null };
    if (isPlaceholderTeam(match.away.name) || isPlaceholderTeam(match.home.name)) return { projection: null, note: 'Projection is not fitted.', ratings: null };
    const day = match.start_time.slice(0, 10);
    const ratings = ratingsOn(day);
    const projection = projectionFor(match.away.name, ratings.get(match.away.name), match.home.name, ratings.get(match.home.name), match.format_label);
    if (!projection) return { projection: null, note: 'Projection is not fitted. One of these teams has fewer than 3 tier-1 maps in the fit.', ratings };
    return { projection, note: '', ratings };
  };
  const inWindow = (match: TickerMatch) => {
    const day = chicagoDate(new Date(match.start_time));
    return day === today || day === yesterday;
  };
  const games = ticker
    .filter(inWindow)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .map((match) => {
      const projected = project(match);
      return card(match, projected.projection, projected.note, projected.ratings);
    });
  const later = ticker
    .filter((match) => !inWindow(match) && match.status !== 'final' && tierFor(match.tournament_title, tiers) === 'S-Tier')
    .filter((match) => {
      const start = Date.parse(match.start_time);
      return start >= now.getTime() - 12 * 3_600_000 && start <= now.getTime() + LATER_MS;
    })
    .filter((match) => !isPlaceholderTeam(match.away.name) && !isPlaceholderTeam(match.home.name))
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .slice(0, 16)
    .map((match) => {
      const projected = project(match);
      return card(match, projected.projection, projected.note, projected.ratings);
    });
  return {
    sport: 'esports',
    source: 'Liquipedia',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    games,
    later,
    model: {
      fitted: show,
      name: show ? 'cs2-glicko2-v0.1' : 'none',
      note: modelNote,
      holdout_games: scored.games > 0 ? scored.games : null,
      holdout_brier: scored.games > 0 ? scored.brier : null,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildEsportsSlate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
