import {readFileSync,appendFileSync} from 'node:fs';
import {shouldRefresh} from '../src/refresh-window.ts';
const run=process.env.GITHUB_EVENT_NAME!=='schedule'||shouldRefresh(JSON.parse(readFileSync('public/data/slate.json','utf8')),new Date());
console.log(JSON.stringify({run,checked_at:new Date().toISOString()}));
if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`run=${run}\n`);
