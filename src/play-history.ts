import {sourceVenue} from './schedule-context.ts';
import type {CompletedEvent} from './parse-summary.ts';
export interface HistoricalPlay {id:string;sequence:number;period:number;seconds:number;type:string;team:string|null;athletes:string[];home:number;away:number;attempt:number;made:boolean;trip_attempt:number|null;trip_size:number|null;wallclock:string|null}
export interface PlayHistory {version:1;status:'complete'|'partial'|'missing';reason:string|null;plays:HistoricalPlay[];venue:{id:string|null;latitude:number|null;longitude:number|null;timezone:string|null};final_observed_at:string|null;final_reconciled?:boolean}
const rec=(x:unknown):Record<string,unknown>=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:{};
export function parsePlayHistory(payload:unknown,event:CompletedEvent):PlayHistory{
 const root=rec(payload),venue=rec(rec(root.gameInfo).venue);
 const base={version:1 as const,venue:sourceVenue(venue),final_observed_at:null as string|null};
 if(!Array.isArray(root.plays)||!root.plays.length)return {...base,status:'missing',reason:'No play history',plays:[]};
 const plays:HistoricalPlay[]=[];const ids=new Set<string>();let bad=false;
 for(const raw of root.plays){
  const p=rec(raw),id=String(p.id??''),period=Number(rec(p.period).number),clockText=String(rec(p.clock).displayValue??''),clock=clockText.match(/^(\d+):(\d\d(?:\.\d+)?)$/),type=String(rec(p.type).text??'');
  const seconds=clock?Number(clock[1])*60+Number(clock[2]):/^\d+(?:\.\d+)?$/.test(clockText)?Number(clockText):NaN,sequence=Number(p.sequenceNumber);
  if(!id||ids.has(id)||!Number.isInteger(period)||period<1||!Number.isFinite(seconds)||seconds>(period<=4?720:300)||!Number.isFinite(sequence)||![p.homeScore,p.awayScore].every(x=>Number.isInteger(x)&&Number(x)>=0)){bad=true;continue;}
  ids.add(id);const trip=type.match(/Free Throw.*?(\d) of (\d)/i);
  plays.push({id,sequence,period,seconds,type,team:typeof rec(p.team).id==='string'?String(rec(p.team).id):null,athletes:Array.isArray(p.participants)?p.participants.map(a=>String(rec(rec(a).athlete).id??'')).filter(Boolean):[],home:Number(p.homeScore),away:Number(p.awayScore),attempt:Number(p.pointsAttempted??0),made:p.scoringPlay===true,trip_attempt:trip?Number(trip[1]):null,trip_size:trip?Number(trip[2]):null,wallclock:typeof p.wallclock==='string'&&Number.isFinite(Date.parse(p.wallclock))?p.wallclock:null});
 }
 plays.sort((a,b)=>a.sequence-b.sequence);
 const final=plays.at(-1);const end=!!final&&/end game/i.test(final.type)&&final.period===event.periods&&final.home===event.home_pts&&final.away===event.away_pts;
 const chronological=plays.every((p,i)=>!i||p.period>plays[i-1].period||(p.period===plays[i-1].period&&p.seconds<=plays[i-1].seconds));
 return {...base,final_reconciled:end,final_observed_at:end?final.wallclock:null,plays,status:!bad&&end&&chronological?'complete':'partial',reason:bad?'Malformed/duplicate plays':!end?'Final score/period not reconciled':!chronological?'Clock reversal':null};
}
export interface FreeThrowTrip {attempts:number;made:number;kind:'shooting'|'bonus'|'technical'|'take'|'flagrant'|'other';team:string;period:number;seconds:number;home_margin:number}
export function freeThrowTrips(event:CompletedEvent):{status:'complete'|'unknown';trips:FreeThrowTrip[]}{
 const history=event.play_history;if(!(history?.final_reconciled??!!history?.final_observed_at)||history.reason==='Malformed/duplicate plays')return {status:'unknown',trips:[]};
 const trips:FreeThrowTrip[]=[];const counted=new Map<string,number>();let foul='',foulPeriod=0,foulSeconds=-1,current:{key:string;expected:number;trip:FreeThrowTrip}|null=null;
 for(const p of history.plays){
  if(/foul/i.test(p.type)){foul=p.type.toLowerCase();foulPeriod=p.period;foulSeconds=p.seconds;}
  if(p.period!==foulPeriod||p.seconds!==foulSeconds)foul='';
  if(!/free throw/i.test(p.type))continue;
  const shooter=p.athletes[0];if(!shooter)return {status:'unknown',trips:[]};counted.set(shooter,(counted.get(shooter)??0)+1);
  const technical=/technical/i.test(p.type),size=technical?1:p.trip_size,attempt=technical?1:p.trip_attempt;
  if(!size||!attempt||size>3||attempt>size)return {status:'unknown',trips:[]};
  const key=`${p.period}:${p.seconds}:${shooter}`;
  if(attempt===1){if(current&&current.trip.attempts!==current.expected)return {status:'unknown',trips:[]};
   current={key,expected:size,trip:{attempts:0,made:0,kind:technical?'technical':foul.includes('shooting')?'shooting':['transition take foul','clear path foul'].includes(foul)?'take':foul.includes('flagrant')?'flagrant':size===2&&['personal foul','personal take foul','loose ball foul'].includes(foul)?'bonus':'other',team:p.team??event.players.find(x=>x.athlete_id===shooter)?.team_id??'',period:p.period,seconds:p.seconds,home_margin:p.home-p.away-(p.made?(p.team===event.home_team_id?1:-1):0)}};trips.push(current.trip);
  }
  if(!current||current.key!==key||attempt!==current.trip.attempts+1)return {status:'unknown',trips:[]};current.trip.attempts++;current.trip.made+=Number(p.made);
 }
 if(current&&current.expected!==current.trip.attempts||event.players.some(p=>(counted.get(p.athlete_id)??0)!==p.fta))return {status:'unknown',trips:[]};
 return {status:'complete',trips};
}
export interface HistoricalStint {period:number;seconds:number;end_seconds:number;away:string[];home:string[];away_points:number;home_points:number;start_margin:number}
/** Infer period starters only when observed substitutions/actions uniquely identify five players. */
export function historicalStints(event:CompletedEvent):{stints:HistoricalStint[];covered_seconds:number;total_seconds:number}{
 const result={stints:[] as HistoricalStint[],covered_seconds:0,total_seconds:(48+5*(event.periods-4))*60};
 if(!(event.play_history?.final_reconciled??!!event.play_history?.final_observed_at)||event.play_history.reason==='Malformed/duplicate plays')return result;
 const teamOf=new Map(event.players.map(p=>[p.athlete_id,p.team_id]));
 const plays=event.play_history.plays;
 let precedingHome=0,precedingAway=0;
 for(let period=1;period<=event.periods;period++){
  const ps=plays.filter(p=>p.period===period),initial=new Map<string,Set<string>>();let valid=ps.every((p,i)=>!i||p.seconds<=ps[i-1].seconds);
  for(const team of [event.away_team_id,event.home_team_id]){
   const starters=new Set<string>(period===1?event.players.filter(p=>p.team_id===team&&p.starter===true).map(p=>p.athlete_id):[]),entered=new Set<string>(),exited=new Set<string>();
   for(const p of ps){
    if(p.type==='Substitution'&&p.team===team){const [inside,outside]=p.athletes;if(!inside||!outside||teamOf.get(inside)!==team||teamOf.get(outside)!==team){valid=false;break;}if(!entered.has(outside))starters.add(outside);entered.add(inside);exited.add(outside);exited.delete(inside);}
    else if(!/technical|timeout|challenge|jumpball|end |violation/i.test(p.type)){for(const id of p.athletes){if(teamOf.get(id)!==team)continue;if(exited.has(id)){valid=false;break;}if(!entered.has(id))starters.add(id);}}
   }
   if(starters.size!==5)valid=false;initial.set(team,starters);
  }
  const away=new Set(initial.get(event.away_team_id)),home=new Set(initial.get(event.home_team_id));let seconds=period<=4?720:300,h=precedingHome,a=precedingAway,startH=h,startA=a,startSeconds=seconds;
  const periodStints:HistoricalStint[]=[];
  const close=(remaining:number)=>{if(startSeconds>remaining)periodStints.push({period,seconds:startSeconds-remaining,end_seconds:remaining,away:[...away].sort(),home:[...home].sort(),home_points:h-startH,away_points:a-startA,start_margin:startH-startA});startSeconds=remaining;startH=h;startA=a;};
  for(const p of ps){
   if(p.home<h||p.away<a)valid=false;
   if(p.type==='Substitution'){
    close(p.seconds);const on=p.team===event.away_team_id?away:home;const [inside,outside]=p.athletes;
    if(!on.has(outside)||on.has(inside))valid=false;on.delete(outside);on.add(inside);if(on.size!==5)valid=false;
   }
   h=p.home;a=p.away;seconds=p.seconds;
  }
  close(seconds);precedingHome=h;precedingAway=a;
  if(valid&&seconds===0){result.stints.push(...periodStints);result.covered_seconds+=periodStints.reduce((s,x)=>s+x.seconds,0);}
 }
 return result;
}
