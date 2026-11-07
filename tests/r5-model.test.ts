import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ParticipationTracker,participationRows,participationFeatures,participationProbability,fitParticipation,calibrateHealthy,applyHealthyCalibration,MIN_CALIBRATION_ROWS} from '../src/participation-model.ts';
import {fitCurrentRoles,eligibleEvents,eventPossessions,newcomerMinutes,NEWCOMER_MINUTES_PRIOR} from '../src/team-model.ts';
import {fitTeamEffects} from '../src/team-effects.ts';
import {personnelFactor} from '../src/personnel.ts';
import {sameInstant,archivedForecast} from '../src/forecast-archive.ts';
import {attachPlayCache} from '../scripts/play-cache.ts';
import type {CompletedEvent} from '../src/parse-summary.ts';
import type {RatePlayer,ShootingCache,TeamProfile} from '../src/types.ts';

type Box={id:string;team:string;minutes:number;starter?:boolean};
function game(i:number,boxes:Box[],dnp:{id:string;team:string}[]=[],explicit=true,season=2027):CompletedEvent{
 const players=boxes.map(b=>({athlete_id:b.id,team_id:b.team,starter:b.starter??false,minutes:b.minutes,fgm:3,fga:7,tpm:1,tpa:3,ftm:1,fta:2,pts:8,reb:3,ast:2,orb:1,tov:1}));
 return {event_id:`e${i}`,start_time:new Date(Date.UTC(2026,9,21+i,23)).toISOString(),season,season_type:2,neutral:false,periods:4,home_team_id:'T',away_team_id:'U',home_pts:100,away_pts:98,players,
  participation:explicit?[...boxes.map(b=>({athlete_id:b.id,team_id:b.team,played:true,starter:b.starter??false})),...dnp.map(d=>({athlete_id:d.id,team_id:d.team,played:false,starter:false}))]:undefined};
}
const regulars=(team:string)=>Array.from({length:8},(_,j)=>({id:`${team}${j}`,team,minutes:j<5?32:16,starter:j<5}));

test('the tracker counts explicit-box absences, follows trades, and ignores legacy boxes',()=>{
 const t=new ParticipationTracker();
 t.observe(game(0,[...regulars('T'),{id:'hurt',team:'T',minutes:30,starter:true},...regulars('U'),{id:'mover',team:'U',minutes:20}],[{id:'deep',team:'T'}]));
 for(let i=1;i<4;i++)t.observe(game(i,[...regulars('T'),...regulars('U'),{id:'mover',team:'U',minutes:18}],[{id:'deep',team:'T'}]));
 t.observe(game(4,[...regulars('T'),...regulars('U')],[],false));
 t.observe(game(5,[...regulars('T'),{id:'mover',team:'T',minutes:10},...regulars('U')],[{id:'deep',team:'T'}]));
 const hurt=t.history('T','hurt',2027)!;
 assert.deepEqual(hurt.map(s=>s.played?'P':s.absent?'A':'D').join(''),'PAAAA','four explicit absences; the legacy box adds nothing');
 assert.deepEqual(t.history('T','deep',2027)!.map(s=>s.played?'P':s.absent?'A':'D').join(''),'DDDDD');
 assert.equal(t.history('T','mover',2027)!.length,1,'a traded player starts a new stint');
 // A rostered player never listed is absent for every explicit team box this season.
 assert.equal(t.history('T','never',2027)!.every(s=>s.absent),true);
 assert.equal(t.history('T','never',2027)!.length,5);
 assert.equal(t.history('X','never',2027),null);
 // A player last listed elsewhere keeps that stint and is absent for this team's later boxes.
 const fresh=new ParticipationTracker();
 fresh.observe(game(0,[...regulars('T'),...regulars('U')]));
 fresh.observe(game(1,[...regulars('T'),...regulars('U')]));
 assert.equal(fresh.history('U','T0',2027)!.map(s=>s.played?'P':'A').join(''),'PP');
});

test('rows exclude the first missed game after playing, but keep DNPs and continuing absences',()=>{
 const events=[game(0,[...regulars('T'),{id:'hurt',team:'T',minutes:30,starter:true},...regulars('U')],[{id:'deep',team:'T'}]),...[1,2,3].map(i=>game(i,[...regulars('T'),...regulars('U')],[{id:'deep',team:'T'}]))];
 const rows=participationRows(events);
 // 16 regulars + deep each game after the first; hurt contributes only the two continuing absences.
 assert.equal(rows.length,3*17+2);
 assert.equal(rows.filter(r=>r.y===0).length,3+2);
});

test('the fitted model ranks a healthy regular far above a long-absent or never-used player',()=>{
 const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
 const events=eligibleEvents(cache.events!,'2026-11-06T18:00:00Z');
 const fit=fitParticipation(events);
 assert.ok(fit.coefficients,'participation fit accepted');
 assert.ok(fit.log_loss!<fit.baseline_log_loss!&&fit.brier!<fit.baseline_brier!);
 const regular=participationProbability(fit,participationFeatures(Array.from({length:6},()=>({played:true,minutes:33,starter:true,absent:false}))))!;
 const absent=participationProbability(fit,participationFeatures(Array.from({length:6},()=>({played:false,minutes:0,starter:null,absent:true}))))!;
 const benchDnp=participationProbability(fit,participationFeatures([true,false,false,true,false].map(p=>({played:p,minutes:p?6:0,starter:false,absent:false}))))!;
 assert.ok(regular>0.93,`regular ${regular}`);
 assert.ok(absent<0.2,`absent ${absent}`);
 assert.ok(benchDnp>absent&&benchDnp<regular,`bench ${benchDnp}`);
});

test('healthy calibration needs enough archived rows and must beat later games before it applies',()=>{
 assert.equal(calibrateHealthy([]).status,'unknown');
 let seed=7;const rand=()=>((seed=Math.imul(seed^(seed>>>15),0x2c1b3c6d)>>>0)/4294967296);
 const rows=Array.from({length:MIN_CALIBRATION_ROWS*3},(_,i)=>{
  const p=0.2+0.75*rand(),truth=1/(1+Math.exp(-(1.2+1.4*Math.log(p/(1-p)))));
  return {tip:new Date(Date.UTC(2026,10,1)+Math.floor(i/30)*86400000).toISOString(),p,y:Number(rand()<truth)};
 });
 const fit=calibrateHealthy(rows);
 assert.equal(fit.status,'fitted');assert.ok(fit.log_loss!<fit.baseline_log_loss!);
 assert.ok(applyHealthyCalibration(fit,0.9)>0.95);
 assert.equal(applyHealthyCalibration({...fit,status:'unknown'},0.9),0.9);
 assert.equal(calibrateHealthy(rows.slice(0,MIN_CALIBRATION_ROWS-1)).status,'unknown');
});

test('a player who has not played for his team gets a low play probability and no phantom role minutes',()=>{
 const base:RatePlayer=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8')).games[0].players.find((p:RatePlayer)=>p.injury_status==='healthy'&&p.minutes_mean>25);
 // Regulars also played last season, so newcomer minutes fall back to the labelled prior.
 const history=[...Array.from({length:6},(_,i)=>game(i-30,[...regulars('T'),...regulars('U')],[],true,2026)),...Array.from({length:12},(_,i)=>game(i,[...regulars('T'),...regulars('U')],[{id:'deep',team:'T'}]))];
 const starter={...base,athlete_id:'T0',team_id:'T',injury_status:'healthy',minutes_weight:1 as const,questionable_widen:false};
 const ghost={...base,athlete_id:'ghost',team_id:'T',injury_status:'healthy',minutes_weight:1 as const,questionable_widen:false,minutes_mean:24};
 fitCurrentRoles([starter,ghost],history,2027,[],'2026-11-10T00:00:00Z');
 assert.ok(ghost.play_probability!<starter.play_probability!,`${ghost.play_probability} vs ${starter.play_probability}`);
 assert.equal(ghost.participation_coverage!.absent,12);
 assert.ok(ghost.minutes_mean<=NEWCOMER_MINUTES_PRIOR+1e-9,`ghost minutes ${ghost.minutes_mean}`);
 assert.equal(ghost.typical_minutes,0);
 assert.equal(starter.typical_minutes,32);
 assert.equal(newcomerMinutes([],2027),NEWCOMER_MINUTES_PRIOR);
});

test('the lineup baseline is what the team actually played, so a season-long absence is not charged again',()=>{
 const profile:TeamProfile={pace:100,offense:1.12,defense:1.12,turnover_rate:0.13,offensive_rebound_rate:0.27,assist_rate:0.6,ft_trip_rate:0.2,games:10,rest_days:2};
 const line=(id:string,minutes:number,typical:number,strong=false):RatePlayer=>({athlete_id:id,name:id,team_id:'t',position:'G',position_group:'Guard',injury_status:'healthy',minutes_weight:1,questionable_widen:false,games_2026:40,games_2027:5,games:45,shooting_games:45,thin_sample:false,minutes_mean:minutes,typical_minutes:typical,fga_per_min:strong?0.45:0.15,fta_per_min:strong?0.12:0.04,tpa_given_fga:0.4,fg2_pct:strong?0.62:0.46,tp_pct:strong?0.41:0.33,ft_pct:0.8,reb_per_min:0.12,ast_per_min:0.08});
 const rotation=[32,30,28,26,24,22,20,18,16,14].map((m,i)=>line(`p${i}`,m,m*240/230));
 const longOut=line('star',36,0,true);
 const tonight=[...rotation.map(p=>p.minutes_mean*240/230),0];
 const factor=personnelFactor([...rotation,longOut],tonight,profile,undefined,100);
 assert.ok(Math.abs(factor-1)<0.01,`season-long absence factor ${factor}`);
 const newlyOut=line('star',36,34,true);
 const missing=personnelFactor([...rotation,newlyOut],tonight,profile,undefined,100);
 assert.ok(missing<0.97,`new absence factor ${missing}`);
});

test("the team model's league level follows this season's scoring, not a pooled average",()=>{
 const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
 attachPlayCache(cache,'data/shooting-cache.json');
 const events=eligibleEvents(cache.events!,'2026-11-06T18:00:00Z').filter(e=>e.players.every(p=>p.tov!==undefined&&p.orb!==undefined));
 const current=events.filter(e=>e.season===2027);
 const ppp=(xs:CompletedEvent[])=>xs.reduce((s,e)=>s+e.home_pts+e.away_pts,0)/xs.reduce((s,e)=>s+eventPossessions(e,e.home_team_id)+eventPossessions(e,e.away_team_id),0);
 const effects=fitTeamEffects(events,eventPossessions);
 assert.ok(effects.level!==undefined&&Number.isFinite(effects.level));
 assert.ok(Math.abs(effects.level!/ppp(current)-1)<0.01,`level ${effects.level} vs current ${ppp(current)}`);
 assert.ok(effects.prior_season_shift!>0,'last season scored more per possession');
});

test('archived tips pair with box tips written in a different timestamp format',()=>{
 assert.equal(sameInstant('2026-11-07T00:00Z','2026-11-07T00:00:00Z'),true);
 assert.equal(sameInstant('2026-11-07T00:00Z','2026-11-07T00:30:00Z'),false);
 assert.equal(sameInstant('bad','bad'),false);
 const slate=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json','utf8')),card=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8'));
 const g=slate.games[0];card.generated_at=new Date(Date.parse(g.start_time)-3600000).toISOString();slate.generated_at=card.generated_at;
 const archive={slate,card,source_lineage:{input_hash:card.input_hash,model_hash:card.model_hash,maximum_event_start:'2026-10-28T00:00:00Z',training_event_ids:[] as string[]}};
 const shortForm=new Date(Date.parse(g.start_time)).toISOString().replace(/:00\.000Z$/,'Z');
 assert.ok(archivedForecast([archive],g.event_id,shortForm,card.model_version));
});
