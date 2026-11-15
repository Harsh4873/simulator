// Draws every playable game on the built rate card and writes each one's summary beside it as data/sims/<event>.json,
// with data/sims/index.json last. The page reads these instead of running 10,000 draws on a phone. The seed and draw
// count are the ones the page would use itself, so the numbers are the same ones it would have drawn.
// Used by the deploy job on the built `dist/data`. A failure leaves the page to draw its own games.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a } from '../src/rng.ts';
import { ITERATIONS, simulate } from '../src/simulate.ts';
import { parsePublishedSim, publishedIndex, summarizeSimulation, type PublishedExpectation } from '../src/published-sim.ts';
import type { RateCard } from '../src/types.ts';

export function publishSims(options: { dataDir: string; iterations?: number; log?: (line: string) => void }): { written: string[]; skipped: string[] } {
  const iterations = options.iterations ?? ITERATIONS;
  const log = options.log ?? (() => {});
  const card = JSON.parse(readFileSync(join(options.dataDir, 'rate-card.json'), 'utf8')) as RateCard;
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
    try {
      const seed = fnv1a(`${eventId}:${card.generated_at ?? ''}`);
      const meta: Omit<PublishedExpectation, 'iterations'> = { event_id: eventId, ...base, seed };
      const text = JSON.stringify(summarizeSimulation(simulate(game, seed, iterations), meta));
      // The page applies this same check on load; a file that fails it here would only waste a request.
      if (!parsePublishedSim(text, { ...meta, iterations })) throw new Error('published counts do not add up');
      writeFileSync(join(outDir, `${eventId}.json`), text);
      written.push(eventId);
      log(`${eventId} ${(text.length / 1024).toFixed(0)} KB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (error) {
      skipped.push(eventId);
      log(`${eventId} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(publishedIndex({ ...base, iterations }, written)));
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
