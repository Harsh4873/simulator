import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePlayHistory,freeThrowTrips,historicalStints} from '../src/play-history.ts';
import type {CompletedEvent} from '../src/parse-summary.ts';
const event=():CompletedEvent=>({event_id:'fixture',start_time:'2026-10-01T00:00Z',season:2027,season_type:2,neutral:false,periods:4,home_team_id:'h',away_team_id:'a',home_pts:2,away_pts:0,players:['h','a'].flatMap(team=>Array.from({length:6},(_,i)=>({athlete_id:team+i,team_id:team,starter:i<5,minutes:40,fgm:0,fga:0,tpm:0,tpa:0,ftm:team==='h'&&i===0?2:0,fta:team==='h'&&i===0?2:0,pts:team==='h'&&i===0?2:0,reb:0,ast:0})))});
const play=(id:number,type:string,period:number,time:string,home:number,athletes:string[]=[])=>({id:String(id),sequenceNumber:String(id),type:{text:type},period:{number:period},clock:{displayValue:time},homeScore:home,awayScore:0,team:{id:'h'},participants:athletes.map(id=>({athlete:{id}})),scoringPlay:type.startsWith('Free Throw'),pointsAttempted:type.startsWith('Free Throw')?1:0});
test('play ingestion keeps source-only venue and rejects incomplete final histories',()=>{
 const e=event();assert.equal(parsePlayHistory({},e).status,'missing');
 const p=parsePlayHistory({plays:[play(1,'End Game',4,'0:00',99)]},e);assert.equal(p.status,'partial');assert.equal(p.venue.latitude,null);
});
test('FT numbering and boxes must reconcile before trip estimates are usable',()=>{
 const e=event();e.play_history=parsePlayHistory({plays:[play(1,'Shooting Foul',1,'11:00',0),play(2,'Free Throw - 1 of 2',1,'11:00',1,['h0']),play(3,'Free Throw - 2 of 2',1,'11:00',2,['h0']),play(4,'End Game',4,'0:00',2)]},e);
 const result=freeThrowTrips(e);assert.equal(result.status,'complete');assert.deepEqual(result.trips.map(t=>[t.attempts,t.made,t.kind]),[[2,2,'shooting']]);
 e.play_history.plays.splice(2,1);assert.equal(freeThrowTrips(e).status,'unknown');
});
test('only uniquely observed five-player stints survive substitutions and period changes',()=>{
 const e=event();e.play_history=parsePlayHistory({plays:[play(1,'Substitution',1,'6:00',0,['h5','h4']),play(2,'End Period',1,'0:00',0),play(3,'End Game',4,'0:00',2)]},e);
 const result=historicalStints(e);assert.equal(result.covered_seconds,720);assert.equal(result.stints.length,2);assert.ok(result.stints.every(s=>s.away.length===5&&s.home.length===5));assert.ok(result.stints[1].home.includes('h5'));
 e.play_history.plays[0].athletes=['h5','unknown'];assert.equal(historicalStints(e).covered_seconds,0);
});
