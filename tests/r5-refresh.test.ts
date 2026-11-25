import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {nextRefreshAt,nextChicagoMidnight,shouldRefresh,PRE_TIP_INTERVAL_MS,OFF_WINDOW_INTERVAL_MS,MIN_REFRESH_GAP_MS} from '../src/refresh-window.ts';
import {scheduleNextRefresh} from '../scripts/schedule-refresh.ts';
import {deployAndWait} from '../scripts/deploy-and-wait.mjs';
import type {Slate,SlateGame} from '../src/types.ts';

const MIN=60000;
function slate(date:string,tips:string[],state='pre'):Slate{
 return {schema_version:1,generated_at:'2026-11-06T12:00:00Z',date,timezone:'America/Chicago',games:tips.map((t,i)=>({event_id:String(i),date,start_time:t,status_state:state} as SlateGame))};
}
const gap=(s:Slate,now:string)=>nextRefreshAt(s,new Date(now)).getTime()-Date.parse(now);

test('inside the pre-tip window refreshes come every 30 minutes, plus one about 30 minutes before each tip',()=>{
 const s=slate('2026-11-06',['2026-11-07T00:00:00Z','2026-11-07T03:00:00Z']);
 assert.equal(gap(s,'2026-11-06T22:00:00Z'),PRE_TIP_INTERVAL_MS);
 assert.equal(gap(s,'2026-11-06T23:10:00Z'),20*MIN);
 assert.equal(gap(s,'2026-11-06T23:25:00Z'),MIN_REFRESH_GAP_MS);
 // After the early tips, the 03:00 game still keeps the 30-minute pace and its own final check.
 assert.equal(gap(s,'2026-11-07T00:10:00Z'),PRE_TIP_INTERVAL_MS);
 assert.equal(gap(s,'2026-11-07T02:00:00Z'),30*MIN);
});

test('outside the window the next run is the window start, a two-hour heartbeat, or the Chicago rollover',()=>{
 const evening=slate('2026-11-06',['2026-11-07T00:00:00Z']);
 assert.equal(gap(evening,'2026-11-06T18:30:00Z'),90*MIN);
 assert.equal(gap(evening,'2026-11-06T12:00:00Z'),OFF_WINDOW_INTERVAL_MS);
 const done=slate('2026-11-06',['2026-11-07T00:00:00Z'],'post');
 // 23:00 CST is 05:00 UTC; the rollover run lands five minutes after midnight.
 assert.equal(new Date(nextRefreshAt(done,new Date('2026-11-07T05:00:00Z'))).toISOString(),'2026-11-07T06:05:00.000Z');
 const off=slate('2026-11-03',[]);
 assert.equal(gap(off,'2026-11-03T14:00:00Z'),OFF_WINDOW_INTERVAL_MS);
 for(const now of ['2026-11-06T12:00:00Z','2026-11-07T01:00:00Z','2026-11-07T05:59:00Z']){
  const g=gap(evening,now);assert.ok(g>=MIN_REFRESH_GAP_MS&&g<=OFF_WINDOW_INTERVAL_MS,`${now} ${g}`);
 }
});

test('Chicago midnight is found across both DST changes',()=>{
 assert.equal(new Date(nextChicagoMidnight(new Date('2026-10-31T20:00:00Z'))).toISOString(),'2026-11-01T05:00:00.000Z');
 assert.equal(new Date(nextChicagoMidnight(new Date('2026-11-01T20:00:00Z'))).toISOString(),'2026-11-02T06:00:00.000Z');
 assert.equal(new Date(nextChicagoMidnight(new Date('2027-03-14T12:00:00Z'))).toISOString(),'2027-03-15T05:00:00.000Z');
});

test('the full-refresh window is unchanged: four hours before a pending tip, or a new Chicago date',()=>{
 const s=slate('2026-11-06',['2026-11-07T00:00:00Z']);
 assert.equal(shouldRefresh(s,new Date('2026-11-06T20:30:00Z')),true);
 assert.equal(shouldRefresh(s,new Date('2026-11-06T19:30:00Z')),false);
 assert.equal(shouldRefresh(s,new Date('2026-11-07T06:30:00Z')),true);
});

test('each refresh arms one timer for the computed time, and an unreadable slate retries soon',async()=>{
 const calls:{path:string;body:unknown}[]=[];
 const api=async(path:string,body?:unknown)=>{calls.push({path,body});return null;};
 const s=slate('2026-11-06',['2026-11-07T00:00:00Z']);
 const result=await scheduleNextRefresh({api,slate:s,now:new Date('2026-11-06T22:00:00Z')});
 assert.equal(result.at,'2026-11-06T22:30:00Z');
 assert.deepEqual(calls[0],{path:'actions/workflows/refresh-timer.yml/dispatches',body:{ref:'main',inputs:{at:'2026-11-06T22:30:00Z'}}});
 const fallback=await scheduleNextRefresh({api,slate:null,now:new Date('2026-11-06T22:00:00Z')});
 assert.equal(fallback.at,'2026-11-06T22:30:00Z');assert.match(fallback.reason,/unreadable/);
});

test('a failed Pages deployment is retried once under a new correlation id; cancellations are not',async()=>{
 const sha='b'.repeat(40),request='rate-card-1-1',dispatched:string[]=[];
 let clock=0;
 const api=async(_path:string,body?:{inputs:{request_id:string}})=>{
  if(body){dispatched.push(body.inputs.request_id);return null;}
  return {workflow_runs:dispatched.map((id,i)=>({display_title:id,id:i+1,status:'completed',conclusion:i===0?'failure':'success'}))};
 };
 const result=await deployAndWait({api,sha,request,attempts:2,sleep:async(ms:number)=>{clock+=ms;},now:()=>clock});
 assert.deepEqual(dispatched,[request,`${request}-retry1`]);
 assert.equal(result.run_id,2);
 const cancelled=async(_p:string,b?:unknown)=>b?null:{workflow_runs:[{display_title:request,id:9,status:'completed',conclusion:'cancelled'}]};
 await assert.rejects(deployAndWait({api:cancelled,sha,request,attempts:2,sleep:async()=>{}}),/cancelled/);
});

test('the refresh job re-arms the timer even after a failure, and the timer only dispatches the refresh',()=>{
 const refresh=readFileSync('.github/workflows/refresh-rate-card.yml','utf8');
 const schedule=refresh.split('      - name: Schedule the next refresh')[1];
 assert.ok(schedule,'schedule step');
 assert.match(schedule,/if: always\(\) && github.ref == 'refs\/heads\/main'/);
 assert.match(schedule,/node --experimental-strip-types scripts\/schedule-refresh.ts/);
 assert.match(refresh,/REFRESH_TRIGGER: \$\{\{ inputs.trigger \}\}/);
 const timer=readFileSync('.github/workflows/refresh-timer.yml','utf8');
 assert.match(timer,/group: simulator-refresh-timer/);
 assert.match(timer,/cancel-in-progress: true/);
 assert.match(timer,/gh workflow run refresh-rate-card.yml --repo "\$REPO" --ref main -f trigger=timer/);
 assert.match(timer,/AT: \$\{\{ inputs.at \}\}/);
 assert.ok(!timer.split('run: |')[1].includes('${{ inputs.at }}'),'the time reaches the script only through the environment');
 assert.match(timer,/timeout-minutes: 330/);
 assert.match(timer,/19200/);
 const window=readFileSync('scripts/refresh-window.ts','utf8');
 assert.match(window,/REFRESH_TRIGGER==='timer'/);
 assert.match(timer,/for delay in 0 15 30 60 120 240/,'the timer retries a failed dispatch');
 assert.ok(!existsSync('.github/workflows/recover-refresh-timer.yml'),'workflow_run never fires for token-dispatched timers; the freshness check re-arms instead');
 const check=readFileSync('.github/workflows/check-freshness.yml','utf8');
 assert.match(check,/cron: "47 \* \* \* \*"/);
});

test('a failed timer dispatch is retried, and gives up only after the last attempt',async()=>{
 let tries=0;const waits:number[]=[];
 const flaky=async()=>{if(++tries<3)throw new Error('GitHub API returned 500');return null;};
 const s=slate('2026-11-06',['2026-11-07T00:00:00Z']);
 await scheduleNextRefresh({api:flaky,slate:s,now:new Date('2026-11-06T22:00:00Z'),sleep:async(ms:number)=>{waits.push(ms);}});
 assert.equal(tries,3);assert.deepEqual(waits,[15000,30000]);
 const down=async()=>{throw new Error('GitHub API returned 500');};
 await assert.rejects(scheduleNextRefresh({api:down,slate:s,sleep:async()=>{},attempts:2}),/500/);
});

test('the freshness check re-arms a dropped timer once, and leaves an armed one alone',async()=>{
 const {monitor}=await import('../scripts/check-freshness.mjs');
 const now=Date.parse('2026-11-25T18:40:00Z');
 const recent=[{created_at:'2026-11-25T17:00:00Z',run_started_at:'2026-11-25T17:00:00Z',status:'completed',conclusion:'success'}];
 const run=async(timers:unknown[])=>{const posts:unknown[]=[];const api=async(path:string,body?:unknown)=>{if(body){posts.push(body);return null;}return path.includes('refresh-timer')?{workflow_runs:timers}:{workflow_runs:recent};};return {result:await monitor(api,now),posts};};
 const dropped=await run([{status:'completed',conclusion:'failure',created_at:'2026-11-25T12:29:00Z'}]);
 assert.equal(dropped.result.issue,null);assert.equal(dropped.result.recovery,true);
 assert.deepEqual(dropped.posts,[{ref:'main',inputs:{trigger:'timer'}}]);
 const armed=await run([{status:'in_progress',created_at:'2026-11-25T17:05:00Z'}]);
 assert.equal(armed.result.recovery,false);assert.deepEqual(armed.posts,[]);
});
