import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { iterationSeed, mulberry32 } from '../src/rng.ts';
import { typicalityBucket } from '../src/display.ts';
import {
  ITERATIONS,
  drawGame,
  largestRemainder,
  quantile,
  shownDrawIndex,
  simulate,
  type DrawnPlayer,
  type Simulation,
} from '../src/simulate.ts';
import type { RateCard } from '../src/types.ts';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const card = JSON.parse(readFileSync(join(fixtureDir, 'fixtures/tiny-rate-card.json'), 'utf8')) as RateCard;
const bknBos = (
  JSON.parse(readFileSync(join(fixtureDir, 'fixtures/bkn-bos-rate-card.json'), 'utf8')) as RateCard
).games[0];
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

function assertScore(result: Simulation, seed: number, iterations: number): void {
  for (const side of [result.away, result.home]) {
    let activeMinutes = 0;
    const sums = { min: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, pts: 0, reb: 0, ast: 0 };
    for (const player of side.players) {
      assertPlayer(player);
      assert.ok(player.band.p10 <= player.band.p50 && player.band.p50 <= player.band.p90);
      for (const key of ['min', 'tpm', 'pts', 'reb', 'ast'] as const) {
        const read = player.reads[key];
        assert.equal(read.bucket, typicalityBucket(read.percent, read.constant));
        assert.equal(Number.isInteger(read.percent), true);
        assert.ok(read.percent >= 0 && read.percent <= 100);
      }
      if (player.minutes_weight !== 0) activeMinutes += player.min;
      for (const key of KEYS) sums[key] += player[key];
    }
    assert.equal(activeMinutes, result.budget);
    assert.equal(side.pts, sums.pts);
    assert.ok(Number.isFinite(side.volumeShock) && side.volumeShock > 0);
    assert.equal(side.pointsRead.bucket, typicalityBucket(side.pointsRead.percent, side.pointsRead.constant));
    for (const key of KEYS) assert.equal(sums[key], side.players.reduce((sum, player) => sum + player[key], 0));
    assert.ok(side.band.p10 <= side.band.p50 && side.band.p50 <= side.band.p90);
  }
  assert.equal(result.budget, result.overtime ? 265 : 240);
  assert.equal(result.index, shownDrawIndex(seed, iterations));
  assert.equal(result.combinedTotals[result.index], result.away.pts + result.home.pts);
  assert.equal(result.wins.away + result.wins.tie + result.wins.home, iterations);
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
  assert.equal(first.index, shownDrawIndex(42, 300));
  assert.equal(shownDrawIndex(42, 10000), iterationSeed(42, 10000) % 10000);
  assertScore(first, 42, 300);
  const redraw = drawGame(game, mulberry32(iterationSeed(42, first.index)));
  assert.equal(redraw.overtime, first.overtime);
  assert.equal(redraw.budget, first.budget);
  assert.deepEqual(redraw.away.map(core), first.away.players.map(core));
  assert.deepEqual(redraw.home.map(core), first.home.players.map(core));
  const out = first.away.players.find((player) => player.athlete_id === '1001');
  assert.ok(out);
  assertPlayer(out);
  assert.equal(out.reads.min.constant, true);
  assert.equal(out.reads.pts.bucket, 0);
  assert.equal(redraw.awayVolumeShock, first.away.volumeShock);
  assert.equal(redraw.homeVolumeShock, first.home.volumeShock);
});

test('10,000 draws stay legal and finish within 15 seconds', { timeout: 20_000 }, () => {
  const started = Date.now();
  const result = simulate(game, 1, ITERATIONS);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `took ${elapsed}ms`);
  assert.equal(result.combinedTotals.length, ITERATIONS);
  assert.equal(result.wins.away + result.wins.tie + result.wins.home, 10000);
  assertScore(result, 1, ITERATIONS);
  const redraw = drawGame(game, mulberry32(iterationSeed(1, result.index)));
  assert.deepEqual(redraw.away.map(core), result.away.players.map(core));
  assert.deepEqual(redraw.home.map(core), result.home.players.map(core));
});

function teamTotal(players: DrawnPlayer[]): number {
  return players.reduce((sum, player) => sum + player.pts, 0);
}

function drawTotals(rateGame: RateCard['games'][number], firstSeed: number, lastSeed: number) {
  const away: number[] = [];
  const home: number[] = [];
  for (let seed = firstSeed; seed <= lastSeed; seed += 1) {
    const draw = drawGame(rateGame, mulberry32(seed));
    away.push(teamTotal(draw.away));
    home.push(teamTotal(draw.home));
  }
  const awaySorted = away.slice().sort((a, b) => a - b);
  const homeSorted = home.slice().sort((a, b) => a - b);
  const meanOf = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    awayMean: meanOf(away),
    homeMean: meanOf(home),
    awayP90: quantile(awaySorted, 0.9),
    homeP90: quantile(homeSorted, 0.9),
    awayMax: awaySorted[awaySorted.length - 1],
    homeMax: homeSorted[homeSorted.length - 1],
  };
}

test('bkn-bos away and home means stay between 80 and 150 and no team total exceeds 220', () => {
  const stats = drawTotals(bknBos, 1, 200);
  assert.ok(stats.awayMean >= 80 && stats.awayMean <= 150, `bkn-bos away mean ${stats.awayMean}`);
  assert.ok(stats.homeMean >= 80 && stats.homeMean <= 150, `bkn-bos home mean ${stats.homeMean}`);
  assert.ok(Math.max(stats.awayMax, stats.homeMax) <= 220, `bkn-bos max ${stats.awayMax} ${stats.homeMax}`);
});

test('tiny means stay between 80 and 150, 90th percentiles are at most 200, and no team total exceeds 260', () => {
  const stats = drawTotals(game, 1000, 1199);
  assert.ok(stats.awayMean >= 80 && stats.awayMean <= 150, `tiny away mean ${stats.awayMean}`);
  assert.ok(stats.homeMean >= 80 && stats.homeMean <= 150, `tiny home mean ${stats.homeMean}`);
  assert.ok(stats.awayP90 <= 200, `tiny away 90th percentile ${stats.awayP90}`);
  assert.ok(stats.homeP90 <= 200, `tiny home 90th percentile ${stats.homeP90}`);
  assert.ok(Math.max(stats.awayMax, stats.homeMax) <= 260, `tiny max ${stats.awayMax} ${stats.homeMax}`);
});
