import {pathToFileURL} from 'node:url';
import {githubApi} from './deploy-and-wait.mjs';
/** The refresh timer beats every two hours off the pre-tip window, so three hours means one run was missed. */
export const DEADLINE_MS=3*3600000;
const ACTIVE=['queued','in_progress','waiting','pending','requested'];
export function refreshIssue(runs,now=Date.now()){
  const newest=[...runs].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  const success=newest.find(r=>r.status==='completed'&&r.conclusion==='success');
  const checked=success?Date.parse(success.run_started_at??success.created_at):NaN;
  if(newest[0]?.status==='completed'&&newest[0].conclusion!=='success')return 'Latest refresh or publication failed';
  return !Number.isFinite(checked)||now-checked>DEADLINE_MS?'Missed refresh deadline':null;
}
export async function monitor(api,now=Date.now()){
  const {workflow_runs:runs}=await api('actions/workflows/refresh-rate-card.yml/runs?per_page=100');
  const issue=refreshIssue(runs,now);
  const successful=runs.filter(r=>r.status==='completed'&&r.conclusion==='success').sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
  const started=successful?.run_started_at??successful?.created_at??null;
  const timing={last_source_check_started:started,last_publication_completed:successful?.updated_at??null,expected_next_completion:started?new Date(Date.parse(started)+DEADLINE_MS).toISOString():null,observed_at:new Date(now).toISOString()};
  // Bound recovery: one in-flight/recent attempt prevents a dispatch storm.
  const pending=runs.some(r=>(ACTIVE.includes(r.status)&&now-Date.parse(r.created_at)<45*60000)||now-Date.parse(r.created_at)<30*60000);
  if(issue){
    if(!pending)await api('actions/workflows/refresh-rate-card.yml/dispatches',{ref:'main'});
    return {issue,recovery:!pending,timer_armed:null,...timing};
  }
  // Each refresh arms one waiting timer for the next. If that timer died (a failed dispatch, a killed job),
  // nothing starts the next refresh, so the card goes stale. Re-arm before the deadline is missed.
  const {workflow_runs:timers}=await api('actions/workflows/refresh-timer.yml/runs?per_page=20');
  const armed=(timers??[]).some(r=>ACTIVE.includes(r.status));
  if(armed||pending)return {issue:null,recovery:false,timer_armed:armed,...timing};
  await api('actions/workflows/refresh-rate-card.yml/dispatches',{ref:'main',inputs:{trigger:'timer'}});
  return {issue:null,recovery:true,timer_armed:false,...timing};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await monitor(githubApi(process.env.GITHUB_REPOSITORY,process.env.GITHUB_TOKEN));
  console.log(JSON.stringify({...result,observed_at:new Date().toISOString(),deadline_hours:DEADLINE_MS/3600000}));
  if(!result.issue&&result.recovery)console.log('::warning::No refresh timer was waiting; started a paced refresh to re-arm it');
  if(result.issue){console.error(`::error::${result.issue}; inspect refresh and publication runs. Recovery requested: ${result.recovery}`);process.exitCode=1;}
}
