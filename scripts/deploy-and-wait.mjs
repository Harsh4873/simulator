import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
// Dependencies are injectable so every failure path can be tested without dispatching anything.
export async function deployAndWait({api,sha,request,health={},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeout=12*60000}){
  if(!/^[a-f0-9]{40}$/.test(sha))throw new Error('Invalid deployment commit');
  await api('actions/workflows/deploy-pages.yml/dispatches',{ref:'main',inputs:{source_sha:sha,request_id:request,...health}});
  const deadline=now()+timeout;
  while(now()<deadline){
    const runs=await api('actions/workflows/deploy-pages.yml/runs?event=workflow_dispatch&per_page=100');
    const matches=runs.workflow_runs.filter(r=>r.display_title===request);
    if(matches.length>1)throw new Error('Ambiguous deployment correlation');
    const run=matches[0];
    if(run?.status==='completed'){
      if(run.conclusion!=='success')throw new Error(`Deployment ${run.id} ended ${run.conclusion}`);
      // The workflow checks out the dispatched immutable source_sha and verifies HEAD before upload.
      return {sha,run_id:run.id,url:run.html_url};
    }
    await sleep(15000);
  }
  throw new Error('Timed out waiting for the dispatched deployment');
}
export function githubApi(repo,token){return async(path,body)=>{
  const r=await fetch(`https://api.github.com/repos/${repo}/${path}`,{method:body?'POST':'GET',headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error(`Deployment API returned ${r.status}`);
  return r.status===204?null:r.json();
};}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {GITHUB_REPOSITORY:repo,GITHUB_TOKEN:token,DEPLOY_SHA:sha}=process.env;
  if(!repo||!token||!sha)throw new Error('Missing deployment context');
  const status=JSON.parse(readFileSync('.refresh-status.json','utf8'));
  const result=await deployAndWait({api:githubApi(repo,token),sha,request:`rate-card-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,health:{checked_at:status.checked_at,input_hash:status.input_hash,model_hash:status.model_hash}});
  console.log(JSON.stringify(result));
}
