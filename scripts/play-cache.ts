import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {ShootingCache} from '../src/types.ts';
import type {PlayHistory} from '../src/play-history.ts';
/** Play histories are private to the build, compressed separately from inspectable boxes. */
export function attachPlayCache(cache:ShootingCache,boxPath:string):void{
 let bytes:Buffer;try{bytes=readFileSync(join(dirname(boxPath),'play-history.json.gz'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const rows=JSON.parse(gunzipSync(bytes).toString('utf8')) as {event_id:string;start_time:string;home_pts:number;away_pts:number;history:PlayHistory}[];
 if(!Array.isArray(rows))throw new Error('Invalid play history cache');
 const byId=new Map(rows.map(row=>[row.event_id,row]));
 for(const event of cache.events??[]){const row=byId.get(event.event_id);if(!event.play_history&&row?.start_time===event.start_time&&row.home_pts===event.home_pts&&row.away_pts===event.away_pts)event.play_history=row.history;}
}
export function savePlayCache(cache:ShootingCache,boxPath:string):ShootingCache{
 const rows=(cache.events??[]).filter(e=>e.play_history).map(e=>({event_id:e.event_id,start_time:e.start_time,home_pts:e.home_pts,away_pts:e.away_pts,history:e.play_history})).sort((a,b)=>a.event_id.localeCompare(b.event_id));
 const path=join(dirname(boxPath),'play-history.json.gz'),bytes=gzipSync(JSON.stringify(rows),{level:9});
 let same=false;try{same=readFileSync(path).equals(bytes);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!same){writeFileSync(`${path}.tmp`,bytes);renameSync(`${path}.tmp`,path);}
 return {...cache,events:cache.events?.map(e=>{const {play_history:omitted,...box}=e;void omitted;return box;})};
}
