import {historicalStints} from './play-history.ts';
import type {CompletedEvent} from './parse-summary.ts';
export interface UsageEffects {status:'fitted'|'unknown';games:number;heldout_shots:number;log_loss:number|null;baseline_log_loss:number|null;primary:Record<string,string>;roles:Record<string,'primary'|'secondary'|'support'>;multipliers:Record<string,number>;reason:string|null}
/** Off-court creator effects from verified stints; not a causal injury estimate. */
export function fitUsageEffects(events:CompletedEvent[]):UsageEffects{
 const groups=events.map(e=>({e,stints:historicalStints(e).stints})).filter(x=>x.stints.length).sort((a,b)=>a.e.start_time.localeCompare(b.e.start_time));
 const empty:UsageEffects={status:'unknown',games:groups.length,heldout_shots:0,log_loss:null,baseline_log_loss:null,primary:{},roles:{},multipliers:{},reason:'Insufficient verified on-court shot history'};
 if(groups.length<150)return empty;
 const split=Math.floor(groups.length*.8),train=groups.slice(0,split),hold=groups.slice(split),totals=new Map<string,{minutes:number;fga:number;games:number}>();
 for(const {e} of train)for(const p of e.players){const key=`${p.team_id}:${p.athlete_id}`,v=totals.get(key)??{minutes:0,fga:0,games:0};v.minutes+=p.minutes;v.fga+=p.fga;v.games++;totals.set(key,v);}
 const primary:Record<string,string>={},roles:UsageEffects['roles']={};
 for(const team of new Set(train.flatMap(x=>[x.e.home_team_id,x.e.away_team_id]))){const candidates=[...totals].filter(([k,v])=>k.startsWith(`${team}:`)&&v.games>=10&&v.minutes/v.games>=20).sort((a,b)=>b[1].fga/b[1].minutes-a[1].fga/a[1].minutes);if(!candidates.length)continue;primary[team]=candidates[0][0].split(':')[1];candidates.forEach(([key],i)=>roles[key]=i===0?'primary':i<3?'secondary':'support');}
 const rate=(team:string,id:string)=>{const row=totals.get(`${team}:${id}`);return row&&row.minutes>0?row.fga/row.minutes:null;};
 type Shot={keys:string[];weights:number[];shooter:number};
 const shots=(xs:typeof groups):Shot[]=>xs.flatMap(({e,stints})=>stints.flatMap(s=>{
  return (e.play_history?.plays??[]).filter(p=>p.period===s.period&&p.seconds<=s.end_seconds+s.seconds&&p.seconds>s.end_seconds&&[2,3].includes(p.attempt)&&!p.type.includes('Free Throw')).flatMap(p=>{
   if(!p.team||!primary[p.team])return [];const ids=p.team===e.home_team_id?s.home:p.team===e.away_team_id?s.away:[];if(!ids.length||ids.includes(primary[p.team]))return [];
   const weights=ids.map(id=>rate(p.team!,id));const shooter=ids.indexOf(p.athletes[0]);if(shooter<0||weights.some(w=>w===null||w<=0))return [];
   return [{keys:ids.map(id=>roles[`${p.team}:${id}`]??'support'),weights:weights as number[],shooter}];
  });
 }));
 const training=shots(train),validation=shots(hold);if(training.length<500||validation.length<100)return {...empty,primary,roles,heldout_shots:validation.length};
 const counts=new Map<string,{actual:number;expected:number}>();
 for(const shot of training){const sum=shot.weights.reduce((a,b)=>a+b,0);shot.keys.forEach((key,i)=>{const c=counts.get(key)??{actual:0,expected:0};c.actual+=Number(i===shot.shooter);c.expected+=shot.weights[i]/sum;counts.set(key,c);});}
 const multipliers=Object.fromEntries([...counts].map(([role,c])=>[role,(c.actual+30)/(c.expected+30)])); // 30-opportunity no-change prior.
 const loss=(adjust:boolean)=>validation.reduce((s,shot)=>{const weights=shot.weights.map((w,i)=>w*(adjust?multipliers[shot.keys[i]]??1:1));return s-Math.log(weights[shot.shooter]/weights.reduce((a,b)=>a+b,0));},0)/validation.length;
 const log_loss=loss(true),baseline_log_loss=loss(false);
 return {status:log_loss<baseline_log_loss?'fitted':'unknown',games:groups.length,heldout_shots:validation.length,log_loss,baseline_log_loss,primary,roles,multipliers,reason:log_loss<baseline_log_loss?null:'Creator-off-court adjustment did not improve chronological baseline'};
}
export function usageWeights(model:UsageEffects|undefined,team:string,ids:string[],weights:number[]):number[]{
 if(model?.status!=='fitted'||!model.primary[team]||ids.includes(model.primary[team]))return weights;
 return weights.map((w,i)=>w*(model.multipliers[model.roles[`${team}:${ids[i]}`]??'support']??1));
}
