import {assignInjury} from './fit.ts';
import {archivedForecast,type ForecastArchive} from './forecast-archive.ts';
import type {CompletedEvent} from './parse-summary.ts';
import type {AvailabilityObservation} from './model-evidence.ts';
/** Pair only actually archived pre-tip reports with a source-observed final timestamp. */
export function availabilityHistory(archives:ForecastArchive[],events:CompletedEvent[],cutoff:string):AvailabilityObservation[]{
 const rows:AvailabilityObservation[]=[];
 for(const event of events){
  const final=event.play_history?.final_observed_at;if(!final||Date.parse(final)>=Date.parse(cutoff))continue;
  const archive=archives.filter(a=>a.card?.generated_at&&Date.parse(a.card.generated_at)<Date.parse(event.start_time)&&a.slate?.games.some(g=>g.event_id===event.event_id&&g.start_time===event.start_time)&&a.source_lineage?.roster&&a.source_lineage?.injuries).sort((a,b)=>Date.parse(b.card.generated_at!)-Date.parse(a.card.generated_at!))[0];
  if(!archive||archivedForecast([archive],event.event_id,event.start_time,archive.card.model_version??'')!==archive)continue;
  for(const roster of archive.source_lineage!.roster!){
   if(![event.home_team_id,event.away_team_id].includes(roster.team_id))continue;
   if(archive.source_lineage!.roster!.filter(p=>p.athlete_id===roster.athlete_id).length!==1)continue;
   const injury=archive.source_lineage!.injuries!.find(i=>i.athlete_id===roster.athlete_id);
   if(injury?.reported_at&&Date.parse(injury.reported_at)>Date.parse(archive.card.generated_at!))continue;
   const actual=event.players.find(p=>p.athlete_id===roster.athlete_id&&p.team_id===roster.team_id);
   const forecast=archive.card.games.find(g=>g.event_id===event.event_id)?.players.find(p=>p.athlete_id===roster.athlete_id);
   rows.push({event_id:event.event_id,athlete_id:roster.athlete_id,report_at:archive.card.generated_at!,tip:event.start_time,settled_at:final,designation:assignInjury(injury?.status??'').injury_status,played:!!actual,minutes:actual?.minutes??0,expected_minutes:forecast?.minutes_mean,roster_known:true});
  }
 }
 return rows;
}
