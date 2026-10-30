/** Stable encoding: object order is irrelevant; array order remains meaningful. */
export function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export interface GenerationManifest {schema_version:1;input_hash:string;model_hash:string;generated_at:string;slate_hash:string;card_hash:string}
export interface RefreshHealth {checked_at:string;input_hash:string;model_hash:string}
export function generationTime(previous:{input_hash?:string;model_hash?:string;generated_at:string|null}|null,inputHash:string,modelHash:string,now:string):string {
  return previous?.input_hash===inputHash&&previous.model_hash===modelHash&&previous.generated_at?previous.generated_at:now;
}
export function healthyCheck(health:RefreshHealth|null,card:{input_hash?:string;model_hash?:string},now:number):string|null {
  return health&&health.input_hash===card.input_hash&&health.model_hash===card.model_hash&&Number.isFinite(Date.parse(health.checked_at))&&Date.parse(health.checked_at)<=now+300000?health.checked_at:null;
}
