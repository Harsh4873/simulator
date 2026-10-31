import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateGeneration, freshnessIssue } from '../src/validate-card.ts';
import { gzipSync } from 'node:zlib';
import { buildRateCard, fetchWithRetry, parseInjuries, parseOutcomeLines, gamesFromScoreboard } from '../scripts/build-rate-card.ts';
import { parseCompletedSummary } from '../src/parse-summary.ts';
import type { RateCard, Slate } from '../src/types.ts';
const load = () => ({ card: JSON.parse(readFileSync('public/data/rate-card.json','utf8')) as RateCard, slate: JSON.parse(readFileSync('public/data/slate.json','utf8')) as Slate });
test('generation requires every matchup, unique identities, feasible rosters and finite rates', () => {
  for (const mutate of [
    (c: RateCard) => { c.games[0].players = []; },
    (c: RateCard) => { c.games[0].players[0].fga_per_min = NaN; },
    (c: RateCard) => { c.games[0].players.push(c.games[0].players[0]); },
    (c: RateCard) => { c.games.pop(); },
    (c: RateCard) => { c.generated_at = '2000-01-01T00:00:00Z'; },
    (c: RateCard) => { c.games[0].players.forEach(p => {p.minutes_weight = 0;}); },
  ]) { const {card,slate} = load(); mutate(card); assert.throws(() => validateGeneration(slate,card)); }
});
test('invalid scoreboard and injury payloads fail closed; explicit empty report is valid', () => {
  for (const p of [null, {}, {injuries: null}, {injuries: [{}]}]) assert.throws(() => parseInjuries(p));
  assert.deepEqual(parseInjuries({injuries: []}), []);
  assert.throws(() => gamesFromScoreboard({},'2026-10-30',[]));
});
test('outcomes reject missing, conflicting, pending and negative values and deduplicate', () => {
  const row = {sport:'NBA',season:2027,event_id:'1',athlete_id:'2',team_id:'3',stat_key:'points',actual:4,minutes:12};
  const parse = (rows: unknown[]) => parseOutcomeLines(rows.map(r => JSON.stringify(r)).join('\n'));
  assert.equal(parse([row,row]).length,1);
  assert.equal(parse([row,{...row,actual:5}]).length,0);
  for (const bad of [{actual:null},{actual:-1},{minutes:-1},{status:'pending'}]) assert.equal(parse([{...row,...bad}]).length,0);
});
test('incomplete summaries never qualify as completed events', () => {
  for (const s of [{}, {boxscore:{players:[]}}, JSON.parse(readFileSync('tests/fixtures/summary-event.json','utf8'))]) assert.throws(() => parseCompletedSummary(s,'1'));
});
test('stale and mismatched generations are gated', () => {
  const {card,slate} = load();
  assert.equal(freshnessIssue(slate,card,new Date(card.generated_at!)),null);
  assert.match(freshnessIssue(slate,card,new Date(Date.parse(card.generated_at!)+86400000))!,/Stale/);
});

test('completed summary rejects partial finals and retains every parsed stat',()=>{
  const fixture=JSON.parse(readFileSync('tests/fixtures/summary-event.json','utf8'));
  const player=fixture.boxscore.players[0].statistics[0].athletes[0];
  const team=(id:string)=>({team:{id},statistics:[{keys:fixture.boxscore.players[0].statistics[0].keys,athletes:Array.from({length:5},(_,i)=>({...structuredClone(player),athlete:{id:`${id}-${i}`},stats:['48',...player.stats.slice(1)]}))}]});
  const summary={header:{id:'1',season:{year:2027,type:2},competitions:[{date:'2026-10-20T23:00:00Z',neutralSite:false,status:{type:{state:'post',completed:true}},competitors:[{id:'a',homeAway:'away',score:'125',linescores:[{},{},{},{}]},{id:'b',homeAway:'home',score:'130',linescores:[{},{},{},{}]}]}]},boxscore:{players:[team('a'),team('b')]}}
  for(const p of summary.boxscore.players[1].statistics[0].athletes){p.stats[1]='26';p.stats[4]='10-10';};
  assert.equal(parseCompletedSummary(summary,'1').players[0].stl,2);
  for(const mutate of [
    (s:typeof summary)=>{s.boxscore.players.pop();},
    (s:typeof summary)=>{s.boxscore.players[0].statistics[0].athletes[0].stats[1]='99';},
    (s:typeof summary)=>{s.header.competitions[0].status.type.completed=false;},
  ]){const s=structuredClone(summary);mutate(s);assert.throws(()=>parseCompletedSummary(s,'1'));}
});


test('failed required inputs leave both published files byte-for-byte unchanged',async()=>{
 const paths=['public/data/slate.json','public/data/rate-card.json'];
 const before=paths.map(p=>readFileSync(p,'utf8'));
 const original=globalThis.fetch;
 const scoreboard={season:{year:2027},events:[{id:'test-game',date:new Date().toISOString(),season:{year:2027,type:2},competitions:[{competitors:[{homeAway:'away',team:{id:'a'}},{homeAway:'home',team:{id:'b'}}]}]}]};
 const outcome={sport:'NBA',season:2027,event_id:'history',athlete_id:'1',team_id:'a',stat_key:'points',actual:1,minutes:1};
 try{
  for(const failure of ['scoreboard','injuries','outcomes','roster']){
   globalThis.fetch=async(input)=>{
    const url=String(input);
    if(url.includes('scoreboard'))return Response.json(failure==='scoreboard'?{events:[{}]}:scoreboard);
    if(url.endsWith('/injuries'))return Response.json(failure==='injuries'?{}:{injuries:[]});
    if(url.endsWith('.gz'))return new Response(gzipSync(failure==='outcomes'?'':JSON.stringify(outcome)));
    if(url.endsWith('/teams'))return Response.json({sports:[]});
    if(url.includes('/roster'))return Response.json({athletes:[]});
    throw new Error('Unexpected source');
   };
   await assert.rejects(buildRateCard({generatorSha:'pending'}));
   assert.deepEqual(paths.map(p=>readFileSync(p,'utf8')),before);
  }
 }finally{globalThis.fetch=original;}
});
test('network retry policy retries transient status and stops on permanent status',async()=>{
 const original=globalThis.fetch;let n=0;
 try{
  globalThis.fetch=async()=>{n++;return new Response('{}',{status:n===1?503:200});};
  assert.equal((await fetchWithRetry('https://example.invalid',100)).status,200);assert.equal(n,2);
  n=0;globalThis.fetch=async()=>{n++;return new Response('{}',{status:404});};
  await assert.rejects(fetchWithRetry('https://example.invalid',100));assert.equal(n,1);
 }finally{globalThis.fetch=original;}
});
