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

/**
 * How far a player's minutes land from the card's role minutes when he plays, as quantiles of actual / predicted by
 * predicted-minutes tier. A starter's minutes are narrow and capped; a reserve's have a long low tail of short
 * appearances. One gamma shape for everyone gave starters too much upside and reserves too few short nights.
 */
export interface MinutesSpread {status:'fitted'|'unknown';edges:number[];quantiles:number[][];rows:number[];reason:string|null}
export const MINUTES_SPREAD_EDGES=[8,12,16,20,24,28,32] as const;
export const MINUTES_SPREAD_KNOTS=21;
export const MIN_SPREAD_ROWS=200;
export function minutesSpreadTier(edges:readonly number[],minutes:number):number{let tier=0;while(tier<edges.length&&minutes>=edges[tier])tier++;return tier;}
/** Inverse-CDF draw from a tier's quantile knots: u in [0,1) maps linearly between neighbouring knots. */
export function sampleMinutesRatio(spread:MinutesSpread,minutes:number,u:number):number{
 const q=spread.quantiles[minutesSpreadTier(spread.edges,minutes)],x=Math.min(1,Math.max(0,u))*(q.length-1),i=Math.min(q.length-2,Math.floor(x));
 return q[i]+(x-i)*(q[i+1]-q[i]);
}
/**
 * Scores the selected role predictor on appearances it has not seen: the final fifth of preceding-season games (the same
 * block that measures its error) and every active-season game before the cutoff, each predicted from earlier games only.
 */
export function fitMinutesSpread(events:CompletedEvent[],activeSeason:number,selection:Pick<RoleSelection,'window'|'half_life'|'prior_games'|'source'>):MinutesSpread{
 const edges=[...MINUTES_SPREAD_EDGES],empty:MinutesSpread={status:'unknown',edges,quantiles:[],rows:[],reason:'Role predictor was not selected on held-out appearances'};
 if(selection.source!=='chronological-validation')return empty;
 const sorted=events.filter(e=>e.season<=activeSeason&&e.season_type===2).sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time)||a.event_id.localeCompare(b.event_id));
 const earlier=sorted.filter(e=>e.season<activeSeason),heldFrom=Math.floor(earlier.length*.8);
 const history=new Map<string,{minutes:number;team:string}[]>(),ratios:number[][]=edges.map(()=>[]);ratios.push([]);
 let index=0;
 for(const e of sorted){
  const scored=e.season===activeSeason||index>=heldFrom;
  if(e.season<activeSeason)index++;
  for(const p of e.players){
   const prior=history.get(p.athlete_id)??[];
   if(scored&&prior.length>=10&&p.minutes>0){
    const xs=prior.filter(x=>x.team===p.team_id).slice(-selection.window).reverse();
    if(xs.length){
     const weights=xs.map((_,j)=>selection.half_life===null?1:2**(-j/selection.half_life)),priorMean=prior.reduce((s,x)=>s+x.minutes,0)/prior.length;
     const predicted=(xs.reduce((s,x,j)=>s+weights[j]*x.minutes,0)+selection.prior_games*priorMean)/(weights.reduce((a,b)=>a+b,0)+selection.prior_games);
     if(predicted>0)ratios[minutesSpreadTier(edges,predicted)].push(p.minutes/predicted);
    }
   }
   prior.push({minutes:p.minutes,team:p.team_id});history.set(p.athlete_id,prior);
  }
 }
 const rows=ratios.map(r=>r.length);
 if(rows.some(n=>n<MIN_SPREAD_ROWS))return {...empty,rows,reason:`A minutes tier has fewer than ${MIN_SPREAD_ROWS} held-out appearances`};
 const quantiles=ratios.map(values=>{
  const s=values.slice().sort((a,b)=>a-b),at=(p:number)=>{const x=p*(s.length-1),i=Math.floor(x);return s[i]+(x-i)*((s[Math.min(s.length-1,i+1)])-s[i]);};
  // The end knots sit at the 0.5th and 99.5th percentiles so one freak game does not set the range.
  const knots=Array.from({length:MINUTES_SPREAD_KNOTS},(_,k)=>at(k===0?.005:k===MINUTES_SPREAD_KNOTS-1?.995:k/(MINUTES_SPREAD_KNOTS-1)));
  // Only the shape is fitted. Each tier is scaled to average one, so the level stays with the card's role minutes;
  // late-season rest nights in the held-out block would otherwise lift every reserve.
  const mean=knots.slice(0,-1).reduce((sum,value,k)=>sum+(value+knots[k+1])/2,0)/(knots.length-1);
  return knots.map(value=>+(value/mean).toFixed(4));
 });
 return {status:'fitted',edges,quantiles,rows,reason:null};
}
