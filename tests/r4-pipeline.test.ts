import test from 'node:test';
import assert from 'node:assert/strict';
import {encodePlayCache,decodePlayCache} from '../scripts/play-cache.ts';
import {buildRateCard} from '../scripts/build-rate-card.ts';
import {teamCoverage} from '../src/coverage.ts';
import {validateGeneration} from '../src/validate-card.ts';
import {readFileSync} from 'node:fs';
test('packed history preserves fields and ignores property and event insertion order',()=>{
 const history={version:1 as const,status:'partial' as const,reason:'Clock reversal',venue:{id:'v',latitude:null,longitude:null,timezone:null},final_observed_at:null,final_reconciled:true,plays:[{id:'p',sequence:1,period:1,seconds:7,type:'Shooting Foul',team:'a',athletes:['p'],home:1,away:0,attempt:0,made:false,trip_attempt:null,trip_size:null,wallclock:null}]};
 const row={event_id:'a',start_time:'2026-01-01',home_pts:1,away_pts:0,history},rows=[row,{...row,event_id:'b'}];
 const bytes=encodePlayCache(rows);assert.deepEqual(decodePlayCache(bytes),rows);
 const reordered=[...rows].reverse().map(r=>({...r,history:{...history,plays:history.plays.map(p=>Object.fromEntries(Object.entries(p).reverse()) as typeof p)}}));
 assert.ok(bytes.equals(encodePlayCache(reordered)));
});
test('publication refuses silent local provenance even when a previous generation could be reused',async()=>{
 const prior=process.env.GENERATOR_SHA,github=process.env.GITHUB_SHA;delete process.env.GENERATOR_SHA;delete process.env.GITHUB_SHA;
 try{await assert.rejects(buildRateCard(),/GENERATOR_SHA/);await assert.rejects(buildRateCard({generatorSha:'local-uncommitted'}),/GENERATOR_SHA/);}finally{if(prior!==undefined)process.env.GENERATOR_SHA=prior;if(github!==undefined)process.env.GITHUB_SHA=github;}
 const card=JSON.parse(readFileSync('public/data/rate-card.json','utf8')),slate=JSON.parse(readFileSync('public/data/slate.json','utf8'));card.generator_sha='local-uncommitted';assert.throws(()=>validateGeneration(slate,card),/provenance/);
});
test('coverage exposes authorized missing dates, seasons and deferred retries without inventing a full schedule',()=>{
 const rows=teamCoverage(['a','b'],[],{teams:new Map([['9',['a']],['1',['a','b']]]),seasons:new Map([['9',2026],['1',2027]]),dates:new Map([['1','2026-10-01']]),retries:{'1':{failures:2,next_check:'2026-11-01',last_error:'missing'}}},2027,'2026-10-31',[]);
 assert.equal(rows[0].authorized_events,2);assert.equal(rows[0].missing_summaries,2);assert.equal(rows[0].unknown_dates,1);assert.equal(rows[0].deferred_retries,1);assert.equal(rows[0].oldest_missing_start,'2026-10-01');assert.equal(rows[1].seasons[0].season,2027);
});
