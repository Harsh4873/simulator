import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { drawGame, simulate } from '../src/simulate.ts';
import { mulberry32, iterationSeed } from '../src/rng.ts';
import { crps, scoreProbability } from '../src/evaluation.ts';
import { eligibleEvents, fitCurrentRoles, fitMatchup } from '../src/team-model.ts';
import { renderPlayerPanel } from '../src/boxscore.ts';
import type { RateCard, Slate, ShootingCache } from '../src/types.ts';
const card:RateCard=JSON.parse(readFileSync('public/data/rate-card.json','utf8'));
const slate:Slate=JSON.parse(readFileSync('public/data/slate.json','utf8'));
const cache:ShootingCache=JSON.parse(readFileSync('data/shooting-cache.json','utf8'));
const sum=(xs:number[])=>xs.reduce((a,b)=>a+b,0);

test('current possession sampler reconciles scores, possessions, boards, assists and each overtime period',()=>{
  const game=card.games[1];assert.ok(game.context);
  let ot=0;
  for(let i=0;i<1000;i++){
    const d=drawGame(game,mulberry32(iterationSeed(55,i)));
    if(d.overtime)ot++;
    for(const team of [d.away,d.home]){
      assert.equal(sum(team.map(p=>p.min)),d.budget);
      const baskets=sum(team.map(p=>p.fgm));
      assert.ok(sum(team.map(p=>p.ast))<=baskets);
      assert.equal(sum(team.map(p=>p.fga+(p.ft_possession_trips??p.fta/2)+(p.tov??0)-(p.orb??0))),sum(d.possessions!));
      for(const p of team){assert.ok(p.ast<=baskets-p.fgm);assert.equal(p.pts,2*(p.fgm-p.tpm)+3*p.tpm+p.ftm);if(p.min===0)assert.equal(p.pts+p.ast+p.reb+(p.stl??0)+(p.blk??0),0);}
    }
    const all=[...d.away,...d.home];
    assert.ok(sum(all.map(p=>p.reb))<=sum(all.map(p=>p.fga-p.fgm+p.fta-p.ftm)));
    assert.ok(sum(d.away.map(p=>p.stl??0))<=sum(d.home.map(p=>p.tov??0)));
    assert.ok(sum(d.home.map(p=>p.blk??0))<=sum(d.away.map(p=>p.fga-p.fgm)));
    for(const period of d.periodMinutes!.slice(1))for(const minutes of [period.away,period.home]){assert.equal(sum(minutes),25);assert.ok(minutes.every(m=>m>=0&&m<=5));}
  }
  assert.ok(ot>0,'must exercise overtime');
});
test('minutes vary continuously across 24 and identical players remain exchangeable',()=>{
  const base=structuredClone(card.games[0]);
  // Synthetic equal-role fixture, never a published data source.
  base.players=base.players.filter(p=>p.team_id===base.away_team_id).slice(0,10).flatMap((p,i)=>[base.away_team_id,base.home_team_id].map(team=>({...p,athlete_id:`${team}-${i}`,team_id:team,minutes_mean:24,minutes_weight:1 as const,play_probability:1,games:50,games_2026:45,games_2027:5,shooting_games:50,questionable_widen:false})));
  const means=[];
  for(const target of [23.5,23.9,24,24.1,24.5]){
    const g=structuredClone(base);g.players[0].minutes_mean=target;
    const r=simulate(g,42,600);means.push(r.away.players.find(p=>p.athlete_id===g.players[0].athlete_id)!.expectation!.minMean);
  }
  for(let i=1;i<means.length;i++)assert.ok(Math.abs(means[i]-means[i-1])<1,JSON.stringify(means));
  const r=simulate(base,41,1000),m=r.away.players.map(p=>p.expectation!.minMean);
  assert.ok(Math.max(...m)-Math.min(...m)<1,JSON.stringify(m));
});
test('opponent defense and venue affect scoring in the intended direction',()=>{
  const good=structuredClone(card.games[1]),bad=structuredClone(good);
  good.context!.home.defense*=.9;bad.context!.home.defense*=1.1;
  assert.ok(simulate(good,7,700).forecast!.awayMean<simulate(bad,7,700).forecast!.awayMean);
  const neutral=structuredClone(good);neutral.context!.neutral=true;
  assert.ok(Number.isFinite(simulate(neutral,7,50).forecast!.homeMean));
});
test('forecast panel renders aggregate expectations, not a representative score',()=>{
  const g=card.games[0],r=simulate(g,72,200),p=r.away.players.find(p=>p.expectation!.ptsMean>0)!;
  p.pts=999;p.min=999;
  const html=renderPlayerPanel(slate.games[0],g,r,p.athlete_id);
  assert.match(html,/<h3>Expected line<\/h3>/);
  assert.ok(html.includes(p.expectation!.ptsMean.toFixed(1)));
  assert.ok(!html.includes('>999<'));
});
test('chronological fitting excludes future and nonregular events',()=>{
  const events=cache.events!;const cutoff=events[events.length-5].start_time;
  assert.ok(eligibleEvents(events,cutoff).every(e=>Date.parse(e.start_time)<Date.parse(cutoff)&&e.season_type===2));
  const before=fitMatchup(events,slate.games[0],cutoff);
  const modified=structuredClone(events);for(const e of modified)if(Date.parse(e.start_time)>=Date.parse(cutoff)){e.home_pts=999;e.players.forEach(p=>p.pts=999);}
  assert.deepEqual(fitMatchup(modified,slate.games[0],cutoff),before);
  const players=structuredClone(card.games[0].players);fitCurrentRoles(players,eligibleEvents(events,card.generated_at!),2027);
  assert.ok(players.every(p=>p.current_team_games!<=p.team_games!));
});
test('proper scores match hand calculations',()=>{
  assert.equal(crps([0,2],1),.5);assert.equal(crps([1,1],1),0);
  assert.equal(scoreProbability(.5,true).brier,.25);assert.equal(scoreProbability(.5,true).logLoss,Math.log(2));
});

test('current replay is deterministic and ignores a market caption',()=>{
 const g=card.games[0];const first=simulate(g,91,100);
 assert.deepEqual(simulate({...g,spread_caption:'HOME -99'} as typeof g,91,100),first);
 const impossible=structuredClone(g);impossible.players.filter(p=>p.team_id===g.home_team_id).forEach(p=>{p.play_probability=0;});
 assert.throws(()=>drawGame(impossible,mulberry32(1)),/Insufficient eligible/);
});
