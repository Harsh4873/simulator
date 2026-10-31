import {pathToFileURL} from 'node:url';
import {githubApi} from './deploy-and-wait.mjs';
export function refreshIssue(runs,now=Date.now()){
  const newest=[...runs].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  const success=newest.find(r=>r.status==='completed'&&r.conclusion==='success');
  const checked=success?Date.parse(success.run_started_at??success.created_at):NaN;
  if(newest[0]?.status==='completed'&&newest[0].conclusion!=='success')return 'Latest refresh or publication failed';
  return !Number.isFinite(checked)||now-checked>4*3600000?'Missed refresh deadline':null;
}
export async function monitor(api,now=Date.now()){
  const {workflow_runs:runs}=await api('actions/workflows/refresh-rate-card.yml/runs?per_page=100');
  const issue=refreshIssue(runs,now);
  const successful=runs.filter(r=>r.status==='completed'&&r.conclusion==='success').sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
  const started=successful?.run_started_at??successful?.created_at??null;
  const timing={last_source_check_started:started,last_publication_completed:successful?.updated_at??null,expected_next_completion:started?new Date(Date.parse(started)+4*3600000).toISOString():null,observed_at:new Date(now).toISOString()};
  if(!issue)return {issue:null,recovery:false,...timing};
  // Bound recovery: one in-flight/recent attempt prevents a dispatch storm.
  const pending=runs.some(r=>(['queued','in_progress','waiting'].includes(r.status)&&now-Date.parse(r.created_at)<45*60000)||now-Date.parse(r.created_at)<30*60000);
  if(!pending)await api('actions/workflows/refresh-rate-card.yml/dispatches',{ref:'main'});
  return {issue,recovery:!pending,...timing};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await monitor(githubApi(process.env.GITHUB_REPOSITORY,process.env.GITHUB_TOKEN));
  console.log(JSON.stringify({...result,observed_at:new Date().toISOString(),deadline_hours:4}));
  if(result.issue){console.error(`::error::${result.issue}; inspect refresh and publication runs. Recovery requested: ${result.recovery}`);process.exitCode=1;}
}
