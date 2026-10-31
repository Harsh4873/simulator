import {restDays,scheduleContext} from './schedule-context.ts';
export {restDays} from './schedule-context.ts';
import type { CompletedEvent } from './parse-summary.ts';
export interface TeamEffects { offense:Record<string,number>; defense:Record<string,number>; home:number; rest:number; games:number; residual_sd:number; rest_samples:number;workload:number;travel:number|null;timezone:number|null;travel_samples:number;timezone_samples:number }
// Ridge priors center team, venue and rest effects at zero. No market input.
export function fitTeamEffects(events:CompletedEvent[],possessions:(e:CompletedEvent,t:string)=>number):TeamEffects {
  const teams=[...new Set(events.flatMap(e=>[e.home_team_id,e.away_team_id]))].sort();
  const activeSeason=Math.max(...events.map(e=>e.season));
  const n=teams.length,rows:{x:[number,number][];y:number;weight:number}[]=[],last=new Map<string,CompletedEvent>();let restSamples=0,travelSamples=0,timezoneSamples=0;
  for(const e of [...events].sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time))){
    const pace=(possessions(e,e.home_team_id)+possessions(e,e.away_team_id))/2;
    for(const [team,opp,pts,venue] of [[e.home_team_id,e.away_team_id,e.home_pts,1],[e.away_team_id,e.home_team_id,e.away_pts,-1]] as const){
      if(!(pace>0&&pts>0))continue;
      const prior=last.get(`${e.season}:${team}`)??null,opponent=last.get(`${e.season}:${opp}`)??null,rest=restDays(prior?.start_time??null,e.start_time),other=restDays(opponent?.start_time??null,e.start_time);
      const schedule=scheduleContext(prior,e.start_time,e.play_history?.venue),against=scheduleContext(opponent,e.start_time,e.play_history?.venue);
      const workload=schedule.previous_minutes!==null&&against.previous_minutes!==null?(schedule.previous_minutes-against.previous_minutes)/5:0;
      const travel=schedule.travel_km!==null&&against.travel_km!==null?(schedule.travel_km-against.travel_km)/1000:0;if(schedule.travel_km!==null&&against.travel_km!==null)travelSamples++;
      const timezone=schedule.timezone_change_hours!==null&&against.timezone_change_hours!==null?schedule.timezone_change_hours-against.timezone_change_hours:0;if(schedule.timezone_change_hours!==null&&against.timezone_change_hours!==null)timezoneSamples++;
      const delta=rest!==null&&other!==null?Math.log1p(rest)-Math.log1p(other):0;if(rest!==null&&other!==null)restSamples++;
      rows.push({x:[[0,1],[1+teams.indexOf(team),1],[1+n+teams.indexOf(opp),1],[1+2*n,e.neutral?0:venue],[2+2*n,delta],[3+2*n,workload],[4+2*n,travel],[5+2*n,timezone]],y:Math.log(pts/pace),weight:e.season===activeSeason?1:.2});
    }
    last.set(`${e.season}:${e.home_team_id}`,e);last.set(`${e.season}:${e.away_team_id}`,e);
  }
  const beta=new Array(6+2*n).fill(0);beta[0]=rows.reduce((s,r)=>s+r.y,0)/Math.max(1,rows.length);
  const residual=rows.map(r=>r.y-beta[0]);
  const columns=beta.map((_,j)=>rows.flatMap((r,i)=>{const x=r.x.find(([k])=>k===j)?.[1]??0;return x?[{i,x}]:[];}));
  for(let sweep=0;sweep<30;sweep++)for(let j=0;j<beta.length;j++){
    const penalty=j===0?0:j<=2*n?12:50;let xy=0,xx=penalty;
    for(const {i,x} of columns[j]){xy+=rows[i].weight*x*(residual[i]+x*beta[j]);xx+=rows[i].weight*x*x;}
    const next=xx?xy/xx:0,delta=next-beta[j];beta[j]=next;
    for(const {i,x} of columns[j])residual[i]-=x*delta;
  }
  return {offense:Object.fromEntries(teams.map((t,i)=>[t,Math.exp(beta[0]+beta[1+i])])),defense:Object.fromEntries(teams.map((t,i)=>[t,Math.exp(beta[0]+beta[1+n+i])])),home:beta[1+2*n],rest:restSamples>=100?beta[2+2*n]:0,games:events.length,residual_sd:Math.sqrt(residual.reduce((s,x)=>s+x*x,0)/Math.max(1,rows.length-beta.length)),rest_samples:restSamples,workload:restSamples>=100?beta[3+2*n]:0,travel:travelSamples>=100?beta[4+2*n]:null,timezone:timezoneSamples>=100?beta[5+2*n]:null,travel_samples:travelSamples,timezone_samples:timezoneSamples};
}
