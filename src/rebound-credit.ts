import type {CompletedEvent} from './parse-summary.ts';

/**
 * Box scores credit about 85 percent of non-offensive-rebound misses to a defender; the rest are team rebounds
 * (out of bounds, end of a period) that no player is credited with. Offensive rebound rates are already measured on
 * a credited basis.
 */
export interface ReboundCredit {status:'fitted'|'unknown';defensive:number;games:number;reason:string|null}
export const MIN_DEFENSIVE_CREDIT=0.5;

export function fitReboundCredit(events:CompletedEvent[]):ReboundCredit{
 let opportunities=0,offensive=0,defensive=0,games=0;
 for(const e of events){
  const plays=e.play_history?.plays;
  if(!plays?.length||e.players.some(p=>p.orb===undefined||p.drb===undefined))continue;
  games++;
  for(const [off,def] of [[e.home_team_id,e.away_team_id],[e.away_team_id,e.home_team_id]]){
   const missedFg=e.players.filter(p=>p.team_id===off).reduce((s,p)=>s+p.fga-p.fgm,0);
   const missedFinalFt=plays.filter(p=>p.team===off&&/free throw/i.test(p.type)&&!/technical/i.test(p.type)&&!p.made&&p.trip_attempt!==null&&p.trip_attempt===p.trip_size).length;
   opportunities+=missedFg+missedFinalFt;
   offensive+=e.players.filter(p=>p.team_id===off).reduce((s,p)=>s+(p.orb??0),0);
   defensive+=e.players.filter(p=>p.team_id===def).reduce((s,p)=>s+(p.drb??0),0);
  }
 }
 if(games<200||!(opportunities>offensive))return {status:'unknown',defensive:1,games,reason:'Fewer than 200 games with play histories and rebound splits'};
 const share=Math.min(1,Math.max(MIN_DEFENSIVE_CREDIT,defensive/(opportunities-offensive)));
 return {status:'fitted',defensive:share,games,reason:null};
}
