import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { winCounts } from '../src/display.ts';
import { fnv1a, iterationSeed, mulberry32 } from '../src/rng.ts';
import { legacyDrawGame as drawGame } from '../src/legacy.ts';
import { quantile } from '../src/simulate.ts';
import type { RateCard, RateGame } from '../src/types.ts';

const card = JSON.parse(
  readFileSync(new URL('./fixtures/rate-card-2026-10-27.json', import.meta.url), 'utf8'),
) as RateCard;

const CASES = [
  {
    eventId: '401909877',
    wins: { away: 609, tie: 18, home: 373 },
    away: { p10: 87, p50: 110, p90: 136 },
    home: { p10: 79, p50: 102, p90: 127 },
    awayMean: 111.08,
    homeMean: 102.72,
  },
  {
    eventId: '401909878',
    wins: { away: 446, tie: 13, home: 541 },
    away: { p10: 89, p50: 113, p90: 140 },
    home: { p10: 93, p50: 117, p90: 146 },
    awayMean: 113.91,
    homeMean: 118.36,
  },
  {
    eventId: '401909879',
    wins: { away: 353, tie: 16, home: 631 },
    away: { p10: 87, p50: 110, p90: 139 },
    home: { p10: 96, p50: 120, p90: 148 },
    awayMean: 111.87,
    homeMean: 121.56,
  },
  {
    eventId: '401909880',
    wins: { away: 410, tie: 20, home: 570 },
    away: { p10: 93, p50: 116, p90: 143 },
    home: { p10: 97, p50: 122, p90: 150 },
    awayMean: 117.16,
    homeMean: 122.94,
  },
] as const;

function teamPoints(players: { pts: number }[]): number {
  return players.reduce((sum, player) => sum + player.pts, 0);
}

function band(values: number[]): { p10: number; p50: number; p90: number } {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
  };
}

function measure(game: RateGame) {
  const seed = fnv1a(`${game.event_id}:${card.generated_at ?? ''}`) >>> 0;
  const away: number[] = [];
  const home: number[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const draw = drawGame(game, mulberry32(iterationSeed(seed, index)));
    assert.ok(draw.budget === 240 || draw.budget === 265, `${game.event_id} budget ${draw.budget}`);
    away.push(teamPoints(draw.away));
    home.push(teamPoints(draw.home));
  }
  const wins = winCounts(away, home);
  return {
    wins,
    away: band(away),
    home: band(home),
    awayMean: away.reduce((sum, value) => sum + value, 0) / away.length,
    homeMean: home.reduce((sum, value) => sum + value, 0) / home.length,
  };
}

test('published matchups keep the measured 1,000-draw baseline', { timeout: 120_000 }, () => {
  for (const expected of CASES) {
    const game = card.games.find((item) => item.event_id === expected.eventId);
    assert.ok(game, expected.eventId);
    const actual = measure(game);
    assert.equal(actual.wins.away + actual.wins.tie + actual.wins.home, 1000, expected.eventId);
    assert.deepEqual(actual.wins, expected.wins, `${expected.eventId} wins ${JSON.stringify(actual.wins)}`);
    assert.deepEqual(actual.away, expected.away, `${expected.eventId} away band ${JSON.stringify(actual.away)}`);
    assert.deepEqual(actual.home, expected.home, `${expected.eventId} home band ${JSON.stringify(actual.home)}`);
    assert.ok(
      Math.abs(actual.awayMean - expected.awayMean) <= 0.02,
      `${expected.eventId} away mean ${actual.awayMean}`,
    );
    assert.ok(
      Math.abs(actual.homeMean - expected.homeMean) <= 0.02,
      `${expected.eventId} home mean ${actual.homeMean}`,
    );
  }
});
