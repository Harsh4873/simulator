import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createLeaderAccumulator,
  finalizeGameLeaders,
  leaderRaceIsClose,
  leaderScore,
  recordGameLeaders,
  type LeaderLine,
} from '../src/game-leaders.ts';
import { gameLeadersHtml as renderLeaders, renderProjections, type ProjectionView } from '../src/projections.ts';
import { simulate } from '../src/simulate.ts';
import type { RateCard, Slate } from '../src/types.ts';

const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;

function line(id: string, team: string, min: number, pts: number, reb = 0, ast = 0): LeaderLine {
  return { athlete_id: id, name: id, team_id: team, min, pts, reb, ast };
}

test('game leaders use the whole pool and treat ties as dead heats, not two-mean ranking', () => {
  const acc = createLeaderAccumulator([
    line('star', 'a', 0, 0),
    line('role', 'h', 0, 0),
    line('bench', 'h', 0, 0),
  ]);
  // Star mean 20, role mean 21. Ranking by averages would pick role. Joint draws split 50/50.
  recordGameLeaders([line('star', 'a', 30, 30), line('role', 'h', 30, 21), line('bench', 'h', 20, 10)], acc);
  recordGameLeaders([line('star', 'a', 30, 10), line('role', 'h', 30, 21), line('bench', 'h', 20, 10)], acc);
  const leaders = finalizeGameLeaders(acc, 2);
  assert.equal(leaders.pts[0].athlete_id, 'role');
  assert.equal(leaders.pts[0].sole, 1);
  assert.equal(leaders.pts[1].athlete_id, 'star');
  assert.equal(leaders.pts[1].sole, 1);
  assert.ok(leaders.pts[0].mean > leaders.pts[1].mean);
  assert.equal(leaderScore(leaders.pts[0], 2), leaderScore(leaders.pts[1], 2));
  assert.equal(leaderRaceIsClose(leaders.pts, 2), true);

  const ties = createLeaderAccumulator([line('a', 't', 0, 0), line('b', 't', 0, 0)]);
  recordGameLeaders([line('a', 't', 20, 20), line('b', 't', 20, 20)], ties);
  const tied = finalizeGameLeaders(ties, 1);
  assert.equal(tied.pts[0].sole, 0);
  assert.equal(tied.pts[0].tied, 1);
  assert.equal(tied.pts[1].sole, 0);
  assert.equal(tied.pts[1].tied, 1);

  const hidden = createLeaderAccumulator([line('center', 'a', 0, 0), line('hidden', 'h', 0, 0)]);
  recordGameLeaders([line('center', 'a', 32, 20, 8), line('hidden', 'h', 28, 12, 14)], hidden);
  const reb = finalizeGameLeaders(hidden, 1);
  assert.equal(reb.reb[0].athlete_id, 'hidden');
  assert.equal(reb.reb[0].sole, 1);
  assert.ok(reb.reb[0].mean > reb.reb.find(row => row.athlete_id === 'center')!.mean);
});

test('replacement-level fill-ins are not game-leader candidates', () => {
  const acc = createLeaderAccumulator([line('real', 'a', 0, 0)]);
  recordGameLeaders(
    [line('real', 'a', 20, 8), { ...line('replacement:a:0', 'a', 28, 20), replacement_level: true, name: 'Replacement-level' }],
    acc,
  );
  const leaders = finalizeGameLeaders(acc, 1);
  assert.equal(leaders.pts[0].athlete_id, 'real');
  assert.equal(leaders.pts[0].sole, 1);
  assert.equal(leaders.pts.some(row => row.athlete_id.startsWith('replacement:')), false);
});

test('simulate stores joint leader shares and the projections page ranks by lead chance', () => {
  const game = card.games[0];
  const slateGame = slate.games.find(item => item.event_id === game.event_id)!;
  const simulation = simulate(game, 11, 80);
  assert.ok(simulation.leaders);
  assert.equal(simulation.leaders.draws, 80);
  assert.ok(simulation.leaders.pts.length >= 2);
  const top = simulation.leaders.pts[0];
  const byMean = [...simulation.leaders.pts].sort((a, b) => b.mean - a.mean || a.athlete_id.localeCompare(b.athlete_id));
  assert.equal(top.sole + top.tied > 0, true);
  // Ranking key is lead chance. A higher mean does not automatically sit first.
  const html = renderLeaders(slateGame, simulation.leaders, false);
  assert.match(html, /Most in the game/);
  assert.match(html, /PASS on every most-in-game market/);
  assert.match(html, /not by projected averages/);
  assert.match(html, new RegExp(top.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const view: ProjectionView = {
    slate,
    card,
    now: new Date(card.generated_at ?? '2026-11-02T18:00:00Z'),
    query: '',
    eventId: game.event_id,
    athleteId: null,
    form: { market: 'pts', line: '20.5', side: 'over', style: 'american', odds: '', opposite: '' },
    simulation,
    drawing: false,
    overrides: {},
    scope: 'game',
  };
  const page = renderProjections(view);
  assert.match(page, /data-block="proj-leaders"/);
  assert.match(page, /Card generated/);
  assert.equal(leaderScore(top, 80) >= leaderScore(byMean[0], 80), true);
});
