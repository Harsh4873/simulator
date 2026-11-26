// Posts and grades the NBA bets of the day. The refresh job runs this after the picks step, on the card, slate, prices
// and box scores that same run wrote. Each day's posted picks are kept in data/daily-ledger/<date>.json, and
// public/data/daily.json carries the slate's two days of picks and the record over every day.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import {
  DAILY_CATEGORIES, dailyFile, emptyDay, openPick, parseDailyDay, postDailyPicks, serializeDailyDay, settleDailyPicks,
  type DailyCategory, type DailyFile, type DailyFinal, type DailyLedgerDay, type PostedDailyPick,
} from '../src/daily-ledger.ts';
import { upcomingToday, type DailyOffer } from '../src/daily-price.ts';
import { dailyPropForGame, dailyPropOffer } from '../src/daily-prop.ts';
import { dailySpreadForGame } from '../src/daily-spread.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import { parsePicksFile, type PicksFile } from '../src/picks.ts';
import { parsePublishedPropCalibration } from '../src/prop-calibration.ts';
import { fnv1a } from '../src/rng.ts';
import { ITERATIONS, simulate, type Simulation } from '../src/simulate.ts';
import type { RateCard, RateGame, Slate } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
const FETCH_TIMEOUT_MS = 20000;

export interface DailyInput {
  slate: Slate;
  card: RateCard;
  picks: PicksFile | null;
  calibration: ReturnType<typeof parsePublishedPropCalibration>;
  events: ReadonlyMap<string, CompletedEvent>;
  /** Final scores read from the scoreboard, by event. The event cache fills in the rest. */
  finals: ReadonlyMap<string, DailyFinal>;
  /** Every ledger day, by date. Updated in place. */
  days: Map<string, DailyLedgerDay>;
  now: Date;
  /** Draws a game with the seed and draw count the page uses. */
  draw?: (rate: RateGame) => Simulation;
}

/** Pure step: posts what each category needs, grades what has finished, and builds the published file. */
export function buildDaily(input: DailyInput): { posted: PostedDailyPick[]; settled: number; changed: string[]; file: DailyFile } {
  const { slate, card, picks, calibration, events, finals, days, now } = input;
  const draw = input.draw ?? ((rate: RateGame) => simulate(rate, fnv1a(`${rate.event_id}:${card.generated_at ?? ''}`), ITERATIONS));
  const today = chicagoDate(now);
  const before = new Map([...days].map(([date, day]) => [date, serializeDailyDay(day)]));
  const day = days.get(today) ?? emptyDay(today);
  const needed = DAILY_CATEGORIES.filter((category) => !openPick(day, category, now));
  const taken = (category: DailyCategory) => new Set(day.picks.filter((pick) => pick.category === category).map((pick) => pick.eventId));
  const candidates: Record<DailyCategory, DailyOffer[]> = { prop: [], spread: [] };
  if (needed.length && slate.date === today) {
    const takenBy = new Map(needed.map((category) => [category, taken(category)]));
    for (const game of slate.games) {
      if (!upcomingToday(game, now)) continue;
      // Only a game that could still be posted in some category is drawn.
      const wanted = needed.filter((category) => !takenBy.get(category)!.has(game.event_id));
      const rate = card.games.find((item) => item.event_id === game.event_id);
      if (!wanted.length || !rate || rate.simulation_error) continue;
      const simulation = draw(rate);
      if (wanted.includes('spread')) {
        const spread = dailySpreadForGame(game, card, simulation, now);
        if (spread) candidates.spread.push(spread);
      }
      if (wanted.includes('prop')) {
        const prop = dailyPropForGame(game, rate, simulation, picks, card, calibration, now);
        if (prop) candidates.prop.push(dailyPropOffer(prop));
      }
    }
  }
  const posted = postDailyPicks(day, candidates, now);
  if (posted.length) days.set(today, day);
  const settled = settleDailyPicks(days.values(), finals, events, now);
  const changed = [...days.keys()].filter((date) => before.get(date) !== serializeDailyDay(days.get(date)!)).sort();
  return { posted, settled, changed, file: dailyFile(days, [shiftChicagoDate(today, -1), today], now) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Final scores of the scoreboard's completed games. A postponed or unfinished game has none. */
export function finalsFromScoreboard(payload: unknown): Map<string, DailyFinal> {
  const finals = new Map<string, DailyFinal>();
  const events = isRecord(payload) && Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    if (!isRecord(event) || event.id === undefined) continue;
    const competition = Array.isArray(event.competitions) && isRecord(event.competitions[0]) ? event.competitions[0] : null;
    const type = isRecord(competition?.status) && isRecord(competition.status.type) ? competition.status.type
      : isRecord(event.status) && isRecord(event.status.type) ? event.status.type : null;
    if (!type || type.completed !== true || type.state !== 'post') continue;
    const sides = Array.isArray(competition?.competitors) ? competition.competitors.filter(isRecord) : [];
    const score = (homeAway: string) => {
      const side = sides.find((item) => item.homeAway === homeAway);
      const raw = isRecord(side?.score) ? side.score.value : side?.score;
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
      return Number.isInteger(value) && value >= 0 ? value : null;
    };
    const home = score('home');
    const away = score('away');
    if (home !== null && away !== null) finals.set(String(event.id), { home, away });
  }
  return finals;
}

/** Dates whose posted spreads have tipped and still wait on a final. */
export function pendingSpreadDates(days: Iterable<DailyLedgerDay>, now: Date): string[] {
  const dates = new Set<string>();
  for (const day of days) {
    for (const pick of day.picks) if (pick.category === 'spread' && !pick.result && Date.parse(pick.tip) < now.getTime()) dates.add(pick.date);
  }
  return [...dates].sort();
}

async function fetchFinals(dates: readonly string[]): Promise<Map<string, DailyFinal>> {
  const finals = new Map<string, DailyFinal>();
  for (const date of dates) {
    try {
      const response = await fetch(`${SCOREBOARD}?dates=${date.replaceAll('-', '')}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const [id, final] of finalsFromScoreboard(await response.json())) finals.set(id, final);
    } catch (error) {
      // A missed scoreboard leaves the pick pending; the next run or the box-score cache grades it.
      console.error(`scoreboard ${date} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return finals;
}

export function readDays(dir: string): Map<string, DailyLedgerDay> {
  const days = new Map<string, DailyLedgerDay>();
  if (!existsSync(dir)) return days;
  for (const name of readdirSync(dir).filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort()) {
    const day = parseDailyDay(readFileSync(join(dir, name), 'utf8'));
    // A malformed day stops the run: rewriting it from nothing would erase its posted picks.
    if (!day || `${day.date}.json` !== name) throw new Error(`Invalid daily ledger file ${name}`);
    days.set(day.date, day);
  }
  return days;
}

/** The published file only changes when its picks or record do, so an idle run does not rewrite it. */
export function publishedText(file: DailyFile, previous: string | null): string | null {
  const text = `${JSON.stringify(file)}\n`;
  if (previous !== null) {
    try {
      const old = JSON.parse(previous) as DailyFile;
      if (JSON.stringify({ ...old, built_at: '' }) === JSON.stringify({ ...file, built_at: '' })) return null;
    } catch {
      // An unreadable file is replaced.
    }
  }
  return text;
}

async function main(): Promise<void> {
  const root = process.env.DAILY_ROOT ?? ROOT;
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const optional = (path: string) => (existsSync(join(root, path)) ? read(path) : '');
  const now = new Date();
  const slate = JSON.parse(read('public/data/slate.json')) as Slate;
  const card = JSON.parse(read('public/data/rate-card.json')) as RateCard;
  const picks = parsePicksFile(optional('public/data/picks.json'));
  const calibration = parsePublishedPropCalibration(optional('public/data/prop-calibration.json'));
  const cache = JSON.parse(read('data/shooting-cache.json')) as { events?: CompletedEvent[] };
  const events = new Map((cache.events ?? []).map((event) => [event.event_id, event]));
  const ledgerDir = join(root, 'data/daily-ledger');
  const days = readDays(ledgerDir);
  const finals = await fetchFinals(pendingSpreadDates(days.values(), now));
  const result = buildDaily({ slate, card, picks, calibration, events, finals, days, now });
  mkdirSync(ledgerDir, { recursive: true });
  for (const date of result.changed) writeFileSync(join(ledgerDir, `${date}.json`), serializeDailyDay(days.get(date)!));
  const publishedPath = join(root, 'public/data/daily.json');
  const text = publishedText(result.file, existsSync(publishedPath) ? readFileSync(publishedPath, 'utf8') : null);
  if (text) writeFileSync(publishedPath, text);
  const { all } = result.file.record;
  console.log(JSON.stringify({
    posted: result.posted.map((pick) => `${pick.category}: ${pick.title} ${pick.odds > 0 ? '+' : ''}${pick.odds}`),
    settled: result.settled, record: `${all.wins}-${all.losses}-${all.pushes}`, units: all.units, pending: all.pending, files_written: result.changed.length,
  }));
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
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
