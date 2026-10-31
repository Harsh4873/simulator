import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {covariance,fitResidualDiagnostics} from '../src/residual-model.ts';
import {fitRotationState,fitFouls,personalFoul,rotationStateKey} from '../src/game-state-model.ts';
import {fitFreeThrows,lateFoulState} from '../src/free-throw-model.ts';
import {fitLineupEffects} from '../src/lineup-effects.ts';
import {drawPossessions} from '../src/possessions.ts';
import {drawGame,type DrawnPlayer} from '../src/simulate.ts';
import {mulberry32} from '../src/rng.ts';
import type {RateCard,RatePlayer} from '../src/types.ts';
const card=JSON.parse(readFileSync('public/data/rate-card.json','utf8')) as RateCard;
test('unsupported state and residual fits remain explicitly unknown',()=>{
 assert.equal(fitFouls([]).status,'unknown');assert.equal(fitRotationState([]).status,'unknown');assert.equal(fitResidualDiagnostics([],()=>100).status,'unknown');assert.equal(fitLineupEffects([]).status,'unknown');assert.equal(fitFreeThrows([]).status,'unknown');
 assert.equal(personalFoul('Offensive Foul Turnover'),false);assert.equal(personalFoul('Technical Foul'),false);assert.equal(personalFoul('Shooting Foul'),true);
 assert.equal(lateFoulState(4,120,3),true);assert.equal(lateFoulState(4,120,-3),false);assert.equal(lateFoulState(3,120,3),false);
 assert.equal(rotationStateKey(46,20),'late:large');
});
test('score covariance distinguishes shared variation from margin variation',()=>{
 const c=covariance([[1,2],[2,4],[3,6]])!;assert.deepEqual(c,[[1,2],[2,4]]);assert.equal(covariance([[1,2]]),null);
 assert.ok(c[0][0]*c[1][1]-c[0][1]**2>=0);
});
function fixture(){
 const base=card.games[0],p=base.players.find(p=>p.minutes_weight===1&&p.minutes_mean>20)!;
 const roster:RatePlayer[]=['a','h'].flatMap(team=>Array.from({length:6},(_,i)=>({...p,athlete_id:team+i,team_id:team,minutes_restriction:null,games:50,games_2026:40,games_2027:10,shooting_games:50,starter_rate:i<5?1:0,closing_rate:0})));
 const lines=(team:string):DrawnPlayer[]=>roster.filter(p=>p.team_id===team).map(p=>({...p,min:40,fgm:0,fga:0,tpm:0,tpa:0,ftm:0,fta:0,pts:0,reb:0,ast:0,stl:0,blk:0,tov:0,orb:0,drb:0}));
 return {roster,away:lines('a'),home:lines('h'),context:structuredClone(base.context!)};
}
test('sixth personal foul removes a player from subsequent stints while preserving 240 minutes',()=>{
 const f=fixture();f.context.lineup_effects=undefined;f.context.rotation_state=undefined;
 f.context.fouls={status:'fitted',games:200,heldout_minutes:1000,probabilities:[1,0],by_count:{5:[0,1]},conditional:true,log_loss:0,baseline_log_loss:1,reason:null};
 f.away[0].fouls=5;const a=f.away.map(p=>p.min),h=f.home.map(p=>p.min);
 drawPossessions(f.away,f.home,f.roster,a,h,f.context,100,mulberry32(23));
 assert.equal(f.away[0].fouls,6);assert.ok(f.away[0].min<=f.away[0].foul_out_minute!);assert.ok(f.away[0].min<40);
 for(const [team,mins] of [[f.away,a],[f.home,h]] as const){assert.equal(team.reduce((s,p)=>s+p.min,0),240);assert.equal(mins.reduce((a,b)=>a+b,0),240);assert.ok(team.every(p=>p.min<=48));}
});
test('score-conditioned bench substitutions obey restrictions and retained trips preserve possession identity',()=>{
 const f=fixture();f.context.lineup_effects=undefined;f.context.fouls=undefined;
 f.context.rotation_state={status:'fitted',games:200,heldout_games:40,shares:{'early:large':.1,'late:large':.1},baseline:{early:.8,late:.8},log_loss:.1,baseline_log_loss:.2,reason:null};
 f.context.free_throws={status:'fitted',games:200,heldout_games:40,trip_weights:[1,0],trip_types:[{kind:'bonus',attempts:2,weight:1}],and_one_per_make:0,technical_per_possession:0,retained_per_possession:.2,retained_trip_weights:[1,0,0],holdout_trip_log_loss:0,reason:null};
 f.away[0].pts=100;const a=f.away.map(p=>p.min),h=f.home.map(p=>p.min);
 drawPossessions(f.away,f.home,f.roster,a,h,f.context,100,mulberry32(1));
 assert.ok(f.away[5].min>40);assert.ok(f.away.some(p=>(p.ft_retained??0)>0));
 for(const team of [f.away,f.home])assert.equal(team.reduce((s,p)=>s+p.fga+(p.ft_possession_trips??0)+(p.tov??0)-(p.orb??0),0),100);
});
test('fitted game-state paths retain overtime and participation invariants across draws',()=>{
 const game=structuredClone(card.games[0]);game.context!.rotation_state={status:'fitted',games:200,heldout_games:40,shares:{'early:close':.7,'late:large':.2,'late:close':.8},baseline:{early:.65,late:.6},log_loss:.1,baseline_log_loss:.2,reason:null};
 game.context!.fouls={status:'fitted',games:200,heldout_minutes:1000,probabilities:[.92,.08],by_count:{},conditional:false,log_loss:.1,baseline_log_loss:.2,reason:null};
 for(let i=0;i<200;i++){const d=drawGame(game,mulberry32(i));for(const team of [d.away,d.home]){assert.equal(team.reduce((s,p)=>s+p.min,0),d.budget);assert.ok(team.every(p=>(p.fouls??0)<=6));}for(const m of d.periodMinutes!)for(const xs of [m.away,m.home])assert.ok(xs.every(n=>Number.isInteger(n)&&n>=0));}
});

test('malformed fitted state probabilities fail the data contract',async()=>{
 const {validateGame}=await import('../src/validate-card.ts');const game=structuredClone(card.games[0]);
 game.context!.fouls={status:'fitted',games:200,heldout_minutes:1000,probabilities:[.5,.7],by_count:{},conditional:false,log_loss:.1,baseline_log_loss:.2,reason:null};
 assert.throws(()=>validateGame(game),/probability distribution/);
 game.context!.fouls=undefined;game.context!.rotation_state={status:'fitted',games:200,heldout_games:40,shares:{'late:large':NaN},baseline:{early:.5},log_loss:.1,baseline_log_loss:.2,reason:null};
 assert.throws(()=>validateGame(game),/rotation probability/);
});
test('overtime can substitute a regulation participant assigned zero initial overtime minutes',()=>{
 const f=fixture();f.context.rotation_state=undefined;f.context.lineup_effects=undefined;
 f.context.fouls={status:'fitted',games:200,heldout_minutes:1000,probabilities:[1,0],by_count:{5:[0,1]},conditional:true,log_loss:0,baseline_log_loss:1,reason:null};
 const a=[5,5,5,5,5,0],h=[5,5,5,5,5,0];f.away.forEach((p,i)=>p.min=40+a[i]);f.home.forEach((p,i)=>p.min=40+h[i]);f.away[0].fouls=5;
 drawPossessions(f.away,f.home,f.roster,a,h,f.context,10,mulberry32(9));
 assert.equal(f.away[0].fouls,6);assert.ok(a[5]>0);assert.equal(a.reduce((x,y)=>x+y,0),25);assert.equal(f.away.reduce((s,p)=>s+p.min,0),265);
});
test('a healthy reserve can replace a foul-out without reviving an unavailable player',()=>{
 const f=fixture();f.context.rotation_state=undefined;f.context.lineup_effects=undefined;
 f.context.fouls={status:'fitted',games:200,heldout_minutes:1000,probabilities:[1,0],by_count:{5:[0,1]},conditional:true,log_loss:0,baseline_log_loss:1,reason:null};
 const a=[48,48,48,48,48,0],h=[40,40,40,40,40,40];f.away.forEach((p,i)=>p.min=a[i]);f.away[0].fouls=5;f.away[5].injury_status='healthy';
 drawPossessions(f.away,f.home,f.roster,a,h,f.context,100,mulberry32(42));
 assert.equal(f.away[0].fouls,6);assert.ok(a[5]>0);assert.equal(a.reduce((x,y)=>x+y,0),240);
 const blocked=fixture();blocked.context=f.context;blocked.away.forEach((p,i)=>p.min=i<5?48:0);blocked.away[0].fouls=5;blocked.away[5].injury_status='out';blocked.away[5].minutes_weight=0;
 assert.throws(()=>drawPossessions(blocked.away,blocked.home,blocked.roster,[48,48,48,48,48,0],h,blocked.context,100,mulberry32(42)),/fewer than five/);
});
test('fouls that cause substitutions retain their event and fractional exposure',async()=>{
 const {foulExposureRows}=await import('../src/game-state-model.ts');
 const e={event_id:'fixture',start_time:'2026-01-01',season:2026,season_type:2,neutral:false,periods:4,home_team_id:'h',away_team_id:'a',home_pts:0,away_pts:0,players:['h','a'].flatMap(team=>Array.from({length:6},(_,i)=>({athlete_id:team+i,team_id:team,starter:i<5,minutes:40,fgm:0,fga:0,tpm:0,tpa:0,ftm:0,fta:0,pts:0,reb:0,ast:0}))),play_history:{version:1 as const,status:'partial' as const,reason:null,final_reconciled:true,final_observed_at:null,venue:{id:null,latitude:null,longitude:null,timezone:null},plays:[] as import('../src/play-history.ts').HistoricalPlay[]}};
 const play=(sequence:number,seconds:number,type:string,athletes:string[])=>({id:String(sequence),sequence,period:1,seconds,type,team:'h',athletes,home:0,away:0,attempt:0,made:false,trip_attempt:null,trip_size:null,wallclock:null});
 e.play_history.plays=Array.from({length:6},(_,i)=>play(i+1,710-i*15,'Personal Foul',['h0']));
 e.play_history.plays.push(play(7,635,'Substitution',['h5','h0']),play(8,0,'End Period',[]));
 const rows=foulExposureRows(e);assert.equal(rows.reduce((s,r)=>s+r.count,0),6);assert.equal(rows.filter(r=>r.before===5).reduce((s,r)=>s+r.count,0),1);assert.ok(rows.some(r=>r.minutes>0&&r.minutes<1));
});
