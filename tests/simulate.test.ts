import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { iterationSeed, mulberry32 } from '../src/rng.ts';
import {
  ITERATIONS,
  closestIndex,
  drawGame,
  largestRemainder,
  simulate,
  type DrawnPlayer,
  type Simulation,
} from '../src/simulate.ts';
import type { RateCard } from '../src/types.ts';

const card = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tiny-rate-card.json'), 'utf8'),
) as RateCard;
const game = card.games[0];
const KEYS = ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'pts', 'reb', 'ast'] as const;

function core(player: DrawnPlayer) {
  return {
    athlete_id: player.athlete_id,
    minutes_weight: player.minutes_weight,
    min: player.min,
    fgm: player.fgm,
    fga: player.fga,
    tpm: player.tpm,
    tpa: player.tpa,
    ftm: player.ftm,
    fta: player.fta,
    pts: player.pts,
    reb: player.reb,
    ast: player.ast,
  };
}

function assertPlayer(player: DrawnPlayer): void {
  assert.ok(player.tpm <= player.tpa && player.tpa <= player.fga);
  assert.ok(player.fgm <= player.fga);
  assert.ok(player.ftm <= player.fta);
  assert.ok(player.tpm <= player.fgm);
  assert.equal(player.pts, 2 * (player.fgm - player.tpm) + 3 * player.tpm + player.ftm);
  assert.equal(Number.isInteger(player.min), true);
  assert.ok(player.min >= 0);
  if (player.minutes_weight === 0) {
    for (const key of KEYS) assert.equal(player[key], 0);
  }
}

function assertScore(result: Simulation): void {
  for (const side of [result.away, result.home]) {
    let activeMinutes = 0;
    const sums = { min: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, pts: 0, reb: 0, ast: 0 };
    for (const player of side.players) {
      assertPlayer(player);
      assert.ok(player.band.p10 <= player.band.p50 && player.band.p50 <= player.band.p90);
      if (player.minutes_weight !== 0) activeMinutes += player.min;
      for (const key of KEYS) sums[key] += player[key];
    }
    assert.equal(activeMinutes, result.budget);
    assert.equal(side.pts, sums.pts);
    for (const key of KEYS) assert.equal(sums[key], side.players.reduce((sum, player) => sum + player[key], 0));
    assert.ok(side.band.p10 <= side.band.p50 && side.band.p50 <= side.band.p90);
  }
  assert.equal(result.budget, result.overtime ? 265 : 240);
  assert.equal(result.index, closestIndex(result.combinedTotals));
  assert.equal(result.combinedTotals[result.index], result.away.pts + result.home.pts);
}

test('largest remainder gives the extra minute to the largest fraction', () => {
  assert.deepEqual(
    largestRemainder(
      [
        { athlete_id: 'a', raw: 10.2 },
        { athlete_id: 'b', raw: 10.2 },
        { athlete_id: 'c', raw: 10.6 },
      ],
      31,
    ),
    [10, 10, 11],
  );
  assert.deepEqual(
    largestRemainder(
      [
        { athlete_id: '20', raw: 10.5 },
        { athlete_id: '10', raw: 10.5 },
      ],
      21,
    ),
    [10, 11],
  );
});

test('the same seed replays the displayed box score', () => {
  const first = simulate(game, 42, 300);
  const second = simulate(game, 42, 300);
  assert.deepEqual(first, second);
  assertScore(first);
  const redraw = drawGame(game, mulberry32(iterationSeed(42, first.index)));
  assert.equal(redraw.overtime, first.overtime);
  assert.equal(redraw.budget, first.budget);
  assert.deepEqual(redraw.away.map(core), first.away.players.map(core));
  assert.deepEqual(redraw.home.map(core), first.home.players.map(core));
  const out = first.away.players.find((player) => player.athlete_id === '1001');
  assert.ok(out);
  assertPlayer(out);
});

test('10,000 draws stay legal and finish within 15 seconds', { timeout: 20_000 }, () => {
  const started = Date.now();
  const result = simulate(game, 1, ITERATIONS);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `took ${elapsed}ms`);
  assert.equal(result.combinedTotals.length, ITERATIONS);
  assertScore(result);
  const redraw = drawGame(game, mulberry32(iterationSeed(1, result.index)));
  assert.deepEqual(redraw.away.map(core), result.away.players.map(core));
  assert.deepEqual(redraw.home.map(core), result.home.players.map(core));
});
