import { checkGeneration } from './helpers/check-generation.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {buildRateCard,eventOutcomes} from '../scripts/build-rate-card.ts';
import type {ShootingCache,Slate,RateCard} from '../src/types.ts';
test('full builder is byte-stable on identical inputs across clocks and fails closed on missing injuries',async(t)=>{
 const root=mkdtempSync(join(tmpdir(),'sim-builder-'));
 const originalFetch=globalThis.fetch;
 const card=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8')) as RateCard;
 const slate=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json','utf8')) as Slate;
 const game=slate.games[0],rate=card.games[0];
 const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
 // Real cached boxes, isolated fixture output; no live source requests.
 cache.events=cache.events!.filter(e=>Date.parse(e.start_time)<Date.parse('2026-10-30')).slice(-200);
 const outcome=gzipSync(eventOutcomes(cache.events).map(x=>JSON.stringify({...x,sport:'NBA'})).join('\n'));
 const scoreboard={events:[{id:game.event_id,date:'2026-10-31T00:00Z',season:{year:2027,type:2},competitions:[{status:{type:{state:'pre',completed:false}},competitors:[{homeAway:'away',team:{id:game.away.team_id,displayName:'Away'}},{homeAway:'home',team:{id:game.home.team_id,displayName:'Home'}}]}]}]};
 let broken=false, depleted=false;
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.endsWith('.gz'))return new Response(outcome);
  if(url.includes('/scoreboard'))return Response.json(scoreboard);
  if(url.endsWith('/injuries'))return Response.json(broken?{}:{injuries:depleted?[{injuries:rate.players.filter(p=>p.team_id===game.away.team_id).slice(4).map(p=>({athlete:{id:p.athlete_id},status:'out'}))}]:[]});
  if(url.endsWith('/teams'))return Response.json({sports:[{leagues:[{teams:[game.away,game.home].map(t=>({team:{id:t.team_id}}))}]}]});
  const team=url.match(/teams\/(\d+)\/roster/)?.[1];
  if(team)return Response.json({athletes:rate.players.filter(p=>p.team_id===team).map(p=>({id:p.athlete_id,displayName:p.name,position:{abbreviation:p.position}}))});
  throw new Error(`Unexpected request ${url}`);
 };
 try{
  mkdirSync(join(root,'data'),{recursive:true});mkdirSync(join(root,'public/data'),{recursive:true});writeFileSync(join(root,'data/shooting-cache.json'),JSON.stringify(cache));
  const run=(clock:string)=>buildRateCard({outputRoot:root,now:new Date(clock),summaryCap:0,generatorSha:'d47329bb94a845a366f9123d5828187bf1cf064d'});
  await run('2026-10-30T12:00Z');
  const files=['rate-card.json','slate.json','manifest.json'];const before=files.map(f=>readFileSync(join(root,'public/data',f),'utf8'));
  await run('2026-10-30T13:00Z');
  assert.deepEqual(files.map(f=>readFileSync(join(root,'public/data',f),'utf8')),before);
  assert.equal(JSON.parse(readFileSync(join(root,'.refresh-status.json'),'utf8')).checked_at,'2026-10-30T13:00:00Z');
  const poisoned=JSON.parse(before[0]);poisoned.generator_sha='local-uncommitted';writeFileSync(join(root,'public/data/rate-card.json'),JSON.stringify(poisoned));
  await run('2026-10-30T13:30Z');assert.deepEqual(files.map(f=>readFileSync(join(root,'public/data',f),'utf8')),before);
  broken=true;await assert.rejects(run('2026-10-30T14:00Z'),/injury/);
  assert.deepEqual(files.map(f=>readFileSync(join(root,'public/data',f),'utf8')),before);
  broken=false;
  await t.test('builder fills a thin rotation instead of failing when fewer than five healthy players remain',async()=>{
    depleted=true;await run('2026-10-30T15:00Z');
    const generated=await checkGeneration(join(root,'public'));
    assert.equal(generated.card.games[0].simulation_error,undefined);
    assert.equal(generated.card.games[0].thin_rotation,true);
    assert.ok(generated.card.games[0].players.some(p=>p.replacement_level));
    assert.equal(generated.slate.games.length,1);
  });
  await t.test('November 3 empty build replaces the previous date and passes publication and rendering checks',async()=>{
    depleted=false;scoreboard.events=[];
    await run('2026-11-03T14:00Z');
    const generated=await checkGeneration(join(root,'public'));
    assert.equal(generated.slate.date,'2026-11-03');
    assert.equal(generated.card.date,'2026-11-03');
    assert.deepEqual(generated.card.games,[]);assert.deepEqual(generated.slate.games,[]);
    const empty=files.map(f=>readFileSync(join(root,'public/data',f),'utf8'));
    await run('2026-11-03T15:00Z');
    assert.deepEqual(files.map(f=>readFileSync(join(root,'public/data',f),'utf8')),empty);
  });
 }finally{globalThis.fetch=originalFetch;rmSync(root,{recursive:true});}
});
