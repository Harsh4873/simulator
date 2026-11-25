import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {nextRefreshAt,PRE_TIP_INTERVAL_MS} from '../src/refresh-window.ts';
import {githubApi} from './deploy-and-wait.mjs';
import type {Slate} from '../src/types.ts';

type Api=(path:string,body?:unknown)=>Promise<unknown>;
const stamp=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,'Z');

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Arms the single timer run; a newer timer replaces any older waiting one through its concurrency group. */
export async function scheduleNextRefresh({api,slate,now=new Date(),sleep=pause,attempts=4}:{api:Api;slate:Slate|null;now?:Date;sleep?:(ms:number)=>Promise<unknown>;attempts?:number}):Promise<{at:string;reason:string}>{
 const at=slate?nextRefreshAt(slate,now):new Date(now.getTime()+PRE_TIP_INTERVAL_MS);
 // A dispatch that fails (GitHub answers 5xx now and then) would leave no timer, so the cadence stops. Retry it.
 for(let attempt=1;;attempt++){
  try{await api('actions/workflows/refresh-timer.yml/dispatches',{ref:'main',inputs:{at:stamp(at)}});break;}
  catch(error){if(attempt>=attempts)throw error;await sleep(15000*attempt);}
 }
 return {at:stamp(at),reason:slate?'slate':'slate unreadable; retrying soon'};
}

export function readSlate(path='public/data/slate.json'):Slate|null{
 try{const slate=JSON.parse(readFileSync(path,'utf8')) as Slate;return Array.isArray(slate?.games)&&typeof slate.date==='string'?slate:null;}catch{return null;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const {GITHUB_REPOSITORY:repo,GITHUB_TOKEN:token}=process.env;
 if(!repo||!token)throw new Error('Missing scheduling context');
 console.log(JSON.stringify(await scheduleNextRefresh({api:githubApi(repo,token),slate:readSlate()})));
}
