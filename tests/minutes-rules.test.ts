import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { iterationSeed, mulberry32 } from '../src/rng.ts';
import {
  representativeIndex,
  drawGame,
  isUnobservedProfile,
  percentileDrawIndex,
  simulate,
  type DrawnPlayer,
  type RevisedDraw,
} from '../src/simulate.ts';
import type { RateCard, RatePlayer } from '../src/types.ts';

const card = JSON.parse(readFileSync(new URL('./fixtures/minutes-rules.json', import.meta.url), 'utf8')) as RateCard;
const game = card.games[0];
const scoreless = card.games[1];
const KEYS = ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'pts', 'reb', 'ast'] as const;

function side(teamId: string): RatePlayer[] {
  return game.players.filter((player) => player.team_id === teamId);
}

function points(lines: DrawnPlayer[]): number {
  return lines.reduce((sum, line) => sum + line.pts, 0);
}

function minutes(lines: DrawnPlayer[]): number {
  return lines.reduce((sum, line) => sum + line.min, 0);
}

test('revised draws keep caps, sit unobserved players, and preserve observed minute shares', { timeout: 120_000 }, () => {
  const away = side(game.away_team_id);
  const home = side(game.home_team_id);
  const historical = away.filter((player) => player.minutes_weight !== 0 && player.shooting_games > 0 && player.games >= 3);
  assert.equal(historical.length, 8);
  const meanSum = away.reduce((sum, player) => sum + player.minutes_mean, 0);
  const largest = Math.max(...away.map((player) => player.minutes_mean));
  assert.ok(largest <= 0.2 * meanSum);
  const cenac = away.find((player) => player.minutes_weight === 1 && player.shooting_games === 0 && player.games === 1 && player.minutes_mean === 22);
  const wagner = away.find((player) => player.shooting_games === 13 && player.games === 42);
  const tatum = away.find((player) => player.shooting_games === 0 && player.games === 25 && player.minutes_weight === 1);
  const outs = away.filter((player) => player.minutes_weight === 0);
  assert.ok(cenac && wagner && tatum && outs.length > 0);
  assert.ok(isUnobservedProfile(cenac));
  assert.equal(isUnobservedProfile(tatum), false);
  assert.equal(isUnobservedProfile(wagner), false);
  assert.ok(wagner.minutes_mean > 0 && wagner.minutes_mean < largest);
  const homeHistorical = home.filter((player) => player.minutes_weight !== 0 && player.shooting_games > 0 && player.games >= 3);
  assert.ok(homeHistorical.length >= 5);
  const star = historical
    .filter((player) => player.athlete_id !== wagner.athlete_id)
    .reduce((best, player) => (player.minutes_mean > best.minutes_mean ? player : best));
  assert.ok(star.shooting_games > 0 && star.games >= 3);

  const draws = 2000;
  const totals = new Map<string, { minutes: number; zeros: number; max: number }>();
  const watch = [cenac, wagner, tatum, star, ...outs];
  for (const player of watch) totals.set(player.athlete_id, { minutes: 0, zeros: 0, max: 0 });

  for (let index = 0; index < draws; index += 1) {
    const draw: RevisedDraw = drawGame(game, mulberry32(iterationSeed(401909877, index)));
    const awayPts = points(draw.away);
    const homePts = points(draw.home);
    assert.notEqual(awayPts, homePts);
    assert.equal(draw.overtime, draw.regulationAwayPts === draw.regulationHomePts);
    assert.equal(draw.overtime, draw.overtimePeriods > 0);
    assert.equal(draw.budget, 240 + 25 * draw.overtimePeriods);
    assert.equal(minutes(draw.away), draw.budget);
    assert.equal(minutes(draw.home), draw.budget);
    for (const line of [...draw.away, ...draw.home]) {
      if (line.minutes_weight === 0) {
        for (const key of KEYS) assert.equal(line[key], 0);
      }
      if (draw.overtimePeriods === 0) assert.ok(line.min <= 48, `${line.athlete_id} ${line.min}`);
      if (draw.overtimePeriods === 1) assert.ok(line.min <= 53, `${line.athlete_id} ${line.min}`);
      if (isUnobservedProfile(line)) assert.ok(line.min <= 12);
      if (!isUnobservedProfile(line)) assert.ok(line.min <= 48 + 5 * draw.overtimePeriods);
      const bucket = totals.get(line.athlete_id);
      if (!bucket) continue;
      bucket.minutes += line.min;
      if (line.min === 0) bucket.zeros += 1;
      if (line.min > bucket.max) bucket.max = line.min;
    }
  }

  const cenacStats = totals.get(cenac.athlete_id);
  const wagnerStats = totals.get(wagner.athlete_id);
  const tatumStats = totals.get(tatum.athlete_id);
  const starStats = totals.get(star.athlete_id);
  assert.ok(cenacStats && wagnerStats && tatumStats && starStats);
  assert.ok(cenacStats.minutes / draws < 5, `cenac mean ${cenacStats.minutes / draws}`);
  assert.ok(cenacStats.zeros / draws >= 0.7, `cenac zeros ${cenacStats.zeros}`);
  assert.ok(cenacStats.max <= 12);
  for (const player of outs) {
    const stats = totals.get(player.athlete_id);
    assert.ok(stats);
    assert.equal(stats.minutes / draws, 0);
  }
  assert.ok(wagnerStats.minutes > 0);
  assert.ok(starStats.minutes > 0);
  assert.ok(wagnerStats.minutes / draws < starStats.minutes / draws, 'a lower minutes projection stays below the star');
  assert.ok(tatumStats.minutes / draws > 24, `tatum mean ${tatumStats.minutes / draws}`);
});

test('the shown draw is the game nearest the expected score', () => {
  const result = simulate(game, 401909877, 40);
  assert.equal(result.index, representativeIndex(result.awayTotals, result.homeTotals));

  assert.equal(result.upsideIndex, percentileDrawIndex(result.combinedTotals, 0.95));
  assert.equal(result.combinedTotals[result.index], result.away.pts + result.home.pts);
  assert.equal(result.combinedTotals[result.upsideIndex], result.upside.away.pts + result.upside.home.pts);
  assert.notEqual(result.away.pts, result.home.pts);
  assert.equal(result.wins.away + result.wins.tie + result.wins.home, 40);
});

test('a scoreless game throws when overtime cannot separate the teams', () => {
  assert.throws(() => drawGame({...scoreless,players:scoreless.players.map(p=>({...p,games:30,games_2026:30,shooting_games:30,play_probability:1}))}, mulberry32(1)), /overtime did not separate the teams/);
});
