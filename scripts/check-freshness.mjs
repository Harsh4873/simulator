import {readFileSync} from 'node:fs';
const card=JSON.parse(readFileSync('public/data/rate-card.json','utf8'));
const stale=!Number.isFinite(Date.parse(card.generated_at))||Date.now()-Date.parse(card.generated_at)>4*60*60*1000;
if(stale){
  const r=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/refresh-rate-card.yml/dispatches`,{method:'POST',headers:{authorization:`Bearer ${process.env.GITHUB_TOKEN}`,accept:'application/vnd.github+json'},body:JSON.stringify({ref:'main'}),signal:AbortSignal.timeout(20000)});
  console.error(`::error::Simulator card is stale. Recovery dispatch: ${r.status}. Inspect the refresh and deployment runs.`);
  process.exitCode=1;
}else console.log(`Fresh generation: ${card.generated_at}`);
