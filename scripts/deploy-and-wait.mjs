// Dispatch is only the start of deployment; identify and verify the resulting run.
const repo=process.env.GITHUB_REPOSITORY;
const token=process.env.GITHUB_TOKEN;
const sha=process.env.DEPLOY_SHA;
if(!repo||!token||!sha)throw new Error('Missing deployment context');
async function api(path,body){
  const r=await fetch(`https://api.github.com/repos/${repo}/${path}`,{method:body?'POST':'GET',headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error(`Deployment API returned ${r.status}`);
  return r.status===204?null:r.json();
}
const request=`rate-card-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
await api('actions/workflows/deploy-pages.yml/dispatches',{ref:'main',inputs:{source_sha:sha,request_id:request}});
const deadline=Date.now()+12*60*1000;
while(Date.now()<deadline){
  const runs=await api('actions/workflows/deploy-pages.yml/runs?event=workflow_dispatch&per_page=100');
  const run=runs.workflow_runs.find(r=>r.display_title===request);
  if(run?.status==='completed'){
    if(run.conclusion!=='success')throw new Error(`Deployment ${run.id} ended ${run.conclusion}: ${run.html_url}`);
    console.log(`Verified deployment of ${sha}: ${run.html_url}`);process.exit(0);
  }
  await new Promise(resolve=>setTimeout(resolve,15000));
}
throw new Error('Timed out waiting for the dispatched deployment');
