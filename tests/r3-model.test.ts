import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fitCurrentRoles} from '../src/team-model.ts';
import {fitParticipation} from '../src/participation-model.ts';
import {fitShootingPriors} from '../src/shooting-priors.ts';
import {fitFreeThrows} from '../src/free-throw-model.ts';
import {fitLineupEffects,lineupLogEffect} from '../src/lineup-effects.ts';
import {selectRolePrior} from '../src/role-model.ts';
import {minuteLineups} from '../src/lineups.ts';
import {mulberry32} from '../src/rng.ts';
import {attachPlayCache,savePlayCache} from '../scripts/play-cache.ts';
import type {CompletedEvent} from '../src/parse-summary.ts';
import type {RatePlayer,ShootingCache} from '../src/types.ts';
const base:RatePlayer=JSON.parse(readFileSync('public/data/rate-card.json','utf8')).games[0].players.find((p:RatePlayer)=>p.injury_status==='healthy'&&p.minutes_mean>25);
function fixture(i:number,season=2026):CompletedEvent{
 return {event_id:String(i),start_time:new Date(Date.UTC(season-1,9,1+i)).toISOString(),season,season_type:2,neutral:false,periods:4,home_team_id:'h',away_team_id:'a',home_pts:100,away_pts:100,players:['h','a'].flatMap(team=>Array.from({length:8},(_,j)=>({athlete_id:team+j,team_id:team,starter:j<5,minutes:j<5?36:20,fgm:4,fga:8,tpm:0,tpa:j===0?0:2,ftm:2,fta:3,pts:10,reb:4,ast:2,orb:1,tov:1})))};
}
test('role selection reserves a chronological validation block and ignores target-season outcomes',()=>{
 const history=Array.from({length:100},(_,i)=>fixture(i)),fit=selectRolePrior(history,2027);
 assert.equal(fit.source,'chronological-validation');assert.ok(fit.heldout_samples>0);assert.ok(fit.mae!<=fit.prior_mae!);assert.ok(Object.values(fit.residual_sd).every(Number.isFinite));
 assert.deepEqual(selectRolePrior([...history,fixture(101,2027)],2027),fit);
});
test('missing legacy boxes cannot become DNPs and a trade opponent cannot supply current-team minutes',()=>{
 const p={...base,athlete_id:'h0',team_id:'h',minutes_weight:1 as const,questionable_widen:false,injury_status:'healthy',minutes_mean:30};
 const a=fixture(0,2027),b=fixture(1,2027);b.players=b.players.filter(p=>p.athlete_id!=='h0');b.players.push({...a.players[0],team_id:'a',minutes:1});
 fitCurrentRoles([p],[a,b],2027,[],'2026-10-10');assert.equal(p.current_team_games,1);assert.equal(p.participation_coverage!.unknown,1);assert.ok(p.minutes_mean>30);assert.equal(p.role_context!.team_changed,true);
 const first=p.play_probability;fitCurrentRoles([p],[a],2027,[],'2026-10-10');assert.equal(p.play_probability,first);
});
test('participation fitting requires explicit records and independent event blocks',()=>{
 const history=Array.from({length:100},(_,i)=>fixture(i));assert.equal(fitParticipation(history).coefficients,null);
 for(const e of history)e.participation=e.players.map((p,i)=>({athlete_id:p.athlete_id,team_id:p.team_id,starter:p.starter!,played:i%8<5||Number(e.event_id)%2===0}));
 const fit=fitParticipation(history);assert.ok(fit.samples>200);assert.ok(fit.brier!==null&&fit.baseline_brier!==null);assert.ok(fit.coefficients===null||fit.brier!<=fit.baseline_brier!);
});
test('shot priors recognize observed interior roles and exclude the athlete from its prior',()=>{
 const fit=fitShootingPriors(Array.from({length:100},(_,i)=>fixture(i)),2027);
 assert.equal(fit.source,'chronological-selection');assert.equal(fit.roles.h0,'interior');assert.equal(fit.player_rates.h0.share!<.03,true);
 assert.ok(Object.values(fit.strengths).every(x=>x>0));assert.equal(fitShootingPriors([],2027).source,'labelled-prior');
});
test('FT and lineup fitting never substitutes invented observations for missing histories',()=>{
 const history=Array.from({length:200},(_,i)=>fixture(i));assert.equal(fitFreeThrows(history).status,'unknown');assert.equal(fitLineupEffects(history).status,'unknown');assert.equal(lineupLogEffect(undefined,'h',['h0'],'offense'),0);
 const model={...fitLineupEffects([]),status:'fitted' as const,defense:{h0:-.02},defense_center:{h:0}};
 assert.ok(lineupLogEffect(model,'h',['h0'],'defense')<lineupLogEffect(model,'h',['h1'],'defense'));
});
test('actual starter and closing roles preserve feasible five-player minute budgets',()=>{
 const minutes=[35,35,35,35,35,25,20,20],roles={opening:[1,1,1,1,1,0,0,0],closing:[1,1,1,1,0,1,0,0]};
 for(let seed=0;seed<30;seed++){const stints=minuteLineups(minutes,48,mulberry32(seed),roles);assert.deepEqual(new Set(stints[0]),new Set([0,1,2,3,4]));assert.deepEqual(new Set(stints.at(-1)),new Set([0,1,2,3,5]));assert.deepEqual(minutes,minutes.map((_,i)=>stints.filter(s=>s.includes(i)).length));}
});
test('compressed history cache is deterministic, off-site, and rejects a mismatched box',()=>{
 const dir=mkdtempSync(join(tmpdir(),'r3-plays-'));try{
 const e=fixture(0);e.play_history={version:1,status:'missing',reason:'Fixture without plays',plays:[],venue:{id:null,latitude:null,longitude:null,timezone:null},final_observed_at:null};
 const cache:ShootingCache={schema_version:1,rows:[],fetched_event_ids:[],events:[e]},path=join(dir,'shooting-cache.json');
 const saved=savePlayCache(cache,path),bytes=readFileSync(join(dir,'play-history.json.gz'));assert.equal(saved.events![0].play_history,undefined);savePlayCache(cache,path);assert.ok(bytes.equals(readFileSync(join(dir,'play-history.json.gz'))));
 attachPlayCache(saved,path);assert.deepEqual(saved.events![0].play_history,e.play_history);delete saved.events![0].play_history;saved.events![0].home_pts++;attachPlayCache(saved,path);assert.equal(saved.events![0].play_history,undefined);
 writeFileSync(join(dir,'play-history.json.gz'),'invalid');assert.throws(()=>attachPlayCache(saved,path));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a stalled queued refresh cannot suppress recovery indefinitely',async()=>{
 const {monitor}=await import('../scripts/check-freshness.mjs');const calls:string[]=[];const now=Date.parse('2026-10-30T18:00Z');
 const result=await monitor(async(path:string)=>{calls.push(path);return {workflow_runs:[{status:'queued',created_at:'2026-10-30T12:00Z'}]};},now);
 assert.equal(result.recovery,true);assert.equal(calls.length,2);assert.equal(result.last_publication_completed,null);assert.equal(result.expected_next_completion,null);
});
test('source-only travel and timezone derivation keeps missing venue data unknown',async()=>{
 const {scheduleContext,sourceVenue}=await import('../src/schedule-context.ts');
 const e=fixture(0);assert.equal(scheduleContext(e,'2025-10-03').travel_km,null);assert.equal(sourceVenue({id:'venue'}).timezone,null);
 e.periods=5;e.play_history={version:1,status:'missing',reason:'fixture',plays:[],final_observed_at:null,venue:{id:'x',latitude:0,longitude:0,timezone:'America/New_York'}};
 const result=scheduleContext(e,'2025-10-03T00:00Z',{id:'y',latitude:0,longitude:1,timezone:'America/Chicago'});
 assert.equal(result.previous_minutes,53);assert.ok(result.travel_km!>111&&result.travel_km!<112);assert.equal(result.timezone_change_hours,-1);
});
test('conditional player-market scoring excludes DNPs, pushes and future settlements',async()=>{
 const {scorePlayerMarket}=await import('../src/player-market-evaluation.ts');
 const row={event_id:'e',athlete_id:'p',stat:'pts' as const,line:10,captured_at:'2026-10-01T12:00Z',tip:'2026-10-01T23:00Z',settled_at:'2026-10-02T03:00Z',actual:12,played:true,source:'ESPN scoreboard' as const},draws={min:[0,30,30,30],value:[0,8,10,12]};
 assert.equal(scorePlayerMarket(row,draws,'2026-10-03')!.p,.5);assert.equal(scorePlayerMarket({...row,played:false},draws,'2026-10-03'),null);assert.equal(scorePlayerMarket({...row,actual:10},draws,'2026-10-03'),null);assert.equal(scorePlayerMarket(row,draws,'2026-10-01'),null);
});
test('off-court usage adjustments preserve zero weights and cannot activate without evidence',async()=>{
 const {fitUsageEffects,usageWeights}=await import('../src/usage-effects.ts');const empty=fitUsageEffects([]);assert.equal(empty.status,'unknown');assert.deepEqual(usageWeights(empty,'h',['h1','h2'],[2,1]),[2,1]);
 const model={...empty,status:'fitted' as const,primary:{h:'h0'},roles:{'h:h1':'secondary' as const,'h:h2':'support' as const},multipliers:{secondary:1.2,support:.8}};
 assert.deepEqual(usageWeights(model,'h',['h1','h2'],[2,0]),[2.4,0]);assert.deepEqual(usageWeights(model,'h',['h0','h1'],[2,1]),[2,1]);
});
