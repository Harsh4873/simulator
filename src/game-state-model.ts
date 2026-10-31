import {historicalStints} from './play-history.ts';
import type {CompletedEvent} from './parse-summary.ts';
export interface RotationStateModel {status:'fitted'|'unknown';games:number;heldout_games:number;shares:Record<string,number>;baseline:Record<string,number>;log_loss:number|null;baseline_log_loss:number|null;reason:string|null}
// Declared score/time strata. They are never selected against held-out outcomes.
export function rotationStateKey(minute:number,margin:number):string{return `${minute<42?'early':'late'}:${Math.abs(margin)<=5?'close':Math.abs(margin)<15?'middle':'large'}`;}
export function fitRotationState(events:CompletedEvent[]):RotationStateModel{
 const groups=events.map(e=>({e,stints:historicalStints(e).stints})).filter(x=>x.stints.length&&x.e.players.filter(p=>p.starter).length===10).sort((a,b)=>a.e.start_time.localeCompare(b.e.start_time));
 const empty:RotationStateModel={status:'unknown',games:groups.length,heldout_games:0,shares:{},baseline:{},log_loss:null,baseline_log_loss:null,reason:'Insufficient observed score/rotation histories'};
 if(groups.length<100)return empty;
 const split=Math.floor(groups.length*.8);
 const rows=(xs:typeof groups)=>xs.flatMap(({e,stints})=>{
  const starters=new Set(e.players.filter(p=>p.starter).map(p=>p.athlete_id));
  return stints.flatMap(s=>{
   if(s.period>4)return [];
   const minute=(s.period-1)*12+(720-s.end_seconds-s.seconds)/60;
   return [{key:rotationStateKey(minute,s.start_margin),w:s.seconds/60,starters:[...s.away,...s.home].filter(id=>starters.has(id)).length}];
  });
 });
 const train=rows(groups.slice(0,split)),hold=rows(groups.slice(split)),counts:Record<string,{yes:number;n:number}>={},base:typeof counts={};
 for(const r of train){for(const [map,key] of [[counts,r.key],[base,r.key.split(':')[0]]] as const){const v=map[key]??{yes:0,n:0};v.yes+=r.w*r.starters;v.n+=10*r.w;map[key]=v;}}
 const baseline=Object.fromEntries(Object.entries(base).map(([k,v])=>[k,(v.yes+1)/(v.n+2)]));
 const shares=Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,(v.yes+100*baseline[k.split(':')[0]])/(v.n+100)])); // 100-player-minute baseline prior.
 const loss=(state:boolean)=>hold.reduce((s,r)=>{const p=state?shares[r.key]??baseline[r.key.split(':')[0]]:baseline[r.key.split(':')[0]];return s-r.w*(r.starters*Math.log(p)+(10-r.starters)*Math.log(1-p));},0)/hold.reduce((s,r)=>s+10*r.w,0);
 const log_loss=loss(true),baseline_log_loss=loss(false),pass=Number.isFinite(log_loss)&&log_loss<baseline_log_loss;
 return {...empty,status:pass?'fitted':'unknown',heldout_games:groups.length-split,shares,baseline,log_loss,baseline_log_loss,reason:pass?null:'Score-dependent rotations did not beat the untouched time-only baseline'};
}
export interface FoulModel {status:'fitted'|'unknown';games:number;heldout_minutes:number;probabilities:number[];by_count:Record<string,number[]>;conditional:boolean;log_loss:number|null;baseline_log_loss:number|null;reason:string|null}
export function personalFoul(type:string):boolean{return /foul/i.test(type)&&!/technical|double|team|violation|turnover/i.test(type);}
export function foulExposureRows(e:CompletedEvent):{before:number;minutes:number;count:number}[]{
 const stints=historicalStints(e).stints,plays=(e.play_history?.plays??[]).filter(p=>personalFoul(p.type)&&p.athletes[0]);
 // Assign a boundary foul once, including the outgoing player's last instant on court.
 const owner=plays.map(p=>stints.findIndex(s=>s.period===p.period&&s.end_seconds<=p.seconds&&p.seconds<=s.end_seconds+s.seconds&&[...s.home,...s.away].includes(p.athletes[0])));
 return stints.flatMap((s,index)=>[...s.home,...s.away].flatMap(id=>{
  const start=s.end_seconds+s.seconds,own=plays.map((p,i)=>({p,owner:owner[i]})).filter(x=>x.p.athletes[0]===id);
  let before=own.filter(x=>x.p.period<s.period||x.p.period===s.period&&(x.p.seconds>start||x.p.seconds===start&&x.owner>=0&&x.owner<index)).length,clock=start;
  const rows:{before:number;minutes:number;count:number}[]=[];
  for(const {p} of own.filter(x=>x.owner===index).sort((a,b)=>b.p.seconds-a.p.seconds||a.p.sequence-b.p.sequence)){
   if(before<6)rows.push({before,minutes:(clock-p.seconds)/60,count:1});before++;clock=p.seconds;
  }
  if(before<6&&clock>s.end_seconds)rows.push({before,minutes:(clock-s.end_seconds)/60,count:0});
  return rows;
 }));
}
export function fitFouls(events:CompletedEvent[]):FoulModel{
 const groups=events.filter(e=>{
  if(!e.play_history?.final_reconciled)return false;
  const counts=new Map<string,number>();for(const p of e.play_history.plays)if(personalFoul(p.type)&&p.athletes[0])counts.set(p.athletes[0],(counts.get(p.athletes[0])??0)+1);
  return e.players.every(p=>p.fouls!==undefined&&(counts.get(p.athlete_id)??0)===p.fouls);
 }).sort((a,b)=>a.start_time.localeCompare(b.start_time));
 const empty:FoulModel={status:'unknown',games:groups.length,heldout_minutes:0,probabilities:[1,0,0,0,0,0,0],by_count:{},conditional:false,log_loss:null,baseline_log_loss:null,reason:'Fewer than 100 box-reconciled personal-foul histories'};
 if(groups.length<100)return empty;
 const rows=(xs:CompletedEvent[])=>xs.flatMap(foulExposureRows);
 const split=Math.floor(groups.length*.8),train=rows(groups.slice(0,split)),held=rows(groups.slice(split));
 const exposure=train.reduce((s,r)=>s+r.minutes,0),heldExposure=held.reduce((s,r)=>s+r.minutes,0);
 if(exposure<1000||heldExposure<100)return empty;
 const base=train.reduce((s,r)=>s+r.count,0)/exposure,counts:Record<string,{n:number;minutes:number}>={};
 for(const r of train){const c=counts[r.before]??{n:0,minutes:0};c.n+=r.count;c.minutes+=r.minutes;counts[r.before]=c;}
 const rates=Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,(v.n+100*base)/(v.minutes+100)])); // 100-player-minute pooled-rate prior.
 const loss=(conditional:boolean)=>held.reduce((s,r)=>{const rate=conditional?rates[r.before]??base:base;return s+rate*r.minutes-r.count*Math.log(rate);},0)/heldExposure;
 const probabilitiesFor=(rate:number)=>{const p=[Math.exp(-rate)];for(let i=1;i<6;i++)p.push(p[i-1]*rate/i);p.push(Math.max(0,1-p.reduce((a,b)=>a+b,0)));return p;};
 const probabilities=probabilitiesFor(base),by_count=Object.fromEntries(Object.entries(rates).map(([k,rate])=>[k,probabilitiesFor(rate)]));
 const log_loss=loss(true),baseline_log_loss=loss(false);
 return {status:'fitted',games:groups.length,heldout_minutes:heldExposure,probabilities,by_count,conditional:log_loss<baseline_log_loss,log_loss,baseline_log_loss,reason:log_loss<baseline_log_loss?null:'Foul-count conditioning did not beat the empirical pooled baseline; using pooled observed rate'};
}
