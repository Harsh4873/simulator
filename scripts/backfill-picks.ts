// Rebuilds each archived pre-tip card with the current source (as `npm run replay` does), compares it with the lines
// that were posted when that card was built, and writes those comparisons to the pick ledger marked `replay`.
// It never touches a day that was logged live, and fills only days that have no file unless BACKFILL_REBUILD=1.
// Rebuild after a model change so the replayed record matches the model.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simulate } from '../src/simulate.ts';
import { fnv1a } from '../src/rng.ts';
import { attachPlayCache } from './play-cache.ts';
import { fitPlayers } from '../src/fit.ts';
import { fitMatchup, fitCurrentRoles, eligibleEvents } from '../src/team-model.ts';
import { addEvidence } from '../src/model-evidence.ts';
import { aggregateShooting } from '../src/event-cache.ts';
import { fitShootingPriors } from '../src/shooting-priors.ts';
import { availabilityHistory } from '../src/availability-history.ts';
import { fillThinRoster, rosterIssue } from '../src/roster-capacity.ts';
import { eventOutcomes } from './build-rate-card.ts';
import { fetchPriceDay, readLedgers } from './build-picks.ts';
import { bookKey, postedLines, type BookLine } from '../src/book-lines.ts';
import { emptyLedger, mergeOpen, openRows, serializeLedger, settle, updateClose } from '../src/pick-ledger.ts';
import { buildRecord, type LedgerFile } from '../src/picks.ts';
import type { ForecastArchive } from '../src/forecast-archive.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';
import type { ShootingCache } from '../src/types.ts';

const draws = Number(process.env.BACKFILL_DRAWS ?? 10000);
if (!Number.isInteger(draws) || draws < 1000) throw new Error('BACKFILL_DRAWS must be an integer of at least 1000');
const ledgerDir = 'data/pick-ledger';
const cache = JSON.parse(readFileSync('data/shooting-cache.json', 'utf8')) as ShootingCache;
attachPlayCache(cache, 'data/shooting-cache.json');
const events = cache.events ?? [];
const byId = new Map<string, CompletedEvent>(events.map((event) => [event.event_id, event]));
const archiveDir = 'data/forecast-archive';
const archives = (existsSync(archiveDir) ? readdirSync(archiveDir, { recursive: true }).map(String) : [])
  .filter((file) => file.endsWith('.json') && !file.split('/').at(-1)!.startsWith('inputs-'))
  .sort()
  .map((file) => ({ file, data: JSON.parse(readFileSync(join(archiveDir, file), 'utf8')) as ForecastArchive }));

// The last card published before each tip is the forecast that gets compared.
const latest = new Map<string, { file: string; archive: ForecastArchive; game: ForecastArchive['slate']['games'][number] }>();
for (const { file, data } of archives) {
  for (const game of data.slate.games) {
    if (!(Date.parse(data.card.generated_at!) < Date.parse(game.start_time)) || !data.source_lineage?.roster || !data.source_lineage?.injuries || !byId.has(game.event_id)) continue;
    const previous = latest.get(game.event_id);
    if (!previous || Date.parse(data.card.generated_at!) > Date.parse(previous.archive.card.generated_at!)) latest.set(game.event_id, { file, archive: data, game });
  }
}
const groups = new Map<string, { archive: ForecastArchive; games: ForecastArchive['slate']['games'] }>();
for (const { file, archive, game } of latest.values()) {
  const group = groups.get(file) ?? { archive, games: [] };
  group.games.push(game);
  groups.set(file, group);
}

const existing = readLedgers(ledgerDir);
const rebuild = process.env.BACKFILL_REBUILD === '1';
const kept = new Set([...existing.values()].filter((file) => file.source === 'live' || !rebuild).map((file) => file.date));
const dates = [...new Set([...latest.values()].map((item) => item.game.date))].filter((date) => !kept.has(date)).sort();
const feedByDate = new Map<string, BookLine[]>();
for (const date of dates) feedByDate.set(date, await fetchPriceDay(date));

const ledgers = new Map<string, LedgerFile>();
let games = 0;
for (const [, { archive, games: slateGames }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
  // No day in this archive needs filling: skip the refit, which is most of the work.
  if (!slateGames.some((game) => feedByDate.get(game.date)?.length)) continue;
  const cutoff = archive.card.generated_at!;
  const lineage = archive.source_lineage!;
  const ids = new Set(lineage.training_event_ids);
  const training = eligibleEvents(events.filter((event) => ids.has(event.event_id)), cutoff);
  const season = slateGames[0].season;
  const prior = archives.map((item) => item.data).filter((item) => Date.parse(item.card.generated_at!) < Date.parse(cutoff));
  const fitted = fitPlayers({ roster: lineage.roster!, injuries: lineage.injuries!, outcomes: eventOutcomes(training), shooting: aggregateShooting(training), skillModel: fitShootingPriors(training, season), activeSeason: season });
  fitCurrentRoles(fitted.players, training, season, availabilityHistory(prior, training, cutoff), cutoff);
  addEvidence(fitted.players, training, cutoff);
  for (const game of slateGames) {
    const feed = feedByDate.get(game.date);
    if (!feed?.length) continue;
    // Only prices from the feed's last capture before the card was built: older rows are markets the book had pulled.
    const posted = new Map<string, BookLine>();
    for (const line of postedLines(feed, cutoff).values()) if (line.event_id === game.event_id) posted.set(bookKey(line), line);
    if (!posted.size) continue;
    const rate = fillThinRoster({ event_id: game.event_id, away_team_id: game.away.team_id, home_team_id: game.home.team_id, players: fitted.players.filter((player) => player.team_id === game.away.team_id || player.team_id === game.home.team_id), context: fitMatchup(training, game, cutoff) });
    if (rosterIssue(rate)) continue;
    const sim = simulate(rate, fnv1a(`${game.event_id}:${cutoff}`), draws);
    const ledger = ledgers.get(game.date) ?? emptyLedger(game.date, 'replay');
    mergeOpen(ledger, openRows(game, rate, sim.playerDraws, posted, cutoff));
    ledgers.set(game.date, ledger);
    games += 1;
    if (games % 10 === 0) console.error(`${games} games replayed`);
  }
}
mkdirSync(ledgerDir, { recursive: true });
for (const ledger of ledgers.values()) {
  updateClose(ledger, feedByDate.get(ledger.date) ?? []);
  settle(ledger, byId);
  writeFileSync(join(ledgerDir, `${ledger.date}.json`), serializeLedger(ledger));
}
// Report the whole ledger, not only the days this run filled.
const record = buildRecord([...readLedgers(ledgerDir).values()].sort((a, b) => a.date.localeCompare(b.date)));
console.log(JSON.stringify({ draws, games, dates: [...ledgers.keys()].sort(), rows: [...ledgers.values()].reduce((sum, file) => sum + file.rows.length, 0), graded: record.settled, tiers: record.tiers.map((tier) => ({ side: tier.side, lo: tier.lo, n: tier.n, win: tier.n ? +(tier.wins / tier.n).toFixed(4) : null, need: +tier.need.toFixed(4), units: +tier.units.toFixed(1), edge: +tier.edge.toFixed(4), pooled: tier.pooled })), moves: record.moves }, null, 1));
