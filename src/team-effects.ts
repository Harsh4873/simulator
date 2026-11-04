import {restDays,scheduleContext} from './schedule-context.ts';
export {restDays} from './schedule-context.ts';
import type { CompletedEvent } from './parse-summary.ts';
export const TEAM_PENALTY_CANDIDATES = [4, 8, 12] as const;
export const PRIOR_WEIGHT_CANDIDATES = [0.2, 0.5, 1] as const;
export const DEFAULT_TEAM_PENALTY = 12;
export const DEFAULT_PRIOR_SEASON_WEIGHT = 0.2;
export interface TeamEffects {
  offense:Record<string,number>;
  defense:Record<string,number>;
  home:number;
  rest:number;
  games:number;
  residual_sd:number;
  rest_samples:number;
  workload:number;
  travel:number|null;
  timezone:number|null;
  travel_samples:number;
  timezone_samples:number;
  team_penalty:number;
  prior_season_weight:number;
  holdout_mae:number|null;
  holdout_games:number;
}
type Row = {x:[number,number][];y:number;current:boolean;eventIndex:number;pace:number;pts:number};
const empty = (games:number):TeamEffects => ({
  offense:{},defense:{},home:0,rest:0,games,residual_sd:0,rest_samples:0,workload:0,travel:null,timezone:null,travel_samples:0,timezone_samples:0,
  team_penalty:DEFAULT_TEAM_PENALTY,prior_season_weight:DEFAULT_PRIOR_SEASON_WEIGHT,holdout_mae:null,holdout_games:0,
});
function solve(rows:Row[],n:number,teamPenalty:number,priorWeight:number):{beta:number[];residual:number[]} {
  const weight = (r:Row) => r.current ? 1 : priorWeight;
  const beta=new Array(6+2*n).fill(0);
  const weighted = rows.reduce((s,r)=>s+weight(r),0);
  beta[0]=rows.reduce((s,r)=>s+weight(r)*r.y,0)/Math.max(1e-9,weighted);
  const residual=rows.map(r=>r.y-beta[0]);
  const columns=beta.map((_,j)=>rows.flatMap((r,i)=>{const x=r.x.find(([k])=>k===j)?.[1]??0;return x?[{i,x}]:[];}));
  for(let sweep=0;sweep<30;sweep++)for(let j=0;j<beta.length;j++){
    const penalty=j===0?0:j<=2*n?teamPenalty:50;let xy=0,xx=penalty;
    for(const {i,x} of columns[j]){const w=weight(rows[i]);xy+=w*x*(residual[i]+x*beta[j]);xx+=w*x*x;}
    const next=xx?xy/xx:0,delta=next-beta[j];beta[j]=next;
    for(const {i,x} of columns[j])residual[i]-=x*delta;
  }
  return {beta,residual};
}
function predictedPpp(row:Row,beta:number[]):number {
  let log=beta[0];
  for(const [j,x] of row.x)if(j>0)log+=(beta[j]??0)*x;
  return Math.exp(log);
}
// Ridge priors center team, venue and rest effects at zero. No market input.
// Team penalty and prior-season weight are selected on a chronological holdout of events.
export function fitTeamEffects(events:CompletedEvent[],possessions:(e:CompletedEvent,t:string)=>number):TeamEffects {
  if(!events.length)return empty(0);
  const ordered=[...events].sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time)||a.event_id.localeCompare(b.event_id));
  const teams=[...new Set(ordered.flatMap(e=>[e.home_team_id,e.away_team_id]))].sort();
  const activeSeason=Math.max(...ordered.map(e=>e.season));
  const n=teams.length,rows:Row[]=[],last=new Map<string,CompletedEvent>();let restSamples=0,travelSamples=0,timezoneSamples=0;
  ordered.forEach((e,eventIndex)=>{
    const pace=(possessions(e,e.home_team_id)+possessions(e,e.away_team_id))/2;
    for(const [team,opp,pts,venue] of [[e.home_team_id,e.away_team_id,e.home_pts,1],[e.away_team_id,e.home_team_id,e.away_pts,-1]] as const){
      if(!(pace>0&&pts>0))continue;
      const prior=last.get(`${e.season}:${team}`)??null,opponent=last.get(`${e.season}:${opp}`)??null,rest=restDays(prior?.start_time??null,e.start_time),other=restDays(opponent?.start_time??null,e.start_time);
      const schedule=scheduleContext(prior,e.start_time,e.play_history?.venue),against=scheduleContext(opponent,e.start_time,e.play_history?.venue);
      const workload=schedule.previous_minutes!==null&&against.previous_minutes!==null?(schedule.previous_minutes-against.previous_minutes)/5:0;
      const travel=schedule.travel_km!==null&&against.travel_km!==null?(schedule.travel_km-against.travel_km)/1000:0;if(schedule.travel_km!==null&&against.travel_km!==null)travelSamples++;
      const timezone=schedule.timezone_change_hours!==null&&against.timezone_change_hours!==null?schedule.timezone_change_hours-against.timezone_change_hours:0;if(schedule.timezone_change_hours!==null&&against.timezone_change_hours!==null)timezoneSamples++;
      const delta=rest!==null&&other!==null?Math.log1p(rest)-Math.log1p(other):0;if(rest!==null&&other!==null)restSamples++;
      rows.push({x:[[0,1],[1+teams.indexOf(team),1],[1+n+teams.indexOf(opp),1],[1+2*n,e.neutral?0:venue],[2+2*n,delta],[3+2*n,workload],[4+2*n,travel],[5+2*n,timezone]],y:Math.log(pts/pace),current:e.season===activeSeason,eventIndex,pace,pts});
    }
    last.set(`${e.season}:${e.home_team_id}`,e);last.set(`${e.season}:${e.away_team_id}`,e);
  });
  const split=ordered.length>=50?Math.floor(ordered.length*.8):ordered.length;
  const train=rows.filter(r=>r.eventIndex<split),hold=rows.filter(r=>r.eventIndex>=split);
  let teamPenalty:number=DEFAULT_TEAM_PENALTY,priorWeight:number=DEFAULT_PRIOR_SEASON_WEIGHT,holdoutMae:number|null=null;
  if(hold.length>=20&&train.length>=40){
    let best=Infinity;
    for(const penalty of TEAM_PENALTY_CANDIDATES)for(const weight of PRIOR_WEIGHT_CANDIDATES){
      const {beta}=solve(train,n,penalty,weight);
      const mae=hold.reduce((s,r)=>s+Math.abs(r.pts-predictedPpp(r,beta)*r.pace),0)/hold.length;
      if(mae<best){best=mae;teamPenalty=penalty;priorWeight=weight;holdoutMae=mae;}
    }
  }
  const {beta,residual}=solve(rows,n,teamPenalty,priorWeight);
  return {
    offense:Object.fromEntries(teams.map((t,i)=>[t,Math.exp(beta[0]+beta[1+i])])),
    defense:Object.fromEntries(teams.map((t,i)=>[t,Math.exp(beta[0]+beta[1+n+i])])),
    home:beta[1+2*n],
    rest:restSamples>=100?beta[2+2*n]:0,
    games:events.length,
    residual_sd:Math.sqrt(residual.reduce((s,x)=>s+x*x,0)/Math.max(1,rows.length-beta.length)),
    rest_samples:restSamples,
    workload:restSamples>=100?beta[3+2*n]:0,
    travel:travelSamples>=100?beta[4+2*n]:null,
    timezone:timezoneSamples>=100?beta[5+2*n]:null,
    travel_samples:travelSamples,
    timezone_samples:timezoneSamples,
    team_penalty:teamPenalty,
    prior_season_weight:priorWeight,
    holdout_mae:holdoutMae,
    holdout_games:new Set(hold.map(r=>r.eventIndex)).size,
  };
}
