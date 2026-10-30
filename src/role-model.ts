import type { CompletedEvent } from './parse-summary.ts';
export interface RoleSelection { prior_games:number; samples:number; mae:number|null; recent_mae:number|null; prior_mae:number|null; source:'chronological-validation'|'labelled-prior' }
export function selectRolePrior(events:CompletedEvent[],activeSeason:number):RoleSelection {
  const sorted=events.filter(e=>e.season<activeSeason&&e.season_type===2).sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time));
  const candidates=[0,1,3,6,10],errors=candidates.map(()=>0);
  const history=new Map<string,{minutes:number;team:string}[]>();let count=0,recentError=0,priorError=0;
  for(const e of sorted)for(const p of e.players){
    const prior=history.get(p.athlete_id)??[];
    if(prior.length>=10){
      const recent=prior.slice(-5).filter(x=>x.team===p.team_id),priorMean=prior.reduce((s,x)=>s+x.minutes,0)/prior.length;
      if(recent.length){const total=recent.reduce((s,x)=>s+x.minutes,0);candidates.forEach((k,i)=>{errors[i]+=Math.abs((total+k*priorMean)/(recent.length+k)-p.minutes);});recentError+=Math.abs(total/recent.length-p.minutes);priorError+=Math.abs(priorMean-p.minutes);count++;}
    }
    prior.push({minutes:p.minutes,team:p.team_id});history.set(p.athlete_id,prior);
  }
  if(count<100)return {prior_games:3,samples:count,mae:null,recent_mae:null,prior_mae:null,source:'labelled-prior'};
  const best=errors.indexOf(Math.min(...errors));return {prior_games:candidates[best],samples:count,mae:errors[best]/count,recent_mae:recentError/count,prior_mae:priorError/count,source:'chronological-validation'};
}
