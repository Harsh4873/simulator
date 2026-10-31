import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {ShootingCache} from '../src/types.ts';
import type {PlayHistory,HistoricalPlay} from '../src/play-history.ts';
type Row={event_id:string;start_time:string;home_pts:number;away_pts:number;history:PlayHistory};
// Fixed tuple columns remove repeated JSON keys; a dictionary removes repeated play labels.
const fields=['id','sequence','period','seconds','type','team','athletes','home','away','attempt','made','trip_attempt','trip_size','wallclock'] as const;
interface Packed {version:2;types:string[];ids?:string[];rows:[string,string,number,number,Omit<PlayHistory,'plays'>,unknown[][]][]}
export function encodePlayCache(rows:Row[]):Buffer {
 const types=[...new Set(rows.flatMap(r=>r.history.plays.map(p=>p.type)))].sort(),index=new Map(types.map((t,i)=>[t,i]));
 const ids=[...new Set(rows.flatMap(r=>r.history.plays.flatMap(p=>[...p.athletes,...(p.team?[p.team]:[])])))].sort(),idIndex=new Map(ids.map((id,i)=>[id,i]));
 const packed:Packed={version:2,types,ids,rows:[...rows].sort((a,b)=>a.event_id.localeCompare(b.event_id)).map(r=>{
  const h=r.history;
  const meta:Omit<PlayHistory,'plays'>={version:1,status:h.status,reason:h.reason,venue:{id:h.venue.id,latitude:h.venue.latitude,longitude:h.venue.longitude,timezone:h.venue.timezone},final_observed_at:h.final_observed_at};
  if(h.final_reconciled!==undefined)meta.final_reconciled=h.final_reconciled;
  let sequence=0;
  return [r.event_id,r.start_time,r.home_pts,r.away_pts,meta,h.plays.map(p=>{
   const tuple=fields.map(k=>k==='type'?index.get(p.type):k==='id'&&p.id===r.event_id+p.sequence?null:k==='sequence'?p.sequence-sequence:k==='team'?(p.team===null?null:idIndex.get(p.team)):k==='athletes'?p.athletes.map(id=>idIndex.get(id)):k==='wallclock'&&p.wallclock&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(p.wallclock)?Date.parse(p.wallclock)/1000:p[k]);
   sequence=p.sequence;return tuple;
  })];
 })};
 return gzipSync(JSON.stringify(packed),{level:9});
}
export function decodePlayCache(bytes:Buffer):Row[]{
 const data=JSON.parse(gunzipSync(bytes).toString('utf8')) as Row[]|Packed;
 if(Array.isArray(data))return data; // Read committed v1 caches during migration.
 if(data?.version!==2||!Array.isArray(data.types)||!Array.isArray(data.rows))throw new Error('Invalid play history cache');
 return data.rows.map(([event_id,start_time,home_pts,away_pts,meta,plays])=>{
  let sequence=0;
  return {event_id,start_time,home_pts,away_pts,history:{...meta,plays:plays.map(row=>{
   if(row.length!==fields.length)throw new Error('Invalid play tuple');
   const play=Object.fromEntries(fields.map((k,i)=>[k,k==='type'?data.types[row[i] as number]:row[i]])) as unknown as HistoricalPlay;
   if(data.ids){sequence+=play.sequence;play.sequence=sequence;if(play.id===null)play.id=event_id+sequence;play.team=play.team===null?null:data.ids[Number(play.team)];play.athletes=play.athletes.map(id=>data.ids![Number(id)]);if(typeof play.wallclock==='number')play.wallclock=new Date(play.wallclock*1000).toISOString().replace('.000Z','Z');}
   return play;
  })}};
 });
}
/** Build-only history stays outside public/ and dist/. */
export function attachPlayCache(cache:ShootingCache,boxPath:string):void{
 let bytes:Buffer;try{bytes=readFileSync(join(dirname(boxPath),'play-history.json.gz'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const byId=new Map(decodePlayCache(bytes).map(row=>[row.event_id,row]));
 for(const event of cache.events??[]){const row=byId.get(event.event_id);if(!event.play_history&&row?.start_time===event.start_time&&row.home_pts===event.home_pts&&row.away_pts===event.away_pts)event.play_history=row.history;}
}
export function savePlayCache(cache:ShootingCache,boxPath:string):ShootingCache{
 const rows=(cache.events??[]).filter(e=>e.play_history).map(e=>({event_id:e.event_id,start_time:e.start_time,home_pts:e.home_pts,away_pts:e.away_pts,history:e.play_history!}));
 const path=join(dirname(boxPath),'play-history.json.gz'),bytes=encodePlayCache(rows);
 let same=false;try{same=readFileSync(path).equals(bytes);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!same){writeFileSync(`${path}.tmp`,bytes);renameSync(`${path}.tmp`,path);}
 return {...cache,events:cache.events?.map(e=>{const {play_history:omitted,...box}=e;void omitted;return box;})};
}
