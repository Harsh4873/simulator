import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { iterationSeed, mulberry32 } from '../src/rng.ts';
import { drawGame } from '../src/simulate.ts';
import type { RateCard, RatePlayer } from '../src/types.ts';

const card = JSON.parse(
  readFileSync(new URL('./fixtures/rate-card-2026-10-27.json', import.meta.url), 'utf8'),
) as RateCard;

function findPlayer(players: RatePlayer[], name: string): RatePlayer {
  const player = players.find((item) => item.name === name);
  assert.ok(player, name);
  return player;
}

test('revised Brooklyn-Boston draws sit Cenac, keep Wagner with Randle, and give Tatum real minutes', { timeout: 120_000 }, () => {
  const game = card.games.find((item) => item.event_id === '401909877');
  assert.ok(game);
  const cenac = game.players.find((player) => player.name.includes('Cenac'));
  const wagner = findPlayer(game.players, 'Moritz Wagner');
  const randle = findPlayer(game.players, 'Julius Randle');
  const tatum = findPlayer(game.players, 'Jayson Tatum');
  assert.ok(cenac);
  assert.ok(Math.abs(wagner.minutes_mean / randle.minutes_mean - 13.7618 / 32.0759) < 1e-4);
  const draws = 1000;
  let cenacMinutes = 0;
  let wagnerMinutes = 0;
  let randleMinutes = 0;
  let tatumMinutes = 0;
  let ties = 0;
  for (let index = 0; index < draws; index += 1) {
    const draw = drawGame(game, mulberry32(iterationSeed(401909877, index)));
    const awayPts = draw.away.reduce((sum, line) => sum + line.pts, 0);
    const homePts = draw.home.reduce((sum, line) => sum + line.pts, 0);
    if (awayPts === homePts) ties += 1;
    const line = (athleteId: string) =>
      draw.away.find((item) => item.athlete_id === athleteId) ?? draw.home.find((item) => item.athlete_id === athleteId);
    cenacMinutes += line(cenac.athlete_id)?.min ?? 0;
    wagnerMinutes += line(wagner.athlete_id)?.min ?? 0;
    randleMinutes += line(randle.athlete_id)?.min ?? 0;
    tatumMinutes += line(tatum.athlete_id)?.min ?? 0;
  }
  assert.ok(cenacMinutes / draws < 5, `cenac mean ${cenacMinutes / draws}`);
  assert.ok(wagnerMinutes > 0);
  assert.ok(randleMinutes / draws > 28, `randle mean ${randleMinutes / draws}`);
  assert.ok(wagnerMinutes < randleMinutes);
  assert.ok(tatumMinutes / draws > 28, `tatum mean ${tatumMinutes / draws}`);
  assert.equal(ties, 0);
});
