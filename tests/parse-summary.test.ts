import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSummary } from '../src/parse-summary.ts';

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/summary-event.json'), 'utf8'),
);

test('summary rows keep both sides of the hyphen and the points identity', () => {
  const rows = parseSummary(fixture);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    athlete_id: '999',
    team_id: '29',
    minutes: 37,
    fgm: 6,
    fga: 13,
    tpm: 4,
    tpa: 7,
    ftm: 9,
    fta: 9,
    pts: 25,
    reb: 13,
    ast: 6,
  });
  assert.equal(rows.some((row) => row.athlete_id === '100'), false);
  assert.equal(rows.some((row) => row.athlete_id === '101'), false);
});

test('a summary without the attempt keys contributes no players', () => {
  assert.deepEqual(parseSummary({ boxscore: { players: [{ team: { id: '9' }, statistics: [{ keys: ['minutes'] }] }] } }), []);
});
