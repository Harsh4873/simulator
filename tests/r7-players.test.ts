import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fitReboundCredit,MIN_DEFENSIVE_CREDIT} from '../src/rebound-credit.ts';
import {concentrate,fitUsageConcentration,USAGE_EXPONENT_RANGE} from '../src/usage-concentration.ts';
import {fitPlayers,K_RATE_MINUTES,PLAYER_RATE_PRIOR_SEASON_WEIGHT,type RosterPlayer} from '../src/fit.ts';
import {eligibleEvents} from '../src/team-model.ts';
import {simulate} from '../src/simulate.ts';
import {validateGame} from '../src/validate-card.ts';
import {attachPlayCache} from '../scripts/play-cache.ts';
import type {CompletedEvent} from '../src/parse-summary.ts';
import type {OutcomeRow,RateCard,ShootingCache,ShootingRow} from '../src/types.ts';

const card=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8')) as RateCard;

function reboundGame(i:number,credited:number):CompletedEvent{
 const players=(['H','A'] as const).flatMap(team=>Array.from({length:5},(_,j)=>({athlete_id:`${team}${j}`,team_id:team,starter:true,minutes:48,fgm:8,fga:18,tpm:2,tpa:6,ftm:2,fta:2,pts:20,reb:0,ast:4,orb:j===0?2:0,drb:j===0?credited:0,tov:1})));
 players.forEach(p=>{p.reb=p.orb+p.drb;});
 return {event_id:`r${i}`,start_time:new Date(Date.UTC(2026,9,21)+i*86400000).toISOString(),season:2027,season_type:2,neutral:false,periods:4,home_team_id:'H',away_team_id:'A',home_pts:100,away_pts:100,players,
  play_history:{version:1,status:'partial',reason:null,plays:[{id:'x',sequence:1,period:4,seconds:0,type:'End Game',team:null,athletes:[],home:100,away:100,attempt:0,made:false,trip_attempt:null,trip_size:null,wallclock:null}],venue:{id:null,latitude:null,longitude:null,timezone:null},final_observed_at:null}};
}

test('defensive rebound credit is the credited share of non-offensive-rebound misses',()=>{
 // Each side misses 50 field goals with 2 offensive rebounds credited; defenders are credited 40 of the other 48.
 const fit=fitReboundCredit(Array.from({length:220},(_,i)=>reboundGame(i,40)));
 assert.equal(fit.status,'fitted');
 assert.ok(Math.abs(fit.defensive-40/48)<1e-9,String(fit.defensive));
 assert.equal(fitReboundCredit(Array.from({length:50},(_,i)=>reboundGame(i,40))).status,'unknown');
 assert.equal(fitReboundCredit(Array.from({length:220},(_,i)=>reboundGame(i,5))).defensive,MIN_DEFENSIVE_CREDIT);
});

test('crediting fewer defensive rebounds lowers player rebounds, not offensive boards',()=>{
 const g=card.games[0];
 const base=simulate(g,3,600),fewer=simulate({...g,context:{...g.context!,rebound_credit:{status:'fitted',defensive:0.85,games:1000,reason:null}}},3,600);
 const total=(s:typeof base,key:'reb'|'orb')=>[...s.away.players,...s.home.players].reduce((n,p)=>n+(key==='reb'?(p.expectation?.rebMean??0):0),0);
 assert.ok(total(fewer,'reb')<total(base,'reb')*0.95,`${total(fewer,'reb')} vs ${total(base,'reb')}`);
 const g2=structuredClone(g);g2.context={...g2.context!,rebound_credit:{status:'fitted',defensive:0.2,games:1,reason:null}};
 assert.throws(()=>validateGame(g2),/Invalid rebound credit/);
});

test('real lineup stints concentrate shots and assists toward high-usage players',()=>{
 assert.equal(concentrate(0.5,1),0.5);assert.equal(concentrate(0,1.2),0);
 assert.ok(concentrate(0.6,1.15)/concentrate(0.3,1.15)>0.6/0.3);
 const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
 attachPlayCache(cache,'data/shooting-cache.json');
 const fit=fitUsageConcentration(eligibleEvents(cache.events!,'2026-11-06T18:00:00Z'));
 assert.equal(fit.status,'fitted');
 assert.ok(fit.shots>1&&fit.shots<=USAGE_EXPONENT_RANGE[1],`shots ${fit.shots}`);
 assert.ok(fit.log_loss.shots!<fit.baseline_log_loss.shots!);
 assert.ok((fit.assists??1)>=1);
});

test('a concentrated split gives the high-usage player more shots while team attempts hold',()=>{
 const g=card.games[0];
 const top=[...g.players].filter(p=>p.team_id===g.away_team_id&&p.minutes_weight===1).sort((a,b)=>b.fga_per_min-a.fga_per_min)[0];
 const proportional=simulate(g,5,800);
 const concentrated=simulate({...g,context:{...g.context!,usage_concentration:{status:'fitted',shots:1.3,trips:1.3,assists:1,rebounds:1,stints:5000,heldout_events:1000,log_loss:{shots:1,trips:1},baseline_log_loss:{shots:2,trips:2},reason:null}}},5,800);
 const fga=(s:typeof proportional,id:string)=>{const d=s.playerDraws.get(id)!;return Array.from(d.fga!).reduce((a,b)=>a+b,0)/d.fga!.length;};
 const teamFga=(s:typeof proportional)=>g.players.filter(p=>p.team_id===g.away_team_id).reduce((n,p)=>n+fga(s,p.athlete_id),0);
 assert.ok(fga(concentrated,top.athlete_id)>fga(proportional,top.athlete_id)*1.03,`${fga(concentrated,top.athlete_id)} vs ${fga(proportional,top.athlete_id)}`);
 assert.ok(Math.abs(teamFga(concentrated)/teamFga(proportional)-1)<0.03);
 const bad=structuredClone(g);bad.context={...bad.context!,usage_concentration:{status:'fitted',shots:5,trips:1,stints:1,heldout_events:1,log_loss:{shots:1,trips:1},baseline_log_loss:{shots:1,trips:1},reason:null}};
 assert.throws(()=>validateGame(bad),/Invalid usage concentration/);
});

test('per-minute volume shrinks lightly, so a high-volume scorer keeps most of his rate',()=>{
 assert.equal(K_RATE_MINUTES,75);assert.equal(PLAYER_RATE_PRIOR_SEASON_WEIGHT,0.5);
 const roster:RosterPlayer[]=[{athlete_id:'star',name:'Star',team_id:'T',position:'G'},...Array.from({length:7},(_,i)=>({athlete_id:`r${i}`,name:`Role ${i}`,team_id:'T',position:'F'}))];
 const shooting:ShootingRow[]=roster.map(p=>({season:2027,team_id:'T',athlete_id:p.athlete_id,games:20,minutes:600,fgm:p.athlete_id==='star'?190:80,fga:p.athlete_id==='star'?400:180,tpm:40,tpa:110,ftm:p.athlete_id==='star'?150:30,fta:p.athlete_id==='star'?180:40,pts:0,reb:80,ast:60}));
 const outcomes:OutcomeRow[]=roster.flatMap(p=>Array.from({length:20},(_,i)=>({season:2027,athlete_id:p.athlete_id,team_id:'T',event_id:`e${i}`,stat_key:'points',actual:p.athlete_id==='star'?30:11,minutes:30})));
 const star=fitPlayers({roster,injuries:[],outcomes,shooting,activeSeason:2027}).players.find(p=>p.athlete_id==='star')!;
 const raw=400/600;
 assert.ok(star.fga_per_min>raw*0.88,`fga/min ${star.fga_per_min} vs raw ${raw}`);
 assert.ok(star.fta_per_min>(180/600)*0.85,`fta/min ${star.fta_per_min}`);
});
