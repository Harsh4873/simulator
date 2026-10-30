import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical,generationTime,healthyCheck} from '../src/generation.ts';
import {upsertEvents,aggregateShooting,pendingEvents} from '../src/event-cache.ts';
import {loadGeneration} from '../src/load-generation.ts';
import {deployAndWait} from '../scripts/deploy-and-wait.mjs';
import {monitor,refreshIssue} from '../scripts/check-freshness.mjs';
import type {ShootingCache} from '../src/types.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
test('canonical input identity survives a check with a different clock',()=>{
 assert.equal(canonical({a:1,b:{x:2,y:3}}),canonical({b:{y:3,x:2},a:1}));
 const previous={input_hash:'a',model_hash:'b',generated_at:'2026-10-30T12:00:00Z'};
 assert.equal(generationTime(previous,'a','b','2026-10-30T13:00:00Z'),previous.generated_at);
 assert.notEqual(generationTime(previous,'a','c','2026-10-30T13:00:00Z'),previous.generated_at);
 assert.equal(healthyCheck({input_hash:'wrong',model_hash:'b',checked_at:'2026-10-30T13:00:00Z'},previous,Date.parse('2026-10-30T14:00Z')),null);
});
test('duplicate and corrected events aggregate exactly as a clean rebuild',()=>{
 const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
 const e=cache.events![0],corrected=structuredClone(e);corrected.players[0].ast++;
 const twice=upsertEvents(upsertEvents([],e),e);
 assert.equal(twice.length,1);
 assert.deepEqual(aggregateShooting(twice),aggregateShooting([e]));
 assert.deepEqual(aggregateShooting(upsertEvents(twice,corrected)),aggregateShooting([corrected]));
});
test('backlog ordering honors dates/seasons, authorized IDs, retries, and cap',()=>{
 const options={now:'2026-10-30T12:00Z',dates:new Map([['9','2026-10-28'],['2','2026-10-29']]),seasons:new Map([['9',2027],['2',2027],['999',2026]]),teams:new Map<string,string[]>(),slateTeams:[],retries:{},limit:400};
 assert.deepEqual(pendingEvents(['999','9','2'],options),['2','9','999']);
 assert.deepEqual(pendingEvents(['9','2'],{...options,retries:{'2':{failures:2,next_check:'2026-10-31',last_error:'partial'}}}),['9']);
 assert.equal(pendingEvents(Array.from({length:500},(_,i)=>String(i)),options).length,400);
});
test('mixed manifests retry coherently and malformed versions fail closed',async()=>{
 const slate=readFileSync('public/data/slate.json','utf8'),card=readFileSync('public/data/rate-card.json','utf8'),c=JSON.parse(card);
 const manifest={schema_version:1,input_hash:c.input_hash,model_hash:c.model_hash,generated_at:c.generated_at,slate_hash:hash(slate),card_hash:hash(card)};
 let attempts=0;
 const result=await loadGeneration(async name=>name==='slate.json'?slate:name==='rate-card.json'?card:name==='manifest.json'?JSON.stringify({...manifest,card_hash:attempts++===0?'bad':manifest.card_hash}):null,async s=>hash(s));
 assert.equal(result.card.generated_at,c.generated_at);assert.equal(attempts,2);
 await assert.rejects(()=>loadGeneration(async name=>name==='slate.json'?slate:name==='rate-card.json'?JSON.stringify({...c,model_version:'unknown'}):null,async s=>hash(s)),/Unsupported/);
});
test('dispatch failure, failure after dispatch, cancellation, timeout and unchanged-data recovery',async()=>{
 const sha='a'.repeat(40),request='test';
 await assert.rejects(deployAndWait({sha,request,api:async()=>{throw new Error('dispatch failed');}}),/dispatch failed/);
 for(const conclusion of ['failure','cancelled'])await assert.rejects(deployAndWait({sha,request,api:async(_p:string,b:unknown)=>b?null:{workflow_runs:[{display_title:request,status:'completed',conclusion}]}}),new RegExp(conclusion));
 let clock=0;
 await assert.rejects(deployAndWait({sha,request,api:async(_p:string,b:unknown)=>b?null:{workflow_runs:[]},now:()=>clock,sleep:async()=>{clock+=15000;},timeout:20000}),/Timed out/);
 const api=async(_p:string,b:unknown)=>b?null:{workflow_runs:[{display_title:request,id:1,status:'completed',conclusion:'success'}]};
 assert.equal((await deployAndWait({sha,request,api})).sha,sha);
 assert.equal((await deployAndWait({sha,request,api})).sha,sha);
});
test('missed runs and failed publications alert with bounded recovery',async()=>{
 const now=Date.parse('2026-10-30T16:00Z');let dispatched=0;
 const stale=[{created_at:'2026-10-30T10:00Z',status:'completed',conclusion:'success'}];
 assert.match(refreshIssue(stale,now)!,/Missed/);
 const api=async(_p:string,b:unknown)=>b?(dispatched++,null):{workflow_runs:stale};
 assert.equal((await monitor(api,now)).recovery,true);assert.equal(dispatched,1);
 stale.push({created_at:'2026-10-30T15:55Z',status:'queued',conclusion:''});
 assert.equal((await monitor(api,now)).recovery,false);assert.equal(dispatched,1);
});
test('market observations are pretip validation records, never asserted closing lines',async()=>{
 const {marketObservations,pairedMarketProbability}=await import('../src/market-evaluation.ts');
 const payload={events:[{id:'e',date:'2026-10-30T23:00Z',competitions:[{odds:[{provider:{name:'fixture'},moneyline:{home:{close:{odds:'-110'}},away:{close:{odds:'-110'}}},pointSpread:{home:{close:{line:'-2.5'}}},overUnder:225}]}]}]};
 const q=marketObservations(payload,'2026-10-30T22:00Z')[0];assert.equal(q.closing_confirmed,false);assert.equal(q.home_spread,-2.5);assert.equal(pairedMarketProbability(q,'e',q.tip),.5);
 assert.deepEqual(marketObservations(payload,'2026-10-30T23:00Z'),[]);assert.equal(pairedMarketProbability({...q,away_moneyline:null},'e',q.tip),null);
});
test('archives reject target-event leakage, future cutoff and missing source lineage',async()=>{
 const {archivedForecast}=await import('../src/forecast-archive.ts');
 const slate=JSON.parse(readFileSync('public/data/slate.json','utf8')),card=JSON.parse(readFileSync('public/data/rate-card.json','utf8'));
 const game=slate.games[0];
 const archive={slate,card,source_lineage:{input_hash:card.input_hash,model_hash:card.model_hash,maximum_event_start:'2026-10-28T00:00:00Z',training_event_ids:[] as string[]}};
 assert.ok(archivedForecast([archive],game.event_id,game.start_time,card.model_version));
 const leaked=structuredClone(archive);leaked.source_lineage.training_event_ids.push(game.event_id);assert.equal(archivedForecast([leaked],game.event_id,game.start_time,card.model_version),null);
 const future=structuredClone(archive);future.card.generated_at=game.start_time;future.slate.generated_at=game.start_time;assert.equal(archivedForecast([future],game.event_id,game.start_time,card.model_version),null);
 assert.equal(archivedForecast([{slate,card}],game.event_id,game.start_time,card.model_version),null);
});
test('workflow action revisions and Node runtime are pinned and updates are configured',async()=>{
 const {readdirSync}=await import('node:fs');
 for(const file of readdirSync('.github/workflows')){
  const text=readFileSync(`.github/workflows/${file}`,'utf8');
  for(const action of text.matchAll(/uses:\s*(\S+)/g))assert.match(action[1],/^actions\/[\w-]+@[a-f0-9]{40}$/);
  assert.ok(!/node-version:\s*"22"/.test(text));
 }
 assert.match(readFileSync('.github/dependabot.yml','utf8'),/github-actions/);
});
