import {historicalStints} from './play-history.ts';
import type {CompletedEvent} from './parse-summary.ts';
export interface LineupEffects {status:'fitted'|'unknown';games:number;heldout_games:number;mae:number|null;baseline_mae:number|null;offense:Record<string,number>;defense:Record<string,number>;offense_center:Record<string,number>;defense_center:Record<string,number>;reason:string|null}
export function fitLineupEffects(events:CompletedEvent[]):LineupEffects{
 const groups=events.map(e=>({e,s:historicalStints(e).stints})).filter(x=>x.s.length).sort((a,b)=>a.e.start_time.localeCompare(b.e.start_time));
 const empty:LineupEffects={status:'unknown',games:groups.length,heldout_games:0,mae:null,baseline_mae:null,offense:{},defense:{},offense_center:{},defense_center:{},reason:'Insufficient validated lineup coverage'};
 if(groups.length<150)return empty;
 const split=Math.floor(groups.length*.8),train=groups.slice(0,split),hold=groups.slice(split);
 const rates=new Map<string,{pts:number;minutes:number}>();let totalPoints=0,totalMinutes=0;
 for(const {e,s} of train)for(const stint of s)for(const [team,pts] of [[e.home_team_id,stint.home_points],[e.away_team_id,stint.away_points]] as const){const prior=rates.get(team)??{pts:0,minutes:0};prior.pts+=pts;prior.minutes+=stint.seconds/60;rates.set(team,prior);totalPoints+=pts;totalMinutes+=stint.seconds/60;}
 const league=totalPoints/totalMinutes;
 const baseline=(team:string)=>{const r=rates.get(team);return r?(r.pts+100*league)/(r.minutes+100):league;}; // 100-minute league prior.
 const rows=(xs:typeof groups)=>xs.flatMap(({e,s})=>s.flatMap(stint=>[
  {offTeam:e.home_team_id,defTeam:e.away_team_id,off:stint.home,def:stint.away,y:stint.home_points/(stint.seconds/60),w:stint.seconds/60},
  {offTeam:e.away_team_id,defTeam:e.home_team_id,off:stint.away,def:stint.home,y:stint.away_points/(stint.seconds/60),w:stint.seconds/60},
 ]));
 const training=rows(train),validation=rows(hold),ids=[...new Set(training.flatMap(r=>r.off))].sort(),index=new Map(ids.map((id,i)=>[id,i]));
 const columns=Array.from({length:ids.length*2},()=>[] as number[]);
 training.forEach((r,i)=>{r.off.forEach(id=>columns[index.get(id)!].push(i));r.def.forEach(id=>columns[ids.length+index.get(id)!].push(i));});
 const solve=(penalty:number)=>{const beta=columns.map(()=>0),residual=training.map(r=>r.y-baseline(r.offTeam));
  for(let sweep=0;sweep<20;sweep++)columns.forEach((indexes,j)=>{let xy=0,xx=penalty;for(const i of indexes){xy+=training[i].w*(residual[i]+beta[j]);xx+=training[i].w;}const next=xy/xx,delta=next-beta[j];beta[j]=next;for(const i of indexes)residual[i]-=delta;});return beta;
 };
 const prediction=(r:typeof training[number],b:number[])=>Math.max(0,baseline(r.offTeam)+r.off.reduce((s,id)=>s+(b[index.get(id)??-1]??0),0)+r.def.reduce((s,id)=>s+(index.has(id)?b[ids.length+index.get(id)!]:0),0));
 const weight=validation.reduce((s,r)=>s+r.w,0),base=validation.reduce((s,r)=>s+r.w*Math.abs(baseline(r.offTeam)-r.y),0)/weight;
 const fits=[100,500,1000].map(penalty=>{const beta=solve(penalty);return {beta,loss:validation.reduce((s,r)=>s+r.w*Math.abs(prediction(r,beta)-r.y),0)/weight};}).sort((a,b)=>a.loss-b.loss);
 const best=fits[0];if(!Number.isFinite(best.loss)||best.loss>=base)return {...empty,heldout_games:hold.length,mae:best.loss,baseline_mae:base,reason:'Lineup effects did not improve chronological team-only baseline'};
 // Coefficients remain trained on the earlier block; the held-out block is never refitted into them.
 const centers=new Map<string,{off:number;def:number;w:number}>();
 for(const r of training){const c=centers.get(r.offTeam)??{off:0,def:0,w:0};c.off+=r.w*r.off.reduce((s,id)=>s+best.beta[index.get(id)!],0);c.def+=r.w*r.off.reduce((s,id)=>s+best.beta[ids.length+index.get(id)!],0);c.w+=r.w;centers.set(r.offTeam,c);}
 return {status:'fitted',games:groups.length,heldout_games:hold.length,mae:best.loss,baseline_mae:base,offense:Object.fromEntries(ids.map((id,i)=>[id,best.beta[i]/league])),defense:Object.fromEntries(ids.map((id,i)=>[id,best.beta[ids.length+i]/league])),offense_center:Object.fromEntries([...centers].map(([team,c])=>[team,c.off/c.w/league])),defense_center:Object.fromEntries([...centers].map(([team,c])=>[team,c.def/c.w/league])),reason:null};
}
export function lineupLogEffect(model:LineupEffects|undefined,team:string,ids:string[],side:'offense'|'defense'):number{
 if(model?.status!=='fitted')return 0;
 return ids.reduce((s,id)=>s+(model[side][id]??0),0)-(model[side==='offense'?'offense_center':'defense_center'][team]??0);
}
