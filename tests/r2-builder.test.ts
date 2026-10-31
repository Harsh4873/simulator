import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {buildRateCard,eventOutcomes} from '../scripts/build-rate-card.ts';
import type {ShootingCache,Slate,RateCard} from '../src/types.ts';
test('full builder is byte-stable on identical inputs across clocks and fails closed on missing injuries',async()=>{
 const root=mkdtempSync(join(tmpdir(),'sim-builder-'));
 const originalFetch=globalThis.fetch;
 const card=JSON.parse(readFileSync('public/data/rate-card.json','utf8')) as RateCard;
 const slate=JSON.parse(readFileSync('public/data/slate.json','utf8')) as Slate;
 const game=slate.games[0],rate=card.games[0];
 const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
 // Real cached boxes, isolated fixture output; no live source requests.
 cache.events=cache.events!.filter(e=>Date.parse(e.start_time)<Date.parse('2026-10-30')).slice(-200);
 const outcome=gzipSync(eventOutcomes(cache.events).map(x=>JSON.stringify({...x,sport:'NBA'})).join('\n'));
 const scoreboard={events:[{id:game.event_id,date:'2026-10-31T00:00Z',season:{year:2027,type:2},competitions:[{status:{type:{state:'pre',completed:false}},competitors:[{homeAway:'away',team:{id:game.away.team_id,displayName:'Away'}},{homeAway:'home',team:{id:game.home.team_id,displayName:'Home'}}]}]}]};
 let broken=false;
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.endsWith('.gz'))return new Response(outcome);
  if(url.includes('/scoreboard'))return Response.json(scoreboard);
  if(url.endsWith('/injuries'))return Response.json(broken?{}:{injuries:[]});
  if(url.endsWith('/teams'))return Response.json({sports:[{leagues:[{teams:[game.away,game.home].map(t=>({team:{id:t.team_id}}))}]}]});
  const team=url.match(/teams\/(\d+)\/roster/)?.[1];
  if(team)return Response.json({athletes:rate.players.filter(p=>p.team_id===team).map(p=>({id:p.athlete_id,displayName:p.name,position:{abbreviation:p.position}}))});
  throw new Error(`Unexpected request ${url}`);
 };
 try{
  mkdirSync(join(root,'data'),{recursive:true});mkdirSync(join(root,'public/data'),{recursive:true});writeFileSync(join(root,'data/shooting-cache.json'),JSON.stringify(cache));
  const run=(clock:string)=>buildRateCard({outputRoot:root,now:new Date(clock),summaryCap:0,generatorSha:'pending'});
  await run('2026-10-30T12:00Z');
  const files=['rate-card.json','slate.json','manifest.json'];const before=files.map(f=>readFileSync(join(root,'public/data',f),'utf8'));
  await run('2026-10-30T13:00Z');
  assert.deepEqual(files.map(f=>readFileSync(join(root,'public/data',f),'utf8')),before);
  assert.equal(JSON.parse(readFileSync(join(root,'.refresh-status.json'),'utf8')).checked_at,'2026-10-30T13:00:00Z');
  const poisoned=JSON.parse(before[0]);poisoned.generator_sha='local-uncommitted';writeFileSync(join(root,'public/data/rate-card.json'),JSON.stringify(poisoned));
  await run('2026-10-30T13:30Z');assert.deepEqual(files.map(f=>readFileSync(join(root,'public/data',f),'utf8')),before);
  broken=true;await assert.rejects(run('2026-10-30T14:00Z'),/injury/);
  assert.deepEqual(files.map(f=>readFileSync(join(root,'public/data',f),'utf8')),before);
 }finally{globalThis.fetch=originalFetch;rmSync(root,{recursive:true});}
});
