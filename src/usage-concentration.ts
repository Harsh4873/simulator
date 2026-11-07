import {historicalStints} from './play-history.ts';
import type {CompletedEvent} from './parse-summary.ts';

/**
 * How a possession's shot is split among the five players on the floor. Proportional splitting (exponent 1) gives
 * every player the same share of a crowded lineup's squeeze, so high-usage players lose volume they keep in real
 * games. In reconstructed lineup stints, shares follow season per-minute rates raised to an exponent above one.
 */
export interface UsageConcentration {
  status:'fitted'|'unknown';
  /** Exponent on field-goal attempt rates when choosing the shooter. */
  shots:number;
  /** Exponent on free-throw attempt rates when choosing who goes to the line. */
  trips:number;
  /** Exponent on assist rates when choosing the passer among the shooter's teammates. */
  assists?:number;
  /** Exponent on rebound rates when choosing the rebounder among a lineup. */
  rebounds?:number;
  stints:number;
  heldout_events:number;
  log_loss:{shots:number|null;trips:number|null;assists?:number|null;rebounds?:number|null};
  baseline_log_loss:{shots:number|null;trips:number|null;assists?:number|null;rebounds?:number|null};
  reason:string|null;
}
export const USAGE_EXPONENT_RANGE=[0.5,2] as const;
const empty=(stints:number,reason:string):UsageConcentration=>({status:'unknown',shots:1,trips:1,assists:1,rebounds:1,stints,heldout_events:0,log_loss:{shots:null,trips:null,assists:null,rebounds:null},baseline_log_loss:{shots:null,trips:null,assists:null,rebounds:null},reason});

interface Observation {weights:number[];counts:number[];time:number}

export function concentrate(weight:number,exponent:number):number{
 return weight>0?weight**exponent:0;
}

/** Attempts, free-throw trips, assists and rebounds by player inside each reconstructed lineup stint. */
export function stintObservations(events:CompletedEvent[]):{shots:Observation[];trips:Observation[];assists:Observation[];rebounds:Observation[]}{
 const totals=new Map<string,{minutes:number;fga:number;fta:number;ast:number;reb:number}>();
 for(const e of events)for(const p of e.players){
  if(!(p.minutes>0))continue;
  const key=`${e.season}:${p.athlete_id}`,t=totals.get(key)??{minutes:0,fga:0,fta:0,ast:0,reb:0};
  t.minutes+=p.minutes;t.fga+=p.fga;t.fta+=p.fta;t.ast+=p.ast;t.reb+=p.reb;totals.set(key,t);
 }
 const rate=(season:number,id:string,key:'fga'|'fta'|'ast'|'reb')=>{const t=totals.get(`${season}:${id}`);return t&&t.minutes>=60?Math.max(0.01,t[key]/t.minutes):null;};
 const shots:Observation[]=[],trips:Observation[]=[],assists:Observation[]=[],rebounds:Observation[]=[];
 for(const e of events){
  const {stints}=historicalStints(e);
  if(!stints.length||!e.play_history)continue;
  const time=Date.parse(e.start_time),plays=e.play_history.plays;
  for(const s of stints){
   const start=s.end_seconds+s.seconds;
   const inside=plays.filter(p=>p.period===s.period&&p.seconds<start&&p.seconds>=s.end_seconds);
   for(const [team,lineup] of [[e.home_team_id,s.home],[e.away_team_id,s.away]] as const){
    const fgaRates=lineup.map(id=>rate(e.season,id,'fga')),ftaRates=lineup.map(id=>rate(e.season,id,'fta'));
    if(fgaRates.some(x=>x===null)||ftaRates.some(x=>x===null))continue;
    const fga=lineup.map(()=>0),ft=lineup.map(()=>0);
    for(const p of inside){
     if(p.team!==team||!p.athletes.length)continue;
     const i=lineup.indexOf(p.athletes[0]);if(i<0)continue;
     const free=/free throw/i.test(p.type);
     if(!free&&(p.attempt===2||p.attempt===3))fga[i]++;
     if(free&&p.trip_attempt===1&&!/technical/i.test(p.type))ft[i]++;
    }
    if(fga.some(x=>x>0))shots.push({weights:fgaRates as number[],counts:fga,time});
    if(ft.some(x=>x>0))trips.push({weights:ftaRates as number[],counts:ft,time});
    const astRates=lineup.map(id=>rate(e.season,id,'ast')),rebRates=lineup.map(id=>rate(e.season,id,'reb'));
    if(astRates.some(x=>x===null)||rebRates.some(x=>x===null))continue;
    const reb=lineup.map(()=>0);
    for(const p of inside){
     if(p.team!==team||!p.athletes.length)continue;
     // An assist is a choice among the shooter's four teammates on the floor.
     if((p.attempt===2||p.attempt===3)&&p.made&&p.athletes.length>1&&!/free throw/i.test(p.type)){
      const shooter=lineup.indexOf(p.athletes[0]),passer=lineup.indexOf(p.athletes[1]);
      if(shooter>=0&&passer>=0&&shooter!==passer){const others=lineup.map((_,i)=>i).filter(i=>i!==shooter);assists.push({weights:others.map(i=>astRates[i] as number),counts:others.map(i=>Number(i===passer)),time});}
     }
     if(/rebound/i.test(p.type)){const i=lineup.indexOf(p.athletes[0]);if(i>=0)reb[i]++;}
    }
    if(reb.some(x=>x>0))rebounds.push({weights:rebRates as number[],counts:reb,time});
   }
  }
 }
 return {shots,trips,assists,rebounds};
}

function logLikelihood(observations:Observation[],exponent:number):number{
 let total=0;
 for(const o of observations){
  const z=o.weights.reduce((s,w)=>s+concentrate(w,exponent),0);
  o.counts.forEach((c,i)=>{if(c)total+=c*Math.log(concentrate(o.weights[i],exponent)/z);});
 }
 return total;
}

/** Exponents chosen on the earlier 70% of games and kept only where they beat proportional splitting on the later 30%. */
export function fitUsageConcentration(events:CompletedEvent[]):UsageConcentration{
 const {shots,trips,assists,rebounds}=stintObservations(events);
 if(shots.length<2000)return empty(shots.length,'Fewer than 2,000 lineup stints with attempts');
 const fit=(observations:Observation[])=>{
  const sorted=[...observations].sort((a,b)=>a.time-b.time),cut=Math.floor(sorted.length*0.7);
  const train=sorted.slice(0,cut),hold=sorted.slice(cut);
  let best=1,bestLL=-Infinity;
  for(let e=USAGE_EXPONENT_RANGE[0];e<=USAGE_EXPONENT_RANGE[1]+1e-9;e+=0.05){const v=logLikelihood(train,e);if(v>bestLL){bestLL=v;best=Math.round(e*100)/100;}}
  const n=hold.reduce((s,o)=>s+o.counts.reduce((a,b)=>a+b,0),0);
  const loss=n?-logLikelihood(hold,best)/n:null,baseline=n?-logLikelihood(hold,1)/n:null;
  return {exponent:loss!==null&&baseline!==null&&loss<baseline?best:1,loss,baseline,n};
 };
 const s=fit(shots),t=fit(trips),a=assists.length>=1000?fit(assists):{exponent:1,loss:null,baseline:null,n:0},r=rebounds.length>=1000?fit(rebounds):{exponent:1,loss:null,baseline:null,n:0};
 const status=[s,t,a,r].some(x=>x.exponent!==1)?'fitted':'unknown';
 return {status,shots:s.exponent,trips:t.exponent,assists:a.exponent,rebounds:r.exponent,stints:shots.length,heldout_events:s.n,log_loss:{shots:s.loss,trips:t.loss,assists:a.loss,rebounds:r.loss},baseline_log_loss:{shots:s.baseline,trips:t.baseline,assists:a.baseline,rebounds:r.baseline},reason:status==='fitted'?null:'Concentrated splitting did not beat proportional splitting on later games'};
}
