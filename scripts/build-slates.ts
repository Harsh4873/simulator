import { buildEsportsSlate } from './build-esports-slate.ts';
import { buildNflSlate } from './build-nfl-slate.ts';

const now = new Date();
let failed = false;
try {
  await buildNflSlate(now);
} catch (error) {
  failed = true;
  console.error(`NFL slate was not updated: ${error instanceof Error ? error.message : 'unknown error'}`);
}
try {
  await buildEsportsSlate(now);
} catch (error) {
  failed = true;
  console.error(`Esports slate was not updated: ${error instanceof Error ? error.message : 'unknown error'}`);
}
if (failed) process.exit(1);
