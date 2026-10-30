import type {RateCard,Slate} from './types.ts';
import {validateGeneration} from './validate-card.ts';
export interface ForecastArchive {slate:Slate;card:RateCard;source_lineage?:{input_hash:string;model_hash:string;maximum_event_start:string|null;training_event_ids:string[]}}
export function archivedForecast(archives:ForecastArchive[],eventId:string,tip:string,version:string):ForecastArchive|null{
 const valid=archives.filter(a=>{
  try{validateGeneration(a.slate,a.card);}catch{return false;}
  const cutoff=a.card.generated_at;
  const game=a.slate.games.find(g=>g.event_id===eventId);
  if(!cutoff||!game||game.start_time!==tip||Date.parse(cutoff)>=Date.parse(tip)||a.card.model_version!==version)return false;
  const lineage=a.source_lineage;
  return !!lineage&&a.card.input_hash===lineage.input_hash&&a.card.model_hash===lineage.model_hash&&!lineage.training_event_ids.includes(eventId)&&(!lineage.maximum_event_start||Date.parse(lineage.maximum_event_start)<Date.parse(cutoff));
 });
 return valid.sort((a,b)=>Date.parse(b.card.generated_at!)-Date.parse(a.card.generated_at!))[0]??null;
}
