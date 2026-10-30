import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { iterationSeed, mulberry32 } from '../src/rng.ts';
import { drawGame, playProbability, teamGamesPlayed } from '../src/simulate.ts';
import type { RateCard, RatePlayer } from '../src/types.ts';

const card = JSON.parse(
  readFileSync(new URL('./fixtures/rate-card-2026-10-27.json', import.meta.url), 'utf8'),
) as RateCard;

function player(gameId: string, name: string): RatePlayer {
  const game = card.games.find((item) => item.event_id === gameId);
  assert.ok(game);
  const found = game.players.find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

test('appearance probability follows this season, not a three-game cutoff', () => {
  const game = card.games.find((item) => item.event_id === '401909879');
  assert.ok(game);
  const kings = game.players.filter((item) => item.team_id === '23');
  const games = teamGamesPlayed(kings);
  const pedulla = player('401909879', 'Sean Pedulla');
  const sharp = player('401909879', 'Emanuel Sharp');
  const black = player('401909879', 'Leaky Black');
  const lavine = player('401909879', 'Zach LaVine');
  const sabonis = player('401909879', 'Domantas Sabonis');
  assert.ok(playProbability(pedulla, games) < 0.25, `pedulla ${playProbability(pedulla, games)}`);
  assert.ok(playProbability(black, games) < 0.5, `black ${playProbability(black, games)}`);
  assert.ok(playProbability(sharp, games) >= 0.85, `sharp ${playProbability(sharp, games)}`);
  assert.ok(playProbability(lavine, games) >= 0.85);
  assert.ok(playProbability(sabonis, games) >= 0.85);
  const tatum = player('401909877', 'Jayson Tatum');
  const celtics = card.games.find((item) => item.event_id === '401909877');
  assert.ok(celtics);
  assert.equal(playProbability(tatum, teamGamesPlayed(celtics.players.filter((item) => item.team_id === '2'))), 1);
  assert.equal(playProbability({ ...pedulla, minutes_weight: 0 }, games), 0);
});

test('Pedulla is not in every Kings draw and LaVine keeps a starter share', { timeout: 120_000 }, () => {
  const game = card.games.find((item) => item.event_id === '401909879');
  assert.ok(game);
  const pedulla = player('401909879', 'Sean Pedulla');
  const lavine = player('401909879', 'Zach LaVine');
  const sabonis = player('401909879', 'Domantas Sabonis');
  const draws = 400;
  let pedullaPlays = 0;
  let lavineMinutes = 0;
  let sabonisMinutes = 0;
  for (let index = 0; index < draws; index += 1) {
    const draw = drawGame(game, mulberry32(iterationSeed(401909879, index)));
    const line = (id: string) => draw.away.find((item) => item.athlete_id === id);
    const pedullaLine = line(pedulla.athlete_id);
    if ((pedullaLine?.min ?? 0) > 0) pedullaPlays += 1;
    lavineMinutes += line(lavine.athlete_id)?.min ?? 0;
    sabonisMinutes += line(sabonis.athlete_id)?.min ?? 0;
  }
  assert.ok(pedullaPlays / draws < 0.4, `pedulla play rate ${pedullaPlays / draws}`);
  assert.ok(lavineMinutes / draws > 22, `lavine minutes ${lavineMinutes / draws}`);
  assert.ok(sabonisMinutes / draws > 20, `sabonis minutes ${sabonisMinutes / draws}`);
});

test('a healthy starter who has played every logged game does not draw a DNP', { timeout: 60_000 }, () => {
  const game = card.games.find((item) => item.event_id === '401909877');
  assert.ok(game);
  const tatum = player('401909877', 'Jayson Tatum');
  const draws = 200;
  let minutes = 0;
  let sits = 0;
  const played: number[] = [];
  for (let index = 0; index < draws; index += 1) {
    const draw = drawGame(game, mulberry32(iterationSeed(401909877, index)));
    const line = [...draw.away, ...draw.home].find((item) => item.athlete_id === tatum.athlete_id);
    const value = line?.min ?? 0;
    minutes += value;
    if (value === 0) sits += 1;
    else played.push(value);
  }
  played.sort((a, b) => a - b);
  const p10 = played[Math.max(0, Math.ceil(0.1 * played.length) - 1)] ?? 0;
  const p90 = played[Math.max(0, Math.ceil(0.9 * played.length) - 1)] ?? 0;
  assert.equal(sits, 0);
  assert.ok(minutes / draws > 24, `tatum mean ${minutes / draws}`);
  assert.ok(p10 >= 20, `tatum conditional p10 ${p10}`);
  assert.ok(p90 <= 40, `tatum conditional p90 ${p90}`);
});
