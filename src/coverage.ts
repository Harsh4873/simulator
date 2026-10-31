import type {CompletedEvent} from './parse-summary.ts';
import {historicalStints,freeThrowTrips} from './play-history.ts';
import type {RetryRecord} from './event-cache.ts';
export interface TeamCoverage {
 team_id:string;regular_games:number;current_season_games:number;play_history_games:number;latest_completed_start:string|null;players_without_shooting:number;
 authorized_events:number;missing_summaries:number;unknown_dates:number;oldest_missing_start:string|null;deferred_retries:number;
 reconciled_ft_games:number;full_lineup_games:number;explicit_participation_games:number;
 seasons:{season:number;authorized_events:number;completed_summaries:number;regular_games:number;missing_summaries:number}[];
}
/** Denominator is authorized outcome IDs, never an assertion of complete league history. */
export function teamCoverage(teamIds:string[],events:CompletedEvent[],expected:{teams:Map<string,string[]>;seasons:Map<string,number>;dates:Map<string,string>;retries:Record<string,RetryRecord>},season:number,now:string,players:{team_id:string;shooting_games:number}[]):TeamCoverage[]{
 const ids=new Set(events.map(e=>e.event_id));
 return [...teamIds].sort().map(team=>{
  const all=events.filter(e=>[e.home_team_id,e.away_team_id].includes(team)),xs=all.filter(e=>e.season_type===2);
  const authorized=[...expected.seasons.keys()].filter(id=>expected.teams.get(id)?.includes(team)),missing=authorized.filter(id=>!ids.has(id));
  return {team_id:team,regular_games:xs.length,current_season_games:xs.filter(e=>e.season===season).length,play_history_games:xs.filter(e=>(e.play_history?.final_reconciled??!!e.play_history?.final_observed_at)).length,latest_completed_start:xs.map(e=>e.start_time).sort().at(-1)??null,players_without_shooting:players.filter(p=>p.team_id===team&&p.shooting_games===0).length,
   authorized_events:authorized.length,missing_summaries:missing.length,unknown_dates:missing.filter(id=>!expected.dates.has(id)).length,oldest_missing_start:missing.map(id=>expected.dates.get(id)).filter((x):x is string=>!!x).sort()[0]??null,deferred_retries:missing.filter(id=>Date.parse(expected.retries[id]?.next_check)>Date.parse(now)).length,
   reconciled_ft_games:xs.filter(e=>freeThrowTrips(e).status==='complete').length,full_lineup_games:xs.filter(e=>historicalStints(e).covered_seconds===(48+5*(e.periods-4))*60).length,explicit_participation_games:xs.filter(e=>e.participation?.some(p=>p.team_id===team)).length,
   seasons:[...new Set(authorized.map(id=>expected.seasons.get(id)!))].sort().map(s=>({season:s,authorized_events:authorized.filter(id=>expected.seasons.get(id)===s).length,completed_summaries:all.filter(e=>e.season===s).length,regular_games:xs.filter(e=>e.season===s).length,missing_summaries:missing.filter(id=>expected.seasons.get(id)===s).length}))};
 });
}
