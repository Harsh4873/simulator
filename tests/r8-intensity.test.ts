import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MAX_OWN_MAKE_SHARE,plannedLineupMean} from '../src/possessions.ts';
import {simulate} from '../src/simulate.ts';
import type {RateCard} from '../src/types.ts';

const card=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8')) as RateCard;

test('the planned lineup mean averages each minute of summed rates',()=>{
 assert.equal(plannedLineupMean([1,2,3,4,5,6],[[0,1,2,3,4],[1,2,3,4,5]]),(15+20)/2);
 assert.equal(plannedLineupMean([1,2],[]),0);
 assert.ok(MAX_OWN_MAKE_SHARE>0&&MAX_OWN_MAKE_SHARE<1);
});

test('a lead playmaker keeps the card assist rate and team assists per make stay on the team rate',()=>{
 // Splitting a fixed number of assists each minute, with the shooter skipped twice over, left the lead playmaker
 // about 15% under the card rate while everyone else matched it.
 let lead=0,leadCard=0,rest=0,restCard=0,assists=0,makes=0,rate=0,teams=0;
 for(const game of card.games){
  let sim:ReturnType<typeof simulate>;
  try{sim=simulate(game,11,400);}catch{continue;}
  const mean=(id:string,key:'ast'|'min'|'fgm')=>{const d=sim.playerDraws.get(id);if(!d||!d[key])return 0;const xs=Array.from(d[key] as ArrayLike<number>);return xs.reduce((a,b)=>a+b,0)/xs.length;};
  for(const team of [game.away_team_id,game.home_team_id]){
   const players=game.players.filter(p=>p.team_id===team);
   const top=[...players].sort((a,b)=>b.ast_per_min*mean(b.athlete_id,'min')-a.ast_per_min*mean(a.athlete_id,'min'))[0];
   for(const p of players){
    const minutes=mean(p.athlete_id,'min');
    if(!(minutes>0))continue;
    if(p===top){lead+=mean(p.athlete_id,'ast');leadCard+=p.ast_per_min*minutes;}else{rest+=mean(p.athlete_id,'ast');restCard+=p.ast_per_min*minutes;}
   }
   assists+=players.reduce((n,p)=>n+mean(p.athlete_id,'ast'),0);
   makes+=players.reduce((n,p)=>n+mean(p.athlete_id,'fgm'),0);
   rate+=(team===game.away_team_id?game.context!.away:game.context!.home).assist_rate;teams++;
  }
 }
 assert.ok(teams>=4,`only ${teams} playable teams`);
 assert.ok(lead/leadCard>0.92,`lead playmaker ${(lead/leadCard).toFixed(3)} of card rate`);
 assert.ok(Math.abs(lead/leadCard-rest/restCard)<0.06,`lead ${(lead/leadCard).toFixed(3)} vs others ${(rest/restCard).toFixed(3)}`);
 assert.ok(Math.abs(assists/makes/(rate/teams)-1)<0.02,`assists per make ${(assists/makes).toFixed(3)} vs team rate ${(rate/teams).toFixed(3)}`);
});
