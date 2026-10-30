import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discreteRead,summarizeDistribution,lineProbability} from '../src/distributions.ts';
import {gradeProp,valueAt,decideVerdict,quoteProp,propContextFromPlayer} from '../src/props.ts';
import {simulate} from '../src/simulate.ts';
import {renderBoxScore,renderPlayerPanel} from '../src/boxscore.ts';
import {validatePublicText} from '../scripts/validate-privacy.mjs';
import {validateArtifact} from '../scripts/validate-artifact.mjs';
import type {RateCard,Slate} from '../src/types.ts';
const card=JSON.parse(readFileSync('public/data/rate-card.json','utf8')) as RateCard;
const slate=JSON.parse(readFileSync('public/data/slate.json','utf8')) as Slate;
test('combination and milestone settlements preserve same-draw correlations and voids',()=>{
 const sample={min:[30,30,0],pts:[10,20,40],reb:[10,4,20],ast:[10,5,20],tpm:[0,2,2],stl:[0,0,0],blk:[0,0,0]};
 assert.equal(valueAt(sample,0,'pa'),20);assert.equal(valueAt(sample,1,'pr'),24);assert.equal(valueAt(sample,1,'ra'),9);
 assert.deepEqual(gradeProp(sample,'pa','over',20),{wins:1,losses:0,pushes:1,voids:1});
 assert.deepEqual(gradeProp(sample,'dd','over',.5),{wins:1,losses:1,pushes:0,voids:1});
 assert.deepEqual(gradeProp(sample,'td','under',.5),{wins:1,losses:1,pushes:0,voids:1});
 assert.throws(()=>gradeProp(sample,'dd','over',1),/0.5/);
});
test('mid-CDF represents common zero and tied outcomes centrally',()=>{
 assert.deepEqual(discreteRead([0,0,0,0,0,0,0,0,0,1],0),{percent:45,mass:.9});
 assert.deepEqual(discreteRead([3,3,3],3),{percent:50,mass:1});
 assert.equal(discreteRead([1,2,2,4],2).percent,50);
});
test('game distribution summaries and line pushes agree with draw arrays',()=>{
 const d=summarizeDistribution([0,2,4,6]);assert.equal(d.mean,3);assert.equal(d.median,3);assert.ok(Math.abs(d.p10-.6)<1e-12);
 assert.deepEqual(lineProbability([0,2,4,6],2),{over:.5,under:.25,push:.25});
});
test('current sampler expected columns, bands, progress and displayed score annotations match draws',()=>{
 const progress:number[]=[];const sim=simulate(card.games[0],42,500,n=>progress.push(n));
 assert.deepEqual(progress,[0,250]);
 for(const p of [...sim.away.players,...sim.home.players]){
  const draws=sim.playerDraws.get(p.athlete_id)!;
  for(const key of ['fgm','fga','tpm','tpa','ftm','fta'] as const){assert.equal(p.expectation!.counts![key],Array.from(draws[key]!).reduce((a,b)=>a+b,0)/500);}
  for(const key of ['min','pts','reb','ast'] as const){const band=p.expectation!.bands![key]!;assert.ok(band.p10<=band.p50&&band.p50<=band.p90);}
 }
 const html=renderBoxScore(slate.games[0],card.games[0],sim,new Date());
 assert.ok(html.includes(`mean ${sim.distributions!.total.mean.toFixed(1)}`));
 assert.ok(html.includes('Mid-CDF'));
 const p=card.games[0].players[0];
 const panel=renderPlayerPanel(slate.games[0],card.games[0],sim,p.athlete_id,'median','forecast');
 assert.ok(panel.includes('Conditional minute target:'));
});
test('artifact and privacy boundaries fail on prohibited fixtures',()=>{
 assert.throws(()=>validatePublicText('contact='+'person'+'@'+'example.net'),/email/);
 assert.throws(()=>validatePublicText('owner_'+'home_address: '+JSON.stringify('fixture')),/Personal/);
 const root=mkdtempSync(join(tmpdir(),'sim-boundary-'));
 try{mkdirSync(join(root,'data'));writeFileSync(join(root,'data/shooting-cache.json'),'{}');assert.throws(()=>validateArtifact(root),/Unexpected/);}finally{rmSync(root,{recursive:true});}
});
test('all semantic theme text and probability colors clear 4.5:1 contrast',()=>{
 const css=readFileSync('src/styles.css','utf8');
 const lum=(hex:string)=>{const c=hex.slice(1).match(/../g)!.map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
 const contrast=(a:string,b:string)=>{const l=[lum(a),lum(b)].sort((x,y)=>x-y);return (l[1]+.05)/(l[0]+.05);};
 const vars=(block:string)=>Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[a-f0-9]{6})/g)].map(x=>[x[1],x[2]]));
 const dark=vars(css.match(/:root\s*{([^}]+)/)![1]),light={...dark,...vars(css.match(/html\[data-theme="light"\]\s*{([^}]+)/)![1])};
 for(const theme of [dark,light])for(const fg of ['text','muted','accent','blue'])for(const bg of ['bg','surface','card'])assert.ok(contrast(theme[fg],theme[bg])>=4.5,`${fg} ${bg} ${contrast(theme[fg],theme[bg])}`);
 for(const m of css.matchAll(/background:\s*(#[a-f0-9]{6}); color:\s*(#[a-f0-9]{6})/g))assert.ok(contrast(m[1],m[2])>=4.5,`tone ${m[1]}`);
 assert.ok(contrast('#00e5a0',dark['on-accent'])>=4.5);assert.ok(contrast('#ffd700',dark['on-accent'])>=4.5);
 assert.ok(contrast('#8a6a00',light.bg)>=4.5);
});
test('unreliable minute evidence remains PASS at different prices',()=>{
 const p=structuredClone(card.games[0].players.find(p=>p.minutes_weight===1)!);
 const stat={state:'thin' as const,exposure:1,games:1,last_observed:null,prior_fraction:.9,standard_error:null};
 p.evidence={minutes:stat,shooting:stat,reb:stat,ast:stat,stl:stat,blk:stat,role_changed:false,availability:'scenario-prior',historical_roster_coverage:'unknown'};
 const sample={min:new Array(1000).fill(20),pts:Array.from({length:1000},(_,i)=>i%2?20:10),reb:new Array(1000).fill(4),ast:new Array(1000).fill(3),tpm:new Array(1000).fill(1)};
 for(const odds of [-110,-300,300]){const quote=quoteProp(sample,'pts','over',15,odds)!;assert.equal(decideVerdict(quote,propContextFromPlayer(p),'pts')!.verdict,'PASS');}
});
