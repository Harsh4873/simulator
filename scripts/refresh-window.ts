import {readFileSync,appendFileSync} from 'node:fs';
import {shouldRefresh} from '../src/refresh-window.ts';
// Timer runs pace like the cron schedule; a manual dispatch always forces a full refresh.
const paced=process.env.GITHUB_EVENT_NAME==='schedule'||process.env.REFRESH_TRIGGER==='timer';
const run=!paced||shouldRefresh(JSON.parse(readFileSync('public/data/slate.json','utf8')),new Date());
console.log(JSON.stringify({run,checked_at:new Date().toISOString()}));
if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`run=${run}\n`);
