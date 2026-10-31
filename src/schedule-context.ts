import {chicagoDate} from './date.ts';
export function restDays(previous:string|null,tip:string):number|null {
  if(!previous)return null;
  const days=(Date.parse(chicagoDate(new Date(tip)))-Date.parse(chicagoDate(new Date(previous))))/86400000;
  return days>=1?days-1:null;
}

import type {CompletedEvent} from './parse-summary.ts';
export interface Venue {id:string|null;latitude:number|null;longitude:number|null;timezone:string|null}
export interface ScheduleContext {rest_days:number|null;back_to_back:boolean|null;previous_minutes:number|null;previous_end:string|null;travel_km:number|null;timezone_change_hours:number|null}
export const unknownVenue:Venue={id:null,latitude:null,longitude:null,timezone:null};
export function sourceVenue(value:unknown):Venue{
 const v=value&&typeof value==='object'?value as Record<string,unknown>:{},l=v.location&&typeof v.location==='object'?v.location as Record<string,unknown>:{};
 const coordinate=(x:unknown,limit:number)=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=limit?x:null;
 return {id:typeof v.id==='string'?v.id:null,latitude:coordinate(l.latitude,90),longitude:coordinate(l.longitude,180),timezone:typeof v.timezone==='string'?v.timezone:null};
}
function offset(timezone:string|null,time:string):number|null{
 if(!timezone)return null;
 try{const value=new Intl.DateTimeFormat('en-US',{timeZone:timezone,timeZoneName:'longOffset'}).formatToParts(new Date(time)).find(p=>p.type==='timeZoneName')?.value;if(value==='GMT')return 0;const match=value?.match(/^GMT([+-])(\d\d):(\d\d)$/);return match?(Number(match[2])+Number(match[3])/60)*(match[1]==='-'?-1:1):null;}catch{return null;}
}
export function scheduleContext(previous:CompletedEvent|null,tip:string,venue:Venue=unknownVenue):ScheduleContext{
 const rest=restDays(previous?.start_time??null,tip),from=previous?.play_history?.venue;
 let travel:number|null=null;
 if(from&&[from.latitude,from.longitude,venue.latitude,venue.longitude].every(x=>x!==null)){
  const rad=(x:number)=>x*Math.PI/180,lat1=rad(from.latitude!),lat2=rad(venue.latitude!),dl=rad(venue.longitude!-from.longitude!);
  const a=Math.sin((lat2-lat1)/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dl/2)**2;travel=6371*2*Math.asin(Math.sqrt(Math.min(1,a)));
 }
 const a=offset(from?.timezone??null,tip),b=offset(venue.timezone,tip);
 return {rest_days:rest,back_to_back:rest===null?null:rest===0,previous_minutes:previous?48+5*(previous.periods-4):null,previous_end:previous?.play_history?.final_observed_at??null,travel_km:travel,timezone_change_hours:a!==null&&b!==null?b-a:null};
}
