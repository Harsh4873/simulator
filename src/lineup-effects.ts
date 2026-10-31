import {historicalStints} from './play-history.ts';
import type {CompletedEvent} from './parse-summary.ts';
export interface LineupEffects {
 status:'fitted'|'unknown';games:number;heldout_games:number;mae:number|null;baseline_mae:number|null;
 offense:Record<string,number>;defense:Record<string,number>;offense_center:Record<string,number>;defense_center:Record<string,number>;reason:string|null;
 selection_games?:number;full_game_checks?:{games:number;mae:number|null;baseline_mae:number|null;home_bias:number|null;away_bias:number|null};
}
export function fitLineupEffects(events:CompletedEvent[]):LineupEffects{
 const groups=events.map(e=>({e,...historicalStints(e)})).filter(x=>x.stints.length).sort((a,b)=>a.e.start_time.localeCompare(b.e.start_time)||a.e.event_id.localeCompare(b.e.event_id));
 const empty:LineupEffects={status:'unknown',games:groups.length,heldout_games:0,mae:null,baseline_mae:null,offense:{},defense:{},offense_center:{},defense_center:{},reason:'Insufficient validated lineup coverage'};
 if(groups.length<150)return empty;
 // Event blocks: train coefficients, select penalty, then evaluate once on untouched games.
 const train=groups.slice(0,Math.floor(groups.length*.6)),selection=groups.slice(train.length,Math.floor(groups.length*.8)),hold=groups.slice(train.length+selection.length);
 const rates=new Map<string,{pts:number;minutes:number}>();let totalPoints=0,totalMinutes=0;
 for(const {e,stints} of train)for(const stint of stints)for(const [team,pts] of [[e.home_team_id,stint.home_points],[e.away_team_id,stint.away_points]] as const){const prior=rates.get(team)??{pts:0,minutes:0};prior.pts+=pts;prior.minutes+=stint.seconds/60;rates.set(team,prior);totalPoints+=pts;totalMinutes+=stint.seconds/60;}
 const league=totalPoints/totalMinutes;
 const baseline=(team:string)=>{const r=rates.get(team);return r?(r.pts+100*league)/(r.minutes+100):league;}; // Labelled 100-minute league prior.
 const rows=(xs:typeof groups)=>xs.flatMap(({e,stints})=>stints.flatMap(stint=>[
  {event:e.event_id,home:true,offTeam:e.home_team_id,defTeam:e.away_team_id,off:stint.home,def:stint.away,y:stint.home_points/(stint.seconds/60),w:stint.seconds/60},
  {event:e.event_id,home:false,offTeam:e.away_team_id,defTeam:e.home_team_id,off:stint.away,def:stint.home,y:stint.away_points/(stint.seconds/60),w:stint.seconds/60},
 ]));
 const training=rows(train),validation=rows(selection),testing=rows(hold),ids=[...new Set(training.flatMap(r=>r.off))].sort(),index=new Map(ids.map((id,i)=>[id,i]));
 const columns=Array.from({length:ids.length*2},()=>[] as number[]);
 training.forEach((r,i)=>{r.off.forEach(id=>columns[index.get(id)!].push(i));r.def.forEach(id=>columns[ids.length+index.get(id)!].push(i));});
 const solve=(penalty:number)=>{const beta=columns.map(()=>0),residual=training.map(r=>r.y-baseline(r.offTeam));
  for(let sweep=0;sweep<20;sweep++)columns.forEach((indexes,j)=>{let xy=0,xx=penalty;for(const i of indexes){xy+=training[i].w*(residual[i]+beta[j]);xx+=training[i].w;}const next=xy/xx,delta=next-beta[j];beta[j]=next;for(const i of indexes)residual[i]-=delta;});return beta;
 };
 const model=(beta:number[]):LineupEffects=>{
  const centers=new Map<string,{off:number;def:number;w:number}>();
  for(const r of training){const c=centers.get(r.offTeam)??{off:0,def:0,w:0};c.off+=r.w*r.off.reduce((s,id)=>s+beta[index.get(id)!],0);c.def+=r.w*r.off.reduce((s,id)=>s+beta[ids.length+index.get(id)!],0);c.w+=r.w;centers.set(r.offTeam,c);}
  return {...empty,status:'fitted',offense:Object.fromEntries(ids.map((id,i)=>[id,beta[i]/league])),defense:Object.fromEntries(ids.map((id,i)=>[id,beta[ids.length+i]/league])),offense_center:Object.fromEntries([...centers].map(([team,c])=>[team,c.off/c.w/league])),defense_center:Object.fromEntries([...centers].map(([team,c])=>[team,c.def/c.w/league]))};
 };
 const prediction=(r:typeof training[number],m:LineupEffects)=>baseline(r.offTeam)*Math.exp(lineupLogEffect(m,r.offTeam,r.off,'offense')+lineupLogEffect(m,r.defTeam,r.def,'defense'));
 const loss=(xs:typeof training,m:LineupEffects|null)=>xs.reduce((s,r)=>s+r.w*Math.abs((m?prediction(r,m):baseline(r.offTeam))-r.y),0)/xs.reduce((s,r)=>s+r.w,0);
 const best=[100,500,1000].map(penalty=>model(solve(penalty))).sort((a,b)=>loss(validation,a)-loss(validation,b))[0];
 const fullIds=new Set(hold.filter(x=>x.covered_seconds===(48+5*(x.e.periods-4))*60).map(x=>x.e.event_id));
 const full=new Map<string,{actual:number;predicted:number;base:number;home:boolean}>();
 for(const r of testing.filter(r=>fullIds.has(r.event))){const key=`${r.event}:${r.home}`,v=full.get(key)??{actual:0,predicted:0,base:0,home:r.home};v.actual+=r.y*r.w;v.predicted+=prediction(r,best)*r.w;v.base+=baseline(r.offTeam)*r.w;full.set(key,v);}
 const xs=[...full.values()],avg=(ys:number[])=>ys.length?ys.reduce((a,b)=>a+b,0)/ys.length:null;
 const checks={games:fullIds.size,mae:avg(xs.map(x=>Math.abs(x.predicted-x.actual))),baseline_mae:avg(xs.map(x=>Math.abs(x.base-x.actual))),home_bias:avg(xs.filter(x=>x.home).map(x=>x.predicted-x.actual)),away_bias:avg(xs.filter(x=>!x.home).map(x=>x.predicted-x.actual))};
 const mae=loss(testing,best),base=loss(testing,null);
 // Minimum 20 complete held-out games is an evidence guard, not a calibration claim.
 const pass=checks.games>=20&&checks.mae!<checks.baseline_mae!&&mae<base;
 return {...best,status:pass?'fitted':'unknown',heldout_games:hold.length,selection_games:selection.length,mae,baseline_mae:base,full_game_checks:checks,reason:pass?null:checks.games<20?'Fewer than 20 untouched complete lineup games':'Lineup effects did not improve untouched stint and full-game baselines'};
}
export function lineupLogEffect(model:LineupEffects|undefined,team:string,ids:string[],side:'offense'|'defense'):number{
 if(model?.status!=='fitted')return 0;
 return ids.reduce((s,id)=>s+(model[side][id]??0),0)-(model[side==='offense'?'offense_center':'defense_center'][team]??0);
}
