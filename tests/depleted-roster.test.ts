import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { drawGame, simulate } from '../src/simulate.ts';
import { mulberry32 } from '../src/rng.ts';
import { InsufficientRosterError, relaxMinuteCaps, rosterIssue } from '../src/roster-capacity.ts';
import { validateGame, validateGeneration } from '../src/validate-card.ts';
import { renderSlate } from '../src/slate.ts';
import type { RateCard, Slate } from '../src/types.ts';
const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8')) as RateCard;
const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json','utf8')) as Slate;

// Deliberate availability scenarios over real frozen player profiles; never publication inputs.
function depleted(out: number) {
  const game = structuredClone(card.games[0]);
  const roster = game.players.filter(p=>p.team_id===game.away_team_id).slice(0,13);
  assert.equal(roster.length,13);
  roster.forEach((p,i)=>{
    p.injury_status=i<out?'out':'healthy';p.minutes_weight=i<out?0:1;
    p.play_probability=i<out?0:1;p.questionable_widen=false;
    p.minutes_restriction=i<out?null:20;
    if(i>=11){p.shooting_games=0;p.games=0;p.games_2026=0;p.games_2027=0;p.minutes_restriction=null;}
  });
  game.players=[...roster,...game.players.filter(p=>p.team_id===game.home_team_id)];
  // Five-player physical capacity is tested independently of random disqualifications.
  game.context!.fouls=undefined;
  return game;
}

for(const out of [6,8])test(`${out}-out rotation relaxes caps, preserves budgets and never revives OUT players`,()=>{
  const game=depleted(out);validateGame(game);
  let overtime=0;
  for(let seed=0;seed<150;seed++){
    const draw=drawGame(game,mulberry32(seed));
    assert.equal(draw.relaxedMinuteCaps,true);
    if(draw.overtime)overtime++;
    for(const [i,period] of draw.periodMinutes!.entries())for(const minutes of [period.away,period.home]){
      assert.equal(minutes.reduce((s,m)=>s+m,0),i===0?240:25);
      assert.ok(minutes.every(m=>Number.isInteger(m)&&m>=0&&m<=(i===0?48:5)));
    }
    for(const p of draw.away){
      if(p.injury_status==='out')assert.equal(p.min+p.pts+p.fga+p.fta+p.reb+p.ast,0);
      assert.ok(p.min<=48+5*draw.overtimePeriods);
    }
  }
  assert.ok(overtime>0,'exercise overtime cap relaxation');
  assert.equal(simulate(game,42,10).relaxedMinuteCapDraws,10);
});

test('healthy emergency reserves can fill a depleted draw; missed injured players stay out',()=>{
  const game=depleted(6),active=game.players.filter(p=>p.team_id===game.away_team_id&&p.minutes_weight===1);
  active.slice(4).forEach(p=>{p.play_probability=0;});
  active[4].injury_status='questionable';active[4].questionable_widen=true;
  const draw=drawGame(game,mulberry32(5));
  assert.equal(draw.away.find(p=>p.athlete_id===active[4].athlete_id)!.min,0);
  assert.ok(draw.away.filter(p=>active.slice(5).some(r=>r.athlete_id===p.athlete_id)).some(p=>p.min>0));
  active.slice(5).forEach(p=>{p.injury_status='injured';});
  assert.throws(()=>drawGame(game,mulberry32(5)),InsufficientRosterError);
});

test('a physically impossible game is catchable and does not disable the rest of the slate',()=>{
  const game=depleted(9),copy=structuredClone(card);
  assert.throws(()=>validateGame(game),InsufficientRosterError);
  assert.throws(()=>simulate(game,1,1),{code:'INSUFFICIENT_ELIGIBLE_ROSTER'});
  game.simulation_error=rosterIssue(game)!.message;copy.games[0]=game;
  validateGeneration(slate,copy);
  const html=renderSlate(slate,copy,new Date(copy.generated_at!));
  assert.match(html,/fewer than five eligible players/);
  assert.match(html,/disabled/);
  assert.ok(html.includes('>Simulate</button>'));
  copy.games[0].players[0].fga_per_min=NaN;
  assert.throws(()=>validateGeneration(slate,copy),/Invalid fga_per_min/);
});

test('cap relaxation preserves ordinary caps and stops at the physical period maximum',()=>{
  const caps=[48,48,48,48,48];assert.equal(relaxMinuteCaps(caps,caps,240,'a'),caps);
  assert.deepEqual(relaxMinuteCaps([12,12,12,12,12],[48,48,48,48,48],240,'a'),caps);
  assert.deepEqual(relaxMinuteCaps([0,0,0,0,0],[5,5,5,5,5],25,'a'),[5,5,5,5,5]);
  assert.throws(()=>relaxMinuteCaps([48,48,48,48],[48,48,48,48],240,'a'),InsufficientRosterError);
});

test('ordinary possessions-v4 seeded draws match the pre-fix baseline byte for byte',()=>{
  const baseline=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/seeded-draws.json','utf8')) as {event_id:string;seed:number;sha256:string}[];
  for(const row of baseline){
    const draw=drawGame(card.games.find(g=>g.event_id===row.event_id)!,mulberry32(row.seed));
    assert.equal(createHash('sha256').update(JSON.stringify(draw)).digest('hex'),row.sha256);
  }
});
