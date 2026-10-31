import {freeThrowTrips} from './play-history.ts';
import type {CompletedEvent} from './parse-summary.ts';
export interface TripType {kind:'shooting'|'bonus'|'other';attempts:2|3;weight:number}
export interface FreeThrowModel {
 games:number;heldout_games:number;trip_weights:[number,number];and_one_per_make:number;technical_per_possession:number;holdout_trip_log_loss:number|null;status:'fitted'|'unknown';reason:string|null;
 trip_types?:TripType[];unknown_trip_fraction?:number;retained_per_possession?:number;retained_trip_weights?:[number,number,number];
 late?:{status:'fitted'|'unknown';share:number;baseline_share:number;heldout_events:number;log_loss:number;baseline_log_loss:number};
}
export function lateFoulState(period:number,seconds:number,offenseMargin:number):boolean{return period>=4&&seconds<=120&&offenseMargin>0&&offenseMargin<=8;}
export function fitFreeThrows(events:CompletedEvent[]):FreeThrowModel{
 const samples=events.map(e=>({e,t:freeThrowTrips(e)})).filter(x=>x.t.status==='complete').sort((a,b)=>a.e.start_time.localeCompare(b.e.start_time));
 const empty:FreeThrowModel={games:samples.length,heldout_games:0,trip_weights:[1,0],and_one_per_make:0,technical_per_possession:0,holdout_trip_log_loss:null,status:'unknown',reason:'Fewer than 100 reconciled FT games; two-shot approximation remains a prior'};
 if(samples.length<100)return empty;
 const split=Math.floor(samples.length*.8),train=samples.slice(0,split),held=samples.slice(split);
 const estimate=(xs:typeof samples)=>{
  let two=1,three=1,andOne=0,technical=0,fgm=0,poss=0,unknown=0,count=0;const retained=[0,0,0],types=new Map<string,TripType>();
  for(const {e,t} of xs){for(const trip of t.trips){count++;if(trip.kind==='other')unknown++;
   if(trip.kind==='technical')technical++;
   else if(trip.kind==='take'||trip.kind==='flagrant')retained[trip.attempts-1]++;
   else if(trip.attempts===2||trip.attempts===3){if(trip.attempts===2)two++;else three++;const kind=trip.kind==='bonus'?'bonus':trip.kind==='shooting'?'shooting':'other',key=`${kind}:${trip.attempts}`,v=types.get(key)??{kind,attempts:trip.attempts,weight:0};v.weight++;types.set(key,v);}
   else if(trip.attempts===1&&trip.kind==='shooting')andOne++;
  }
  fgm+=e.players.reduce((s,p)=>s+p.fgm,0);poss+=e.players.reduce((s,p)=>s+p.fga+.44*p.fta-(p.orb??0)+(p.tov??0),0);}
  const total=[...types.values()].reduce((s,t)=>s+t.weight,0),r=retained.reduce((a,b)=>a+b,0);
  return {trip_weights:[two/(two+three),three/(two+three)] as [number,number],trip_types:[...types.values()].map(t=>({...t,weight:t.weight/Math.max(1,total)})),unknown_trip_fraction:unknown/Math.max(1,count),and_one_per_make:andOne/Math.max(1,fgm),technical_per_possession:technical/Math.max(1,poss),retained_per_possession:r/Math.max(1,poss),retained_trip_weights:retained.map(n=>r?n/r:0) as [number,number,number]};
 };
 // Compare late leading-team FT-trip share with the global terminal-opportunity baseline.
 // State boundaries are declared basketball scenarios, not optimized against the held-out block.
 const opportunities=(xs:typeof samples)=>xs.flatMap(({e,t})=>{
  const rows:{free:boolean;late:boolean}[]=[];
  for(const p of e.play_history!.plays)if([2,3].includes(p.attempt)&&!p.type.includes('Free Throw')){const margin=p.home-p.away-(p.made?(p.team===e.home_team_id?p.attempt:-p.attempt):0);rows.push({free:false,late:lateFoulState(p.period,p.seconds,p.team===e.home_team_id?margin:-margin)});}
  for(const trip of t.trips)if(trip.attempts>=2&&!['technical','take','flagrant'].includes(trip.kind))rows.push({free:true,late:lateFoulState(trip.period,trip.seconds,trip.team===e.home_team_id?trip.home_margin:-trip.home_margin)});
  return rows;
 });
 const training=opportunities(train),validation=opportunities(held).filter(x=>x.late),lateTrain=training.filter(x=>x.late);
 const base=(1+training.filter(x=>x.free).length)/(2+training.length),share=(20*base+lateTrain.filter(x=>x.free).length)/(20+lateTrain.length); // 20-opportunity no-state-effect prior.
 const loss=(p:number)=>validation.reduce((s,x)=>s-Math.log(x.free?p:1-p),0)/Math.max(1,validation.length);
 const log_loss=loss(share),baseline_log_loss=loss(base),late={status:lateTrain.length>=100&&validation.length>=30&&log_loss<baseline_log_loss?'fitted' as const:'unknown' as const,share,baseline_share:base,heldout_events:validation.length,log_loss,baseline_log_loss};
 const prior=estimate(train),trips=held.flatMap(x=>x.t.trips).filter(t=>!['technical','take','flagrant'].includes(t.kind)&&(t.attempts===2||t.attempts===3));
 // Keep fitted coefficients frozen on training; held-out FT outcomes are evaluation only.
 return {...empty,...prior,late,heldout_games:held.length,holdout_trip_log_loss:trips.length?-trips.reduce((s,t)=>s+Math.log(prior.trip_weights[t.attempts-2]),0)/trips.length:null,status:'fitted',reason:null};
}
