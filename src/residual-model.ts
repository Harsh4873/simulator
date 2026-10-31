import {fitTeamEffects,restDays} from './team-effects.ts';
import {scheduleContext} from './schedule-context.ts';
import type {CompletedEvent} from './parse-summary.ts';
const average=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length);
export function covariance(rows:[number,number][]):[[number,number],[number,number]]|null{
 if(rows.length<2)return null;
 const a=average(rows.map(x=>x[0])),b=average(rows.map(x=>x[1]));
 const aa=rows.reduce((s,x)=>s+(x[0]-a)**2,0)/(rows.length-1),bb=rows.reduce((s,x)=>s+(x[1]-b)**2,0)/(rows.length-1),ab=rows.reduce((s,x)=>s+(x[0]-a)*(x[1]-b),0)/(rows.length-1);
 return [[aa,ab],[ab,bb]];
}
export interface ResidualDiagnostics {
 status:'diagnostic'|'unknown';training_games:number;heldout_games:number;score_covariance:[[number,number],[number,number]]|null;efficiency_covariance:[[number,number],[number,number]]|null;
 margin_sd:number|null;total_sd:number|null;home_bias:number|null;away_bias:number|null;rested_bias:number|null;back_to_back_bias:number|null;reason:string;
}
/** Frozen earlier-block team fit; no held-out scores enter coefficients or pace estimates.
 * Covariance includes sampling noise. Adding it as an extra browser shock would double count variance.
 */
export function fitResidualDiagnostics(events:CompletedEvent[],possessions:(e:CompletedEvent,t:string)=>number):ResidualDiagnostics{
 const sorted=[...events].sort((a,b)=>a.start_time.localeCompare(b.start_time)||a.event_id.localeCompare(b.event_id)),split=Math.floor(sorted.length*.7),train=sorted.slice(0,split),hold=sorted.slice(split);
 const empty:ResidualDiagnostics={status:'unknown',training_games:train.length,heldout_games:hold.length,score_covariance:null,efficiency_covariance:null,margin_sd:null,total_sd:null,home_bias:null,away_bias:null,rested_bias:null,back_to_back_bias:null,reason:'Fewer than 100 training or 30 held-out games'};
 if(train.length<100||hold.length<30)return empty;
 const fit=fitTeamEffects(train,possessions),league=average(Object.values(fit.offense));
 const pace=(e:CompletedEvent)=>(possessions(e,e.home_team_id)+possessions(e,e.away_team_id))/2*48/(48+5*(e.periods-4));
 const leaguePace=average(train.map(pace)),teamPace=(team:string)=>{const xs=train.filter(e=>[e.home_team_id,e.away_team_id].includes(team));return (xs.reduce((s,e)=>s+pace(e),0)+12*leaguePace)/(xs.length+12);};
 const last=new Map<string,CompletedEvent>();for(const e of train)for(const t of [e.home_team_id,e.away_team_id])last.set(`${e.season}:${t}`,e);
 const scores:[number,number][]=[],efficiencies:[number,number][]=[],rested:number[]=[],b2b:number[]=[];
 for(const e of hold){
  const predictedPace=(teamPace(e.home_team_id)+teamPace(e.away_team_id))/2,actualPace=pace(e),factor=48/(48+5*(e.periods-4));
  const residual:number[]=[],eff:number[]=[];
  for(const [team,opponent,points,sign] of [[e.away_team_id,e.home_team_id,e.away_pts,-1],[e.home_team_id,e.away_team_id,e.home_pts,1]] as const){
   const prior=last.get(`${e.season}:${team}`),other=last.get(`${e.season}:${opponent}`),rest=restDays(prior?.start_time??null,e.start_time),opRest=restDays(other?.start_time??null,e.start_time);
   const a=scheduleContext(prior??null,e.start_time,e.play_history?.venue),b=scheduleContext(other??null,e.start_time,e.play_history?.venue);
   const workload=a.previous_minutes!==null&&b.previous_minutes!==null?(a.previous_minutes-b.previous_minutes)/5:0;
   const log=(e.neutral?0:sign*fit.home)+(rest!==null&&opRest!==null?fit.rest*(Math.log1p(rest)-Math.log1p(opRest)):0)+fit.workload*workload;
   const expectation=(fit.offense[team]??league)*(fit.defense[opponent]??league)/league*Math.exp(log);
   const r=points*factor-predictedPace*expectation;residual.push(r);eff.push(points*factor/actualPace-expectation);
   if(rest===0)b2b.push(r);else if(rest!==null)rested.push(r);
  }
  scores.push(residual as [number,number]);efficiencies.push(eff as [number,number]);
  for(const t of [e.home_team_id,e.away_team_id])last.set(`${e.season}:${t}`,e);
 }
 const matrix=covariance(scores)!;
 return {...empty,status:'diagnostic',score_covariance:matrix,efficiency_covariance:covariance(efficiencies),margin_sd:Math.sqrt(Math.max(0,matrix[0][0]+matrix[1][1]-2*matrix[0][1])),total_sd:Math.sqrt(Math.max(0,matrix[0][0]+matrix[1][1]+2*matrix[0][1])),home_bias:average(scores.map(x=>-x[1])),away_bias:average(scores.map(x=>-x[0])),rested_bias:rested.length?-average(rested):null,back_to_back_bias:b2b.length?-average(b2b):null,reason:'Observed residual covariance includes intrinsic possession noise; extra-shock and probability calibration require independent archived forecast outcomes'};
}
