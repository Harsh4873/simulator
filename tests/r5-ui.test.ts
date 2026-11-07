import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {simulate} from '../src/simulate.ts';
import {applyLineupOverrides,cleanOverrides,lineupIssue,overridesKey,readStoredLineups,summarizeOverrides} from '../src/lineup-overrides.ts';
import {renderLineupEditor} from '../src/lineup-editor.ts';
import {renderSlate} from '../src/slate.ts';
import {renderBoxScore} from '../src/boxscore.ts';
import {histogramSvg} from '../src/charts.ts';
import {displayColor,teamPalette} from '../src/display.ts';
import type {RateCard,Slate} from '../src/types.ts';

const card=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json','utf8')) as RateCard;
const slate=JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json','utf8')) as Slate;
const game=card.games[0];
const away=game.players.filter(p=>p.team_id===game.away_team_id&&p.minutes_weight===1).sort((a,b)=>b.minutes_mean-a.minutes_mean);
const outId=away[0].athlete_id;
const benched=game.players.find(p=>p.team_id===game.home_team_id&&p.minutes_weight===0)!;

test('lineup calls copy the game, never mutate it, and survive storage round trips',()=>{
 const before=JSON.stringify(game);
 const edited=applyLineupOverrides(game,{[outId]:'out',[benched.athlete_id]:'in'});
 assert.equal(JSON.stringify(game),before);
 const out=edited.players.find(p=>p.athlete_id===outId)!,inn=edited.players.find(p=>p.athlete_id===benched.athlete_id)!;
 assert.equal(out.minutes_weight,0);assert.equal(out.play_probability,0);assert.equal(out.manual_status,'out');assert.match(out.injury_status,/^out/);
 assert.equal(inn.minutes_weight,1);assert.equal(inn.play_probability,1);assert.equal(inn.injury_status,'healthy');assert.equal(inn.manual_status,'in');
 assert.equal(applyLineupOverrides(game,{}),game);
 assert.deepEqual(cleanOverrides(game,{[outId]:'out',nobody:'in'}),{[outId]:'out'});
 assert.equal(overridesKey({b:'in',a:'out'}),overridesKey({a:'out',b:'in'}));
 assert.equal(lineupIssue(game,{[outId]:'out'}),null);
 assert.deepEqual(summarizeOverrides(game,{[outId]:'out'}),{ruledOut:[away[0].name],ruledIn:[]});
 const stored=JSON.stringify({[game.event_id]:{[outId]:'out',x:'maybe'},gone:{[outId]:'in'}});
 assert.deepEqual(readStoredLineups(stored,[game.event_id]),{[game.event_id]:{[outId]:'out'}});
 assert.deepEqual(readStoredLineups('{not json',[game.event_id]),{});
 assert.deepEqual(readStoredLineups(null,[game.event_id]),{});
});

test('a player ruled out never plays, and a player ruled in plays every simulation',()=>{
 const edited=applyLineupOverrides(game,{[outId]:'out',[benched.athlete_id]:'in'});
 const sim=simulate(edited,11,300);
 assert.ok(Array.from(sim.playerDraws.get(outId)!.min).every(m=>m===0));
 assert.ok(Array.from(sim.playerDraws.get(benched.athlete_id)!.min).every(m=>m>0));
 const base=simulate(game,11,300);
 assert.ok(Array.from(base.playerDraws.get(outId)!.min).some(m=>m>0));
});

test('ruling out a whole rotation still simulates with labelled replacement minutes',()=>{
 const everyone=Object.fromEntries(game.players.filter(p=>p.team_id===game.away_team_id).map(p=>[p.athlete_id,'out' as const]));
 const edited=applyLineupOverrides(game,everyone);
 assert.equal(lineupIssue(game,everyone),null);
 const sim=simulate(edited,3,50);
 assert.equal(sim.thin_rotation,true);
});

test('the lineup editor shows each player with Auto, In and Out, and the run button carries the game',()=>{
 const g=slate.games.find(x=>x.event_id===game.event_id)!;
 const html=renderLineupEditor(g,game,{[outId]:'out'});
 assert.match(html,new RegExp(`data-lineup-choice="${outId}"[^>]*value="out"|value="out" data-lineup-choice="${outId}" checked`));
 assert.match(html,new RegExp(`value="out" data-lineup-choice="${outId}" checked`));
 assert.match(html,/data-event="[^"]+" data-lineup-run>Simulate with my lineups</);
 assert.match(html,/1 change from the model\./);
 assert.equal((html.match(/value="auto"/g)??[]).length,game.players.filter(p=>!p.replacement_level).length);
 const clean=renderLineupEditor(g,game,{});
 assert.match(clean,/data-lineup-reset disabled/);
 assert.match(clean,/>Simulate</);
});

test('slate cards keep Simulate, add Lineups and flag the viewer\'s changes',()=>{
 const s=structuredClone(slate),c=structuredClone(card),now=new Date(c.generated_at!);
 const html=renderSlate(s,c,now,null,{[game.event_id]:2});
 assert.match(html,/>Simulate<\/button>/);
 assert.match(html,new RegExp(`data-lineup="${game.event_id}">Lineups<`));
 assert.match(html,/2 lineup changes/);
 assert.match(html,/style="--away: #[0-9a-f]{6}; --home: #[0-9a-f]{6};"/);
});

test('the score view shows the call banner, key numbers and both distributions',()=>{
 const g=slate.games.find(x=>x.event_id===game.event_id)!;
 const sim=simulate(game,5,400);
 const html=renderBoxScore(g,game,sim,new Date(),undefined,{ruledOut:['A Player'],ruledIn:[]});
 assert.match(html,/Your lineups\./);assert.match(html,/Ruled out: A Player/);assert.match(html,/data-lineup-clear/);
 assert.match(html,/Win chance/);assert.match(html,/Projected total/);
 assert.equal((html.match(/<svg class="hist"/g)??[]).length,2);
 assert.match(html,/aria-label="[A-Z]+ margin \(home minus away\): median/);
 assert.match(html,/data-lineup="[^"]+">Edit lineups</);
 assert.equal(renderBoxScore(g,game,sim,new Date()).includes('edit-banner'),false);
});

test('histograms bin every draw and colors stay visible and distinct',()=>{
 const svg=histogramSvg([-10,-3,1,1,4,9,12],{label:'Margin',binWidth:2,split:0});
 assert.match(svg,/class="bar low"/);assert.match(svg,/class="bar high"/);assert.match(svg,/role="img"/);
 assert.equal(histogramSvg([],{label:'x',binWidth:2}),'');
 assert.notEqual(displayColor('#000000'),'#000000');
 assert.notEqual(displayColor('#ffffff'),'#ffffff');
 const p=teamPalette({color:'#1d428a'},{color:'#1d4289',alternate_color:'#ffc72c'});
 assert.notEqual(p.away,p.home);
 assert.deepEqual(teamPalette({},{}),{away:'#4da6ff',home:'#00e5a0'});
});

test('DOM: open Lineups, rule a player out, simulate with the call, then return to the model',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sim-lineup-'));
 const {window,document}=parseHTML(readFileSync('index.html','utf8'));
 const globals=globalThis as unknown as Record<string,unknown>;
 for(const key of ['window','document','HTMLElement','HTMLButtonElement','HTMLInputElement','HTMLSelectElement','HTMLImageElement','HTMLDetailsElement','Element','Event'])globals[key]=(window as unknown as Record<string,unknown>)[key];
 Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false})});window.scrollTo=()=>{};
 const saved:string[]=[];
 globals.CSS={escape:(x:string)=>x};globals.localStorage={getItem:()=>null,setItem:(_k:string,v:string)=>{saved.push(v);}};
 window.HTMLElement.prototype.focus=function(){};
 const timer=globalThis.setInterval;globals.setInterval=()=>0;
 const c=structuredClone(card),s=structuredClone(slate);
 const now=new Date();c.generated_at=now.toISOString();s.generated_at=c.generated_at;
 const chicago=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 c.date=chicago;s.date=chicago;s.games.forEach(g=>{g.date=chicago;g.status_state='pre';g.completed=false;g.start_time=new Date(now.getTime()+3600000).toISOString();});
 delete c.model_hash;
 globals.fetch=async(url:string)=>new Response(url.endsWith('/slate.json')?JSON.stringify(s):url.endsWith('/rate-card.json')?JSON.stringify(c):'',{status:url.endsWith('/slate.json')||url.endsWith('/rate-card.json')?200:404});
 const posted:{game:{players:{athlete_id:string;minutes_weight:number}[]}}[]=[];
 const result=simulate(c.games[0],55,100);
 class FakeWorker{onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;postMessage(m:{game:{players:{athlete_id:string;minutes_weight:number}[]}}){posted.push(m);queueMicrotask(()=>this.onmessage?.({data:{result}}));}terminate(){}}
 globals.Worker=FakeWorker;
 const flush=()=>new Promise(r=>setTimeout(r,20));
 try{
  await build({entryPoints:['src/main.ts'],bundle:true,format:'esm',outfile:join(dir,'app.mjs'),loader:{'.css':'empty'},logLevel:'silent'});
  await import(pathToFileURL(join(dir,'app.mjs')).href);await flush();
  const eventId=c.games[0].event_id;
  document.querySelector<HTMLElement>(`button[data-lineup="${eventId}"]`)!.click();
  assert.ok(document.querySelector('[data-lineup-editor]'),'editor open');
  const radio=document.querySelector<HTMLInputElement>(`input[data-lineup-choice="${outId}"][value="out"]`)!;
  radio.checked=true;radio.dispatchEvent(new window.Event('change',{bubbles:true}));
  assert.ok(saved.at(-1)!.includes(outId),'call persisted');
  assert.ok(document.querySelector<HTMLInputElement>(`input[data-lineup-choice="${outId}"][value="out"]`)!.hasAttribute('checked'),'re-rendered with the call');
  document.querySelector<HTMLElement>('[data-lineup-run]')!.click();await flush();
  assert.equal(posted.length,1);
  assert.equal(posted[0].game.players.find(p=>p.athlete_id===outId)!.minutes_weight,0);
  assert.match(document.querySelector('.edit-banner')!.textContent!,new RegExp(away[0].name));
  document.querySelector<HTMLElement>('[data-lineup-clear]')!.click();await flush();
  assert.equal(posted.length,2,'the model lineup is a different cache entry');
  assert.equal(posted[1].game.players.find(p=>p.athlete_id===outId)!.minutes_weight,1);
  assert.equal(document.querySelector('.edit-banner'),null);
  document.querySelector<HTMLElement>('[data-back]')!.click();
  assert.equal(document.querySelector('.chip-edit'),null);
 }finally{globals.setInterval=timer;rmSync(dir,{recursive:true});}
});
