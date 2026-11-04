import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawGame, simulate } from '../src/simulate.ts';
import { mulberry32 } from '../src/rng.ts';
import { fillThinRoster, InsufficientRosterError, rosterIssue } from '../src/roster-capacity.ts';
import { validateGame } from '../src/validate-card.ts';
import { renderBoxScore } from '../src/boxscore.ts';
import { renderSlate } from '../src/slate.ts';
import type { RateCard, Slate } from '../src/types.ts';

const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;

function thin(out: number) {
  const game = structuredClone(card.games[0]);
  const roster = game.players.filter(p => p.team_id === game.away_team_id).slice(0, 13);
  roster.forEach((p, i) => {
    p.injury_status = i < out ? 'out' : 'healthy';
    p.minutes_weight = i < out ? 0 : 1;
    p.play_probability = i < out ? 0 : 1;
    p.questionable_widen = false;
  });
  game.players = [...roster, ...game.players.filter(p => p.team_id === game.home_team_id)];
  game.context!.fouls = undefined;
  return game;
}

test('a four-player rotation fills labelled replacement-level minutes and still simulates', () => {
  const game = thin(9);
  const filled = fillThinRoster(game);
  assert.equal(filled.thin_rotation, true);
  assert.ok(filled.players.some(p => p.replacement_level && p.team_id === game.away_team_id));
  assert.equal(rosterIssue(game), null);
  validateGame(game);
  const result = simulate(game, 3, 40);
  assert.equal(result.thin_rotation, true);
  assert.equal(result.away.players.filter(p => p.min > 0).length >= 5, true);
  for (const p of result.away.players) {
    if (p.injury_status === 'out') assert.equal(p.min + p.pts, 0);
  }
  const html = renderBoxScore(slate.games[0], game, result, new Date());
  assert.match(html, /Thin rotation/);
  assert.match(html, /league-average rates/);
});

test('an empty team roster still fails closed', () => {
  const game = structuredClone(card.games[0]);
  game.players = game.players.filter(p => p.team_id === game.home_team_id);
  assert.equal(fillThinRoster(game).players.length, game.players.length);
  assert.ok(rosterIssue(game) instanceof InsufficientRosterError);
  assert.throws(() => drawGame(game, mulberry32(1)), InsufficientRosterError);
});

test('slate keeps Simulate enabled on a thin rotation and flags it', () => {
  const copy = structuredClone(card);
  copy.games[0] = fillThinRoster(thin(9));
  copy.generated_at = slate.generated_at;
  const html = renderSlate(slate, copy, new Date(copy.generated_at!));
  assert.match(html, /Thin rotation/);
  assert.match(html, />Simulate</);
  assert.doesNotMatch(html, /disabled/);
});
