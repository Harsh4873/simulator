import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionalParticipants } from '../src/availability.ts';
import { minuteLineups,tacticalState } from '../src/lineups.ts';
import { mulberry32 } from '../src/rng.ts';
import { restDays,fitTeamEffects } from '../src/team-effects.ts';
import { fitAvailability,supportedEffect,calibrationIssue } from '../src/model-evidence.ts';
import { fitPlayers } from '../src/fit.ts';
import { selectRolePrior } from '../src/role-model.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';

test('exact conditional availability handles five questionable players without rejection failures',()=>{
 for(let i=0;i<100;i++)assert.deepEqual(conditionalParticipants([.001,.001,.001,.001,.001,0],5,mulberry32(i)),[true,true,true,true,true,false]);
 assert.throws(()=>conditionalParticipants([1,1,1,1,0],5,mulberry32(1)),/Insufficient/);
});
test('five-player stints reproduce every minute target, including shortages at a position',()=>{
 for(const mins of [[48,48,48,48,48],[35,35,35,35,35,25,20,20],[5,5,5,5,5]]){
  const length=mins.reduce((a,b)=>a+b,0)/5,stints=minuteLineups(mins,length,mulberry32(32));
  assert.ok(stints.every(x=>x.length===5&&new Set(x).size===5));
  assert.deepEqual(mins,mins.map((_,i)=>stints.filter(x=>x.includes(i)).length));
 }
 assert.throws(()=>minuteLineups([48,48,48,48],48,mulberry32(1)));
});
test('missing contextual evidence stays unknown and future evidence cannot supply effects',()=>{
 assert.equal(supportedEffect(null,'travel','v','2026-10-30'),null);
 assert.equal(supportedEffect({feature:'travel',coefficient:.1,sample_count:200,validated:true,model_version:'v',training_cutoff:'2026-11-01'},'travel','v','2026-10-30'),null);
 assert.equal(fitAvailability([],'questionable','2026-10-30'),null);
 assert.equal(tacticalState({seconds_remaining:10,period:4,margin:-2,team_fouls:null},null).status,'unknown');
 assert.match(calibrationIssue(null,'v','pts','2026-10-30')!,/unavailable/);
});
test('availability calibration uses only settled as-of roster observations',()=>{
 const rows=Array.from({length:40},(_,i)=>({athlete_id:String(i),report_at:'2026-10-01T12:00:00Z',tip:'2026-10-01T23:00:00Z',settled_at:'2026-10-02T04:00:00Z',designation:'questionable',played:i<20,minutes:i<20?30:0,roster_known:true}));
 assert.equal(fitAvailability(rows,'questionable','2026-10-03')!.probability,.5);
 assert.equal(fitAvailability(rows,'questionable','2026-10-01'),null);
});
test('rest uses Chicago calendar days across DST rather than elapsed 24-hour periods',()=>{
 assert.equal(restDays('2026-10-31T23:00:00Z','2026-11-02T00:00:00Z'),0);
 assert.equal(restDays(null,'2026-11-02'),null);
});
test('sparse role training explicitly reports a prior',()=>{
 assert.equal(selectRolePrior([],2027).source,'labelled-prior');
 const e=fitTeamEffects([],()=>100);assert.equal(e.games,0);
});
test('count-to-shooting blend treats zeros as evidence and has no 3-game discontinuity',()=>{
 const fit=(games:number,points:number)=>fitPlayers({roster:[{athlete_id:'a',name:'A',position:'C',team_id:'t'}],injuries:[],shooting:[{athlete_id:'other',team_id:'t',season:2027,games:10,minutes:300,fgm:50,fga:100,tpm:10,tpa:30,ftm:30,fta:40,pts:140,reb:50,ast:10}],outcomes:Array.from({length:games},(_,i)=>({athlete_id:'a',team_id:'t',season:2027,event_id:String(i),stat_key:'points',minutes:30,actual:points}))}).players[0];
 const two=fit(2,0),three=fit(3,0);assert.ok(three.fga_per_min<two.fga_per_min);assert.ok(two.fga_per_min-three.fga_per_min<.1);
 assert.ok(fit(3,20).fga_per_min>three.fga_per_min);
});
// Compilation also checks the supported historical event contract.
const noEvents:CompletedEvent[]=[];assert.equal(noEvents.length,0);

test('reported restrictions cap the full game and explicit DNP coverage is retained',async()=>{
 const {readFileSync}=await import('node:fs');const {fitCurrentRoles}=await import('../src/team-model.ts');const {simulate}=await import('../src/simulate.ts');
 const card=JSON.parse(readFileSync('public/data/rate-card.json','utf8'));
 const game=card.games[0],p=game.players.find((p:{minutes_weight:number;minutes_mean:number})=>p.minutes_weight===1&&p.minutes_mean>25);p.minutes_restriction=18;p.play_probability=1;
 const result=simulate(game,8,100);assert.ok(Array.from(result.playerDraws.get(p.athlete_id)!.min).every(x=>x<=18));
 const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8'));
 const events:CompletedEvent[]=cache.events.filter((e:CompletedEvent)=>e.season===2027&&[e.home_team_id,e.away_team_id].includes(p.team_id)).slice(-4);
 events.forEach((e,i)=>{e.participation=[{athlete_id:p.athlete_id,team_id:p.team_id,played:i<2,starter:null}];});
 fitCurrentRoles([p],events,2027,[],'2026-10-30');
 assert.equal(p.participation_coverage.known,events.length);assert.equal(p.participation_coverage.source,'explicit-DNP');assert.ok(p.play_probability>0&&p.play_probability<1);
});
test('game-aware refresh and expiry cover early/evening tips, DST, and no-game days',async()=>{
 const {shouldRefresh,freshnessBudget}=await import('../src/refresh-window.ts');
 const slate={schema_version:1 as const,generated_at:'2026-11-01T12:00Z',date:'2026-11-01',timezone:'America/Chicago' as const,games:[] as import('../src/types.ts').SlateGame[]};
 assert.equal(shouldRefresh(slate,new Date('2026-11-01T15:00Z')),false);
 for(const tip of ['2026-11-01T18:00Z','2026-11-02T02:00Z']){
  slate.games=[{start_time:tip,status_state:'pre'} as import('../src/types.ts').SlateGame];
  const before=new Date(Date.parse(tip)-2*3600000);assert.equal(shouldRefresh(slate,before),true);assert.equal(freshnessBudget(slate,before),90*60000);
  assert.equal(shouldRefresh(slate,new Date(Date.parse(tip)-5*3600000)),false);
 }
});
