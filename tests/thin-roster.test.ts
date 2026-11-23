import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawGame, simulate } from '../src/simulate.ts';
import { fnv1a, mulberry32 } from '../src/rng.ts';
import { fillThinRoster, InsufficientRosterError, rosterIssue } from '../src/roster-capacity.ts';
import { validateGame } from '../src/validate-card.ts';
import { renderBoxScore } from '../src/boxscore.ts';
import { renderLineupEditor } from '../src/lineup-editor.ts';
import { renderSlate } from '../src/slate.ts';
import { gameLeadersHtml, renderProjections, type ProjectionView } from '../src/projections.ts';
import type { RateCard, RateGame, Slate } from '../src/types.ts';

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
  assert.match(html, /Averages from 10,000 simulated games/);
  assert.doesNotMatch(html, /Thin rotation/);
});

test('an empty team roster still fails closed', () => {
  const game = structuredClone(card.games[0]);
  game.players = game.players.filter(p => p.team_id === game.home_team_id);
  assert.equal(fillThinRoster(game).players.length, game.players.length);
  assert.ok(rosterIssue(game) instanceof InsufficientRosterError);
  assert.throws(() => drawGame(game, mulberry32(1)), InsufficientRosterError);
});

function nineHealthyFoulMachine() {
  const game = thin(4);
  game.context!.fouls = {
    status: 'fitted',
    games: 200,
    heldout_minutes: 1000,
    probabilities: [0, 1],
    by_count: {},
    conditional: false,
    log_loss: 0,
    baseline_log_loss: 1,
    reason: null,
  };
  return game;
}

test('a nine-healthy injured rotation still completes when foul-outs empty the sampled five', () => {
  const game = nineHealthyFoulMachine();
  const healthy = game.players.filter(p => p.team_id === game.away_team_id && p.injury_status === 'healthy');
  assert.equal(healthy.length, 9);
  assert.equal(fillThinRoster(game).thin_rotation, undefined);
  for (let seed = 0; seed < 40; seed++) {
    const draw = drawGame(game, mulberry32(seed));
    assert.equal(draw.away.reduce((sum, p) => sum + p.min, 0), draw.budget);
    for (const p of draw.away) if (p.injury_status === 'out') assert.equal(p.min + p.pts, 0);
  }
  const result = simulate(game, 7, 25);
  assert.ok(result.away.players.filter(p => p.min > 0).length >= 5);
  assert.ok(result.leaders && result.leaders.draws === 25);
});

test('OKC at Indiana on the committed card completes 10,000 page-seed draws', (t) => {
  const live = JSON.parse(readFileSync('public/data/rate-card.json', 'utf8')) as RateCard;
  const liveSlate = JSON.parse(readFileSync('public/data/slate.json', 'utf8')) as Slate;
  const game = live.games.find((item: RateGame) => item.event_id === '401910038');
  const slateGame = liveSlate.games.find(item => item.event_id === '401910038');
  if (!game || !slateGame) {
    t.skip('401910038 is not on the committed card');
    return;
  }
  const seed = fnv1a(`401910038:${live.generated_at ?? ''}`);
  const result = simulate(game, seed, 10000);
  assert.equal(result.playerDraws.size > 0, true);
  assert.equal(result.leaders?.draws, 10000);
  assert.ok(result.leaders && result.leaders.pts.some(row => row.sole + row.tied > 0));
  const html = renderLineupEditor(slateGame, game, {});
  assert.match(html, /Lineups/);
  assert.doesNotMatch(html, /fewer than five/);
  const view: ProjectionView = {
    slate: liveSlate,
    card: live,
    now: new Date(live.generated_at ?? '2026-11-23T18:00:00Z'),
    query: '',
    eventId: game.event_id,
    athleteId: null,
    form: { market: 'pts', line: '20.5', side: 'over', style: 'american', odds: '', opposite: '' },
    simulation: result,
    drawing: false,
    overrides: {},
    scope: 'game',
  };
  const page = renderProjections(view);
  assert.match(page, /OKC/);
  assert.match(page, /Most in the game/);
  assert.match(page, /Card generated/);
  assert.match(gameLeadersHtml(slateGame, result.leaders, false), /PASS on every most-in-game market/);
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
