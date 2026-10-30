import { chicagoDate } from './date.ts';
import type { CompletedEvent } from './parse-summary.ts';
export function restDays(previous:string|null,tip:string):number|null {
  if(!previous)return null;
  const days=(Date.parse(chicagoDate(new Date(tip)))-Date.parse(chicagoDate(new Date(previous))))/86400000;
  return days>=1?days-1:null;
}
export interface TeamEffects { offense:Record<string,number>; defense:Record<string,number>; home:number; rest:number; games:number; residual_sd:number; rest_samples:number }
// Ridge priors center team, venue and rest effects at zero. No market input.
export function fitTeamEffects(events:CompletedEvent[],possessions:(e:CompletedEvent,t:string)=>number):TeamEffects {
  const teams=[...new Set(events.flatMap(e=>[e.home_team_id,e.away_team_id]))].sort();
  const activeSeason=Math.max(...events.map(e=>e.season));
  const n=teams.length,rows:{x:[number,number][];y:number;weight:number}[]=[],last=new Map<string,string>();let restSamples=0;
  for(const e of [...events].sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time))){
    const pace=(possessions(e,e.home_team_id)+possessions(e,e.away_team_id))/2;
    for(const [team,opp,pts,venue] of [[e.home_team_id,e.away_team_id,e.home_pts,1],[e.away_team_id,e.home_team_id,e.away_pts,-1]] as const){
      if(!(pace>0&&pts>0))continue;
      const rest=restDays(last.get(`${e.season}:${team}`)??null,e.start_time),other=restDays(last.get(`${e.season}:${opp}`)??null,e.start_time);
      const delta=rest!==null&&other!==null?Math.log1p(rest)-Math.log1p(other):0;if(rest!==null&&other!==null)restSamples++;
      rows.push({x:[[0,1],[1+teams.indexOf(team),1],[1+n+teams.indexOf(opp),1],[1+2*n,e.neutral?0:venue],[2+2*n,delta]],y:Math.log(pts/pace),weight:e.season===activeSeason?1:.2});
    }
    last.set(`${e.season}:${e.home_team_id}`,e.start_time);last.set(`${e.season}:${e.away_team_id}`,e.start_time);
  }
  const beta=new Array(3+2*n).fill(0);beta[0]=rows.reduce((s,r)=>s+r.y,0)/Math.max(1,rows.length);
  const residual=rows.map(r=>r.y-beta[0]);
  for(let sweep=0;sweep<30;sweep++)for(let j=0;j<beta.length;j++){
    const penalty=j===0?0:j<=2*n?12:50;let xy=0,xx=penalty;
    for(let i=0;i<rows.length;i++){const x=rows[i].x.find(([k])=>k===j)?.[1]??0;xy+=rows[i].weight*x*(residual[i]+x*beta[j]);xx+=rows[i].weight*x*x;}
    const next=xx?xy/xx:0,delta=next-beta[j];beta[j]=next;
    for(let i=0;i<rows.length;i++){const x=rows[i].x.find(([k])=>k===j)?.[1]??0;residual[i]-=x*delta;}
  }
  return {offense:Object.fromEntries(teams.map((t,i)=>[t,Math.exp(beta[0]+beta[1+i])])),defense:Object.fromEntries(teams.map((t,i)=>[t,Math.exp(beta[0]+beta[1+n+i])])),home:beta[1+2*n],rest:restSamples>=100?beta[2+2*n]:0,games:events.length,residual_sd:Math.sqrt(residual.reduce((s,x)=>s+x*x,0)/Math.max(1,rows.length-beta.length)),rest_samples:restSamples};
}
