import type { CompletedEvent } from './parse-summary.ts';
export interface RoleSelection {window:number;half_life:number|null;prior_games:number;samples:number;heldout_samples:number;mae:number|null;recent_mae:number|null;prior_mae:number|null;residual_sd:Record<string,number>;source:'chronological-validation'|'labelled-prior'}
export function selectRolePrior(events:CompletedEvent[],activeSeason:number):RoleSelection {
 const sorted=events.filter(e=>e.season<activeSeason&&e.season_type===2).sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time));
 const candidates=[5,10].flatMap(window=>[null,2,5].flatMap(half_life=>[0,1,3,6,10].map(prior_games=>({window,half_life,prior_games}))));
 const errors=candidates.map(()=>0),held:candidateRow[]=[],history=new Map<string,{minutes:number;team:string;starter:boolean|undefined}[]>();let count=0;
 type candidateRow={errors:number[];recent:number;prior:number;role:string};
 for(const [eventIndex,e] of sorted.entries())for(const p of e.players){
  const prior=history.get(p.athlete_id)??[];
  if(prior.length>=10){
   const recent=prior.filter(x=>x.team===p.team_id).slice(-5),priorMean=prior.reduce((s,x)=>s+x.minutes,0)/prior.length;
   if(recent.length){
    const residuals=candidates.map(c=>{const xs=prior.filter(x=>x.team===p.team_id).slice(-c.window).reverse(),weights=xs.map((_,j)=>c.half_life===null?1:2**(-j/c.half_life));return (xs.reduce((s,x,j)=>s+weights[j]*x.minutes,0)+c.prior_games*priorMean)/(weights.reduce((a,b)=>a+b,0)+c.prior_games)-p.minutes;});
    if(eventIndex<Math.floor(sorted.length*.8)){residuals.forEach((x,i)=>errors[i]+=Math.abs(x));count++;}
    else held.push({errors:residuals,recent:recent.reduce((s,x)=>s+x.minutes,0)/recent.length-p.minutes,prior:priorMean-p.minutes,role:recent.at(-1)?.starter===undefined?'unknown':recent.at(-1)!.starter?'starter':'bench'});
   }
  }
  prior.push({minutes:p.minutes,team:p.team_id,starter:p.starter});history.set(p.athlete_id,prior);
 }
 if(count<100)return {window:5,half_life:null,prior_games:3,samples:count,heldout_samples:held.length,mae:null,recent_mae:null,prior_mae:null,residual_sd:{},source:'labelled-prior'};
 const best=errors.indexOf(Math.min(...errors)),average=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
 const residual_sd:Record<string,number>={};
 for(const role of ['starter','bench','unknown']){const xs=held.filter(r=>r.role===role).map(r=>r.errors[best]);if(xs.length>=30){const mean=average(xs)!;residual_sd[role]=Math.sqrt(xs.reduce((s,x)=>s+(x-mean)**2,0)/(xs.length-1));}}
 return {...candidates[best],samples:count,heldout_samples:held.length,mae:average(held.map(r=>Math.abs(r.errors[best]))),recent_mae:average(held.map(r=>Math.abs(r.recent))),prior_mae:average(held.map(r=>Math.abs(r.prior))),residual_sd,source:'chronological-validation'};
}
