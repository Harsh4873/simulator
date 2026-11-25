// Draws every playable game on the built rate card and writes each one's summary beside it as data/sims/<event>.json,
// with data/sims/index.json last. The page reads these instead of running 10,000 draws on a phone. The seed and draw
// count are the ones the page would use itself, so the numbers are the same ones it would have drawn.
// Used by the deploy job on the built `dist/data`. A failure leaves the page to draw its own games.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a } from '../src/rng.ts';
import { ITERATIONS, simulate, type Simulation } from '../src/simulate.ts';
import { parsePublishedSim, publishedIndex, summarizeSimulation, type PublishedExpectation } from '../src/published-sim.ts';
import { dailyPropForGame, dailyPropOffer } from '../src/daily-prop.ts';
import { dailySpreadForGame } from '../src/daily-spread.ts';
import { upcomingToday, type DailyCandidates } from '../src/daily-price.ts';
import { parsePicksFile } from '../src/picks.ts';
import { parsePublishedPropCalibration } from '../src/prop-calibration.ts';
import type { RateCard, Slate } from '../src/types.ts';

export function publishSims(options: { dataDir: string; iterations?: number; now?: Date; log?: (line: string) => void }): { written: string[]; skipped: string[] } {
  const iterations = options.iterations ?? ITERATIONS;
  const log = options.log ?? (() => {});
  const card = JSON.parse(readFileSync(join(options.dataDir, 'rate-card.json'), 'utf8')) as RateCard;
  const readOptional = (name: string) => {
    const path = join(options.dataDir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  const now = options.now ?? new Date();
  const slateText = readOptional('slate.json');
  const slate: Slate | null = slateText ? JSON.parse(slateText) : null;
  const picks = parsePicksFile(readOptional('picks.json'));
  const calibration = parsePublishedPropCalibration(readOptional('prop-calibration.json'));
  const daily: DailyCandidates | undefined = slate?.date ? {
    date: slate.date, slateHash: createHash('sha256').update(slateText).digest('hex'), picksBuiltAt: picks?.built_at ?? null, props: [], spreads: [],
  } : undefined;
  const outDir = join(options.dataDir, 'sims');
  mkdirSync(outDir, { recursive: true });
  const base = { generated_at: card.generated_at, input_hash: card.input_hash ?? null, model_hash: card.model_hash ?? null };
  const written: string[] = [];
  const skipped: string[] = [];
  for (const game of card.games) {
    const eventId = game.event_id;
    if (game.simulation_error) {
      skipped.push(eventId);
      continue;
    }
    const started = Date.now();
    let simulation: Simulation;
    try {
      const seed = fnv1a(`${eventId}:${card.generated_at ?? ''}`);
      const meta: Omit<PublishedExpectation, 'iterations'> = { event_id: eventId, ...base, seed };
      simulation = simulate(game, seed, iterations);
      const text = JSON.stringify(summarizeSimulation(simulation, meta));
      // The page applies this same check on load; a file that fails it here would only waste a request.
      if (!parsePublishedSim(text, { ...meta, iterations })) throw new Error('published counts do not add up');
      writeFileSync(join(outDir, `${eventId}.json`), text);
      written.push(eventId);
      log(`${eventId} ${(text.length / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      skipped.push(eventId);
      log(`${eventId} skipped: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const fixture = slate?.games.find(item => item.event_id === eventId);
      if (daily && fixture && upcomingToday(fixture, now)) {
        const spread = dailySpreadForGame(fixture, card, simulation, now);
        if (spread) daily.spreads.push(spread);
        const prop = dailyPropForGame(fixture, game, simulation, picks, card, calibration, now);
        if (prop) daily.props.push(dailyPropOffer(prop));
      }
    } catch (error) {
      log(`${eventId} daily comparison unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const index = publishedIndex({ ...base, iterations }, written);
  if (daily) index.daily = daily;
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));
  return { written, skipped };
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
  const result = publishSims({ dataDir: process.argv[2] ?? 'dist/data', log: (line) => console.log(line) });
  console.log(JSON.stringify({ published: result.written.length, skipped: result.skipped.length }));
}
