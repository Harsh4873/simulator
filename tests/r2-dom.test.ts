import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {simulate} from '../src/simulate.ts';
import type {RateCard,Slate} from '../src/types.ts';
test('DOM navigation restores focus, tabs respond to keys, worker cancel and cache remain usable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sim-dom-'));
 const {window,document}=parseHTML(readFileSync('index.html','utf8'));
 const globals=globalThis as unknown as Record<string,unknown>;
 for(const key of ['window','document','HTMLElement','HTMLButtonElement','HTMLInputElement','HTMLSelectElement','HTMLImageElement','HTMLDetailsElement','Element','Event'])globals[key]=(window as unknown as Record<string,unknown>)[key];
 Object.defineProperty(window,'matchMedia',{value:()=>({matches:false})});window.scrollTo=()=>{};
 globals.CSS={escape:(x:string)=>x};globals.localStorage={getItem:()=>null,setItem:()=>{}};
 let focused:Element|null=null;
 window.HTMLElement.prototype.focus=function(){focused=this;};
 const timer=globalThis.setInterval;globals.setInterval=()=>0;
 const card=JSON.parse(readFileSync('public/data/rate-card.json','utf8')) as RateCard;
 const slate=JSON.parse(readFileSync('public/data/slate.json','utf8')) as Slate;
 const now=new Date();card.generated_at=now.toISOString();slate.generated_at=card.generated_at;
 const chicago=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 card.date=chicago;slate.date=chicago;slate.games.forEach(g=>{g.date=chicago;g.status_state='pre';g.completed=false;g.start_time=new Date(now.getTime()+3600000).toISOString();});
 // This fixture exercises the supported older-card path without a manifest.
 delete card.model_hash;
 globals.fetch=async(url:string)=>new Response(url.endsWith('/slate.json')?JSON.stringify(slate):url.endsWith('/rate-card.json')?JSON.stringify(card):'',{status:url.endsWith('/slate.json')||url.endsWith('/rate-card.json')?200:404});
 let workerCount=0,terminations=0,pending=false;
 const result=simulate(card.games[0],55,100);
 class FakeWorker{
  onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;
  constructor(){workerCount++;}
  postMessage(){if(!pending)queueMicrotask(()=>this.onmessage?.({data:{result}}));}
  terminate(){terminations++;}
 }
 globals.Worker=FakeWorker;
 const flush=()=>new Promise(r=>setTimeout(r,20));
 const click=(selector:string)=>{const el=document.querySelector<HTMLElement>(selector);assert.ok(el,selector);el.click();};
 const key=(selector:string,k:string)=>{const e=new window.Event('keydown',{bubbles:true});Object.assign(e,{key:k});document.querySelector(selector)!.dispatchEvent(e);};
 try{
  await build({entryPoints:['src/main.ts'],bundle:true,format:'esm',outfile:join(dir,'app.mjs'),loader:{'.css':'empty'},logLevel:'silent'});
  await import(pathToFileURL(join(dir,'app.mjs')).href);await flush();
  click('button[data-event]');await flush();
  assert.ok((focused as Element|null)?.hasAttribute('data-back'));
  click('button[data-sort="pts"][data-side="away"]');assert.equal((focused as Element|null)?.getAttribute('data-sort'),'pts');
  const athlete=document.querySelector('button[data-athlete]')!.getAttribute('data-athlete')!;
  click(`button[data-athlete="${athlete}"]`);assert.equal((focused as Element|null)?.id,'forecast-tab');
  key('#forecast-tab','ArrowRight');assert.equal((focused as Element|null)?.id,'props-tab');
  key('#props-tab','Home');assert.equal((focused as Element|null)?.id,'forecast-tab');
  key('#forecast-tab','Escape');assert.equal((focused as Element|null)?.getAttribute('data-athlete'),athlete);
  click(`button[data-athlete="${athlete}"]`);click('[data-close]');assert.equal((focused as Element|null)?.getAttribute('data-athlete'),athlete);
  click('[data-back]');assert.ok((focused as Element|null)?.hasAttribute('data-event'));
  click('button[data-event]');await flush();assert.equal(workerCount,1); // Cache hit.
  click('[data-back]');pending=true;
  const second=document.querySelectorAll<HTMLElement>('button[data-event]')[1];assert.ok(second);second.click();await flush();click('[data-cancel]');await flush();assert.ok(terminations>=2);assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes('cancelled'));
 }finally{globals.setInterval=timer;rmSync(dir,{recursive:true});}
});
