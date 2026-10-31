import {freeThrowTrips} from './play-history.ts';
import type {CompletedEvent} from './parse-summary.ts';
export interface FreeThrowModel {games:number;heldout_games:number;trip_weights:[number,number];and_one_per_make:number;technical_per_possession:number;holdout_trip_log_loss:number|null;status:'fitted'|'unknown';reason:string|null}
export function fitFreeThrows(events:CompletedEvent[]):FreeThrowModel{
 const samples=events.map(e=>({e,t:freeThrowTrips(e)})).filter(x=>x.t.status==='complete').sort((a,b)=>a.e.start_time.localeCompare(b.e.start_time));
 const empty:FreeThrowModel={games:samples.length,heldout_games:0,trip_weights:[1,0],and_one_per_make:0,technical_per_possession:0,holdout_trip_log_loss:null,status:'unknown',reason:'Fewer than 100 reconciled FT games; two-shot approximation remains a prior'};
 if(samples.length<100)return empty;
 const split=Math.floor(samples.length*.8),train=samples.slice(0,split),held=samples.slice(split);
 const estimate=(xs:typeof samples)=>{let two=1,three=1,andOne=0,technical=0,fgm=0,poss=0; // Beta(1,1) prior avoids a zero-probability trip class.
  for(const {e,t} of xs){for(const trip of t.trips){if(trip.kind==='technical')technical++;else if(trip.attempts===2)two++;else if(trip.attempts===3)three++;else if(trip.attempts===1&&trip.kind==='shooting')andOne++;}
   fgm+=e.players.reduce((s,p)=>s+p.fgm,0);poss+=e.players.reduce((s,p)=>s+p.fga+.44*p.fta-(p.orb??0)+(p.tov??0),0);
  }return {trip_weights:[two/(two+three),three/(two+three)] as [number,number],and_one_per_make:andOne/Math.max(1,fgm),technical_per_possession:technical/Math.max(1,poss)};
 };
 const prior=estimate(train),trips=held.flatMap(x=>x.t.trips).filter(t=>t.kind!=='technical'&&(t.attempts===2||t.attempts===3));
 return {...empty,...estimate(samples),heldout_games:held.length,holdout_trip_log_loss:trips.length?-trips.reduce((s,t)=>s+Math.log(prior.trip_weights[t.attempts-2]),0)/trips.length:null,status:'fitted',reason:null};
}
