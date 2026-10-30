import type {CompletedEvent} from './parse-summary.ts';
import type {ShootingRow} from './types.ts';
export function upsertEvents(events:CompletedEvent[],event:CompletedEvent):CompletedEvent[]{
  return [...events.filter(e=>e.event_id!==event.event_id),event].sort((a,b)=>a.start_time.localeCompare(b.start_time)||a.event_id.localeCompare(b.event_id));
}
export function aggregateShooting(events:CompletedEvent[]):ShootingRow[]{
  const rows=new Map<string,ShootingRow>();
  for(const e of [...events].sort((a,b)=>a.event_id.localeCompare(b.event_id)))for(const p of e.players){
    const key=`${e.season}:${p.team_id}:${p.athlete_id}`;
    const row=rows.get(key)??{season:e.season,team_id:p.team_id,athlete_id:p.athlete_id,games:0,minutes:0,fgm:0,fga:0,tpm:0,tpa:0,ftm:0,fta:0,pts:0,reb:0,ast:0};
    row.games++;
    for(const k of ['minutes','fgm','fga','tpm','tpa','ftm','fta','pts','reb','ast'] as const)row[k]+=p[k];
    rows.set(key,row);
  }
  return [...rows.values()].sort((a,b)=>a.season-b.season||a.team_id.localeCompare(b.team_id)||a.athlete_id.localeCompare(b.athlete_id));
}
export interface RetryRecord {failures:number;next_check:string;last_error:string}
export function pendingEvents(ids:string[],options:{now:string;dates:Map<string,string>;seasons:Map<string,number>;teams:Map<string,string[]>;slateTeams:string[];retries:Record<string,RetryRecord>;limit:number}):string[]{
  const {now,dates,seasons,teams,slateTeams,retries}=options;
  return [...new Set(ids)].filter(id=>!retries[id]||Date.parse(retries[id].next_check)<=Date.parse(now)).sort((a,b)=>{
    const knownA=dates.get(a),knownB=dates.get(b);
    return (seasons.get(b)??0)-(seasons.get(a)??0)||Number((teams.get(b)??[]).some(t=>slateTeams.includes(t)))-Number((teams.get(a)??[]).some(t=>slateTeams.includes(t)))||(knownA&&knownB?knownB.localeCompare(knownA):Number(!!knownB)-Number(!!knownA))||a.localeCompare(b);
  }).slice(0,Math.min(400,options.limit));
}
