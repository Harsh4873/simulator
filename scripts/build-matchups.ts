// Writes the descriptive matchup file from the shooting cache and the committed slate and rate card.
// A failure leaves the previous file in place.
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompletedEvent } from '../src/parse-summary.ts';
import type { RateCard, Slate } from '../src/types.ts';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { buildMatchups, serializeMatchups } = await import('../src/matchups.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const slate = JSON.parse(readFileSync(join(root, 'public/data/slate.json'), 'utf8')) as Slate;
const card = JSON.parse(readFileSync(join(root, 'public/data/rate-card.json'), 'utf8')) as RateCard;
const cache = JSON.parse(readFileSync(join(root, 'data/shooting-cache.json'), 'utf8')) as { events?: CompletedEvent[] };
const file = buildMatchups(slate, card, cache.events ?? []);
writeFileSync(join(root, 'public/data/matchups.json'), serializeMatchups(file));
