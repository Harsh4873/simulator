// Compares the published card with posted sportsbook lines, logs each comparison before its game tips, grades
// earlier ones from final box scores, and writes what the page shows. Prices are read after the draws exist and
// never enter fitting or sampling. A failure here leaves the rate card untouched.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { bookKey, parseBookLines, postedLines, type BookLine } from '../src/book-lines.ts';
import { emptyLedger, ledgerKey, mergeOpen, openRows, parseLedger, refreshLast, serializeLedger, settle, updateClose } from '../src/pick-ledger.ts';
import { buildRecord, gameLeans, LEAN_BUCKETS, MIN_PLAY_SHARE, type Lean, type LedgerFile, type PicksFile } from '../src/picks.ts';
import type { PropCalibrationArtifact, PropCalibrationGroup } from '../src/prop-calibration.ts';
import { fnv1a } from '../src/rng.ts';
import { ITERATIONS, simulate } from '../src/simulate.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import type { PlayerSample, PropMarket } from '../src/props.ts';
import type { RateCard, RateGame, Slate, SlateGame } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PRICE_FEED = 'https://raw.githubusercontent.com/Harsh4873/pickledger/main/data/nba_prop_prices';
const FEED_TIMEOUT_MS = 30_000;

export type Draws = (game: SlateGame, rate: RateGame) => ReadonlyMap<string, PlayerSample>;

const round = (value: number, places: number) => Number(value.toFixed(places));

/** One day of posted prices. A day the feed has not written yet is an empty list, not an error. */
export async function fetchPriceDay(date: string, base = PRICE_FEED): Promise<BookLine[]> {
  const response = await fetch(`${base}/${date}.jsonl.gz`, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (response.status === 404) {
    await response.body?.cancel();
    return [];
  }
  if (!response.ok) throw new Error(`Price feed returned ${response.status} for ${date}`);
  return parseBookLines(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8'));
}

export function readLedgers(dir: string): Map<string, LedgerFile> {
  const files = new Map<string, LedgerFile>();
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const file = parseLedger(readFileSync(join(dir, name), 'utf8'));
    if (`${file.date}.json` !== name) throw new Error(`Pick ledger ${name} holds another date`);
    files.set(file.date, file);
  }
  return files;
}

function trimLean(lean: Lean): Lean {
  return {
    ...lean,
    model: round(lean.model, 4),
    need: round(lean.need, 4),
    claimed: round(lean.claimed, 4),
    projection: round(lean.projection, 2),
    minutes: round(lean.minutes, 1),
    play: round(lean.play, 3),
    ...(lean.modelRaw !== undefined ? { modelRaw: round(lean.modelRaw, 4) } : {}),
  };
}

function sameLines(a: PicksFile['lines'][string] | undefined, b: PicksFile['lines'][string]): boolean {
  // The stamp moves with every capture. Only a changed line or price changes the comparison.
  const strip = (rows: PicksFile['lines'][string]) => JSON.stringify(rows.map((row) => row.slice(0, 5)));
  return a !== undefined && strip(a) === strip(b);
}

export interface PicksInput {
  slate: Slate;
  card: RateCard;
  /** One list per day file, so each day's last capture is judged on its own. */
  feed: readonly (readonly BookLine[])[];
  ledgers: Map<string, LedgerFile>;
  events: ReadonlyMap<string, CompletedEvent>;
  previous: PicksFile | null;
  now: Date;
  draws: Draws;
  calibration?: ReadonlyMap<PropCalibrationGroup, PropCalibrationArtifact>;
}

/**
 * Pure step: every file the job writes follows from these inputs. A game is simulated only before its tip and only
 * when its card or its posted lines changed since the previous run.
 */
export function buildPicks(input: PicksInput): { picks: PicksFile; simulated: number; opened: number; refreshed: number; settled: number } {
  const { slate, card, feed, ledgers, events, previous, now } = input;
  const cardAt = card.generated_at;
  // Only rows from each day's last capture before a tip count as posted: an older row is a market the book pulled.
  const latest = new Map<string, BookLine>();
  for (const day of feed) for (const [key, line] of postedLines(day, now.toISOString())) latest.set(key, line);
  const lines: PicksFile['lines'] = {};
  const byEvent = new Map<string, Map<string, BookLine>>();
  for (const line of latest.values()) {
    const game = slate.games.find((item) => item.event_id === line.event_id);
    // A stamp at or after the scoreboard tip is not a pre-game price for this slate.
    if (!game || !(Date.parse(line.priced_at) < Date.parse(game.start_time))) continue;
    (byEvent.get(line.event_id) ?? byEvent.set(line.event_id, new Map()).get(line.event_id)!).set(bookKey(line), line);
  }
  for (const [eventId, map] of [...byEvent].sort(([a], [b]) => a.localeCompare(b))) {
    lines[eventId] = [...map.values()]
      .sort((a, b) => a.athlete_id.localeCompare(b.athlete_id) || a.market.localeCompare(b.market))
      .map((line) => [line.athlete_id, line.market as PropMarket, line.line, line.over_odds, line.under_odds, line.priced_at]);
  }

  const sameCard = previous !== null && previous.generated_at === cardAt && previous.model_hash === (card.model_hash ?? null);
  const leans: Lean[] = [];
  let simulated = 0;
  let opened = 0;
  let refreshed = 0;
  for (const game of slate.games) {
    const posted = byEvent.get(game.event_id);
    const rate = card.games.find((item) => item.event_id === game.event_id);
    const tip = Date.parse(game.start_time);
    if (!posted || !rate || rate.simulation_error || !cardAt) continue;
    // Only a game that has not started can be compared: afterwards the card already knows who played.
    if (game.status_state !== 'pre' || !(now.getTime() < tip) || !(Date.parse(cardAt) < tip)) continue;
    const ledger = ledgers.get(game.date) ?? emptyLedger(game.date);
    const known = new Set(ledger.rows.map(ledgerKey));
    const logged = [...posted.values()].every((line) => known.has(`${line.event_id}:${line.athlete_id}:${line.market}`));
    if (sameCard && logged && sameLines(previous!.lines[game.event_id], lines[game.event_id])) {
      // Same card and same prices: the earlier comparison still stands, with the newer price stamp.
      for (const lean of previous!.leans) {
        if (lean.event_id !== game.event_id) continue;
        const line = posted.get(`${lean.event_id}:${lean.athlete_id}:${lean.market}`);
        leans.push(line ? { ...lean, priced_at: line.priced_at } : lean);
      }
      continue;
    }
    const draws = input.draws(game, rate);
    simulated += 1;
    // A replayed day is history rebuilt after the fact. Nothing logged live is ever added to it.
    if (ledger.source === 'live') {
      const rows = openRows(game, rate, draws, posted, cardAt, card.model_hash);
      opened += mergeOpen(ledger, rows);
      // A line logged on an earlier card keeps that opening and takes this card's comparison as its latest.
      refreshed += refreshLast(ledger, rows);
      if (ledger.rows.length) ledgers.set(game.date, ledger);
    }
    for (const lean of gameLeans(game, rate, draws, posted, input.calibration, card.model_hash)) {
      if (lean.claimed >= LEAN_BUCKETS[1] && lean.play >= MIN_PLAY_SHARE) leans.push(trimLean(lean));
    }
  }

  let settled = 0;
  const everyRow = feed.flat();
  for (const ledger of ledgers.values()) {
    updateClose(ledger, everyRow);
    settled += settle(ledger, events);
  }
  leans.sort((a, b) => b.claimed - a.claimed || a.name.localeCompare(b.name) || a.market.localeCompare(b.market));
  const picks: PicksFile = {
    schema_version: 1,
    generated_at: cardAt,
    input_hash: card.input_hash ?? null,
    model_hash: card.model_hash ?? null,
    built_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    book: [...latest.values()][0]?.book ?? previous?.book ?? null,
    lines,
    leans,
    record: buildRecord([...ledgers.values()].sort((a, b) => a.date.localeCompare(b.date)), input.calibration),
  };
  const summary = calibrationSummary(input.calibration);
  if (summary) picks.calibration = summary;
  // Nothing new to say: keep the earlier stamp so an idle run does not rewrite the file.
  if (previous && JSON.stringify({ ...picks, built_at: '' }) === JSON.stringify({ ...previous, built_at: '' })) picks.built_at = previous.built_at;
  return { picks, simulated, opened, refreshed, settled };
}

export function serializePicks(picks: PicksFile): string {
  return `${JSON.stringify(picks)}\n`;
}

const CALIBRATION_GROUPS = ['points', 'rebAst', 'tpm'] as const;

function calibrationSummary(map: ReadonlyMap<PropCalibrationGroup, PropCalibrationArtifact> | undefined): PicksFile['calibration'] {
  if (!map?.size) return undefined;
  const summary: NonNullable<PicksFile['calibration']> = {};
  for (const [group, artifact] of map) {
    summary[group] = { method: artifact.method, fitted_through: artifact.fitted_through, ece: artifact.metrics_validated.eceWidth10, status: artifact.status };
  }
  return summary;
}

function loadCalibration(root: string, modelHash: string | null): Map<PropCalibrationGroup, PropCalibrationArtifact> {
  const map = new Map<PropCalibrationGroup, PropCalibrationArtifact>();
  for (const group of CALIBRATION_GROUPS) {
    const path = join(root, 'data/prop-calibration', `${group}.json`);
    if (!existsSync(path)) continue;
    let artifact: PropCalibrationArtifact;
    try {
      artifact = JSON.parse(readFileSync(path, 'utf8')) as PropCalibrationArtifact;
    } catch {
      console.warn(`skip ${group}: unreadable prop calibration`);
      continue;
    }
    if (artifact.status !== 'fitted' || artifact.model_version !== modelHash) {
      console.warn(`skip ${group}: ${artifact.status !== 'fitted' ? 'status is not fitted' : 'model_version does not match the card'}`);
      continue;
    }
    map.set(group, artifact);
  }
  return map;
}

function publishedCalibration(map: ReadonlyMap<PropCalibrationGroup, PropCalibrationArtifact>): string {
  const groups: Record<string, PropCalibrationArtifact> = {};
  for (const [group, artifact] of map) groups[group] = artifact;
  return `${JSON.stringify({ schema_version: 1, groups })}\n`;
}

function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

async function main(): Promise<void> {
  const root = process.env.PICKS_ROOT ?? ROOT;
  const slate = JSON.parse(readFileSync(join(root, 'public/data/slate.json'), 'utf8')) as Slate;
  const card = JSON.parse(readFileSync(join(root, 'public/data/rate-card.json'), 'utf8')) as RateCard;
  const picksPath = join(root, 'public/data/picks.json');
  const ledgerDir = join(root, 'data/pick-ledger');
  const now = new Date();
  const dates = [...new Set(slate.games.map((game) => game.date))].sort();
  // PICK_LINES=off stops the price read. The ledger is still graded and the record still published.
  const feed = process.env.PICK_LINES === 'off' ? [] : await Promise.all(dates.map((date) => fetchPriceDay(date)));
  const cache = JSON.parse(readFileSync(join(root, 'data/shooting-cache.json'), 'utf8')) as { events?: CompletedEvent[] };
  const events = new Map((cache.events ?? []).map((event) => [event.event_id, event]));
  const ledgers = readLedgers(ledgerDir);
  let previous: PicksFile | null = null;
  try {
    previous = JSON.parse(readFileSync(picksPath, 'utf8')) as PicksFile;
    if (previous?.schema_version !== 1 || !Array.isArray(previous.leans) || typeof previous.lines !== 'object') previous = null;
  } catch {
    previous = null;
  }
  const calibration = loadCalibration(root, card.model_hash ?? null);
  const result = buildPicks({
    slate,
    card,
    feed,
    ledgers,
    events,
    previous,
    now,
    calibration,
    draws: (game, rate) => simulate(rate, fnv1a(`${game.event_id}:${card.generated_at ?? ''}`), ITERATIONS).playerDraws,
  });
  let written = 0;
  for (const ledger of ledgers.values()) if (writeIfChanged(join(ledgerDir, `${ledger.date}.json`), serializeLedger(ledger))) written += 1;
  writeIfChanged(picksPath, serializePicks(result.picks));
  const calibrationPath = join(root, 'public/data/prop-calibration.json');
  // An empty file is not a map. Leaving it in public/ fails the publication check and blocks the rate card.
  if (calibration.size) writeIfChanged(calibrationPath, publishedCalibration(calibration));
  else if (existsSync(calibrationPath)) unlinkSync(calibrationPath);
  console.log(JSON.stringify({ price_rows: feed.reduce((sum, day) => sum + day.length, 0), priced_games: Object.keys(result.picks.lines).length, simulated: result.simulated, opened: result.opened, refreshed: result.refreshed, settled: result.settled, leans: result.picks.leans.length, graded: result.picks.record.settled, ledger_files_written: written }));
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
