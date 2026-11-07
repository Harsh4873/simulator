import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {quarterMargins,runningMargins,fitLeadEffect,leadTilt,MAX_LEAD_TILT,type LeadEffectModel} from '../src/lead-effect.ts';
import {fitTeamEffects,TEAM_HALF_LIFE_DAYS} from '../src/team-effects.ts';
import {eventPossessions} from '../src/team-model.ts';
import {simulate} from '../src/simulate.ts';
import {validateGame} from '../src/validate-card.ts';
import {mulberry32,normal} from '../src/rng.ts';
import type {CompletedEvent} from '../src/parse-summary.ts';
import type {RateCard} from '../src/types.ts';

const card=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8')) as RateCard;

function event(i:number,home:string,away:string,q:number[],season=2027):CompletedEvent{
 const final=q[3];
 const plays=q.map((m,period)=>({id:`${i}-${period}`,sequence:period+1,period:period+1,seconds:0,type:period===3?'End Game':'End Period',team:null,athletes:[],home:100+Math.max(0,m),away:100+Math.max(0,-m),attempt:0,made:false,trip_attempt:null,trip_size:null,wallclock:null}));
 const players=[home,away].flatMap(team=>Array.from({length:8},(_,j)=>({athlete_id:`${team}${j}`,team_id:team,starter:j<5,minutes:30,fgm:5,fga:10,tpm:1,tpa:3,ftm:2,fta:3,pts:13,reb:5,ast:3,orb:1,tov:1})));
 return {event_id:`g${i}`,start_time:new Date(Date.UTC(2026,9,21)+i*3600000*6).toISOString(),season,season_type:2,neutral:false,periods:4,home_team_id:home,away_team_id:away,home_pts:100+Math.max(0,final),away_pts:100+Math.max(0,-final),players,
  play_history:{version:1,status:'partial',reason:'Clock reversal',plays,venue:{id:null,latitude:null,longitude:null,timezone:null},final_observed_at:null}};
}

test('quarter margins come from the last play of each quarter and must reconcile with the box',()=>{
 const e=event(0,'H','A',[3,-2,6,9]);
 assert.deepEqual(quarterMargins(e),[3,-2,6,9]);
 const wrong=structuredClone(e);wrong.home_pts+=1;
 assert.equal(quarterMargins(wrong),null);
 const legacy=structuredClone(e);legacy.play_history=undefined;
 assert.equal(quarterMargins(legacy),null);
});

test('the running strength control never sees the game it describes',()=>{
 const games=Array.from({length:30},(_,i)=>event(i,i%2?'H':'A',i%2?'A':'H',[0,0,0,i%2?12:-12]));
 const before=runningMargins(games);
 const changed=games.map((g,i)=>i===29?{...g,home_pts:g.home_pts+40}:g);
 assert.equal(runningMargins(changed).get('g29'),before.get('g29'));
 assert.notEqual(runningMargins(changed).get('g29'),undefined);
});

test('a planted fourth-quarter give-back is recovered and gated; none is found when there is none',()=>{
 const rng=mulberry32(4);
 // Each game has its own expected margin; the fourth quarter pulls back a share of the departure from that path.
 const expected=(i:number)=>((i%9)-4)*3;
 const build=(giveBack:number)=>Array.from({length:600},(_,i)=>{
  let m=0;const q:number[]=[];const e=expected(i);
  for(let quarter=0;quarter<4;quarter++){m+=e/4+normal(rng)*8.7-(quarter===3?giveBack*(m-e*3/4):0);q.push(Math.round(m));}
  return event(i,'H','A',q);
 });
 const control=(e:CompletedEvent)=>expected(Number(e.event_id.slice(1)));
 const planted=fitLeadEffect(build(0.15),control,0.88,25);
 assert.equal(planted.status,'fitted');
 assert.ok(planted.coefficients.late<-0.1&&planted.coefficients.late>-0.2,`late ${planted.coefficients.late}`);
 assert.ok(planted.late>planted.early);
 assert.ok(planted.late>0&&planted.late<=MAX_LEAD_TILT);
 const none=fitLeadEffect(build(0),control,0.88,25);
 assert.ok(none.status==='unknown'||none.late<planted.late/3,`no give-back ${JSON.stringify(none)}`);
 assert.equal(fitLeadEffect(build(0.15).slice(0,100),control,0.88,25).status,'unknown');
});

test('the tilt favors the team that is behind its expected path, and is off when not fitted',()=>{
 const model:LeadEffectModel={status:'fitted',early:0.014,late:0.023,coefficients:{early:-0.07,late:-0.11},games:1000,heldout_games:300,mse:1,baseline_mse:2,reason:null};
 assert.ok(leadTilt(model,10,true)<0);
 assert.ok(leadTilt(model,-10,true)>0);
 assert.ok(Math.abs(leadTilt(model,10,true))>Math.abs(leadTilt(model,10,false)));
 assert.equal(leadTilt({...model,status:'unknown'},10,true),0);
 const g=structuredClone(card.games[0]);g.context={...g.context!,lead_effect:{...model,late:MAX_LEAD_TILT*2}};
 assert.throws(()=>validateGame(g),/Invalid lead effect/);
});

test('with give-back, simulated margins tighten while the average margin stays put',()=>{
 const model:LeadEffectModel={status:'fitted',early:0.014,late:0.023,coefficients:{early:-0.07,late:-0.11},games:1000,heldout_games:300,mse:1,baseline_mse:2,reason:null};
 const g=card.games[0];
 const off=simulate({...g,context:{...g.context!,lead_effect:{...model,status:'unknown'}}},9,1500);
 const on=simulate({...g,context:{...g.context!,lead_effect:model}},9,1500);
 const stats=(s:typeof off)=>{const m=s.homeTotals.map((h,i)=>h-s.awayTotals[i]);const mean=m.reduce((a,b)=>a+b,0)/m.length;return {mean,sd:Math.sqrt(m.reduce((a,b)=>a+(b-mean)**2,0)/m.length)};};
 const a=stats(off),b=stats(on);
 assert.ok(b.sd<a.sd-1.5,`sd ${a.sd} -> ${b.sd}`);
 assert.ok(Math.abs(b.mean-a.mean)<1.2,`mean ${a.mean} -> ${b.mean}`);
});

test('team ratings weight recent games more: a team that improved late rates higher with the 90-day half-life',()=>{
 assert.equal(TEAM_HALF_LIFE_DAYS,90);
 const games:CompletedEvent[]=[];
 const teams=['A','B','C','D'];
 for(let i=0;i<240;i++){
  const home=teams[i%4],away=teams[(i+1+Math.floor(i/4)%3)%4];
  const late=i>=160;
  const boost=(team:string)=>team==='A'?(late?12:-6):0;
  const e=event(i,home,away,[0,0,0,0]);
  e.start_time=new Date(Date.UTC(2026,0,1)+i*86400000).toISOString();
  e.home_pts=110+boost(home);e.away_pts=108+boost(away);
  e.players=e.players.map(p=>({...p,pts:p.team_id===home?e.home_pts/8:e.away_pts/8}));
  games.push(e);
 }
 const decayed=fitTeamEffects(games,eventPossessions);
 const flat=fitTeamEffects(games,eventPossessions,{halfLives:[null]});
 assert.equal(decayed.half_life_days,90);assert.equal(flat.half_life_days,null);
 assert.ok(decayed.offense.A>flat.offense.A,`${decayed.offense.A} vs ${flat.offense.A}`);
});
