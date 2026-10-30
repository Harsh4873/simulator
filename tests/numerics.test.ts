import test from 'node:test';
import assert from 'node:assert/strict';
import {gammaMean1,poisson,mulberry32} from '../src/rng.ts';
import {gradeProp} from '../src/props.ts';
test('gamma and Poisson moments support fractional shapes and means above 80',()=>{
 for(const shape of [.5,1,2.5,10]){
  const rng=mulberry32(818),xs=Array.from({length:20000},()=>gammaMean1(shape,rng));
  const m=xs.reduce((a,b)=>a+b,0)/xs.length,v=xs.reduce((a,b)=>a+(b-m)**2,0)/xs.length;
  assert.ok(Math.abs(m-1)<.04);assert.ok(Math.abs(v-1/shape)<.1);
 }
 for(const mu of [0,79,81,160]){
  const rng=mulberry32(99),xs=Array.from({length:10000},()=>poisson(mu,rng));
  assert.ok(Math.abs(xs.reduce((a,b)=>a+b,0)/xs.length-mu)<.5);
 }
 for(const x of [-1,NaN,Infinity])assert.throws(()=>poisson(x,mulberry32(1)));
 assert.throws(()=>gammaMean1(Infinity,mulberry32(1)));
});
test('defensive props use the correct series and reject missing or invalid inputs',()=>{
 const s={min:[30,30,0],pts:[20,10,0],reb:[4,5,0],ast:[2,3,0],tpm:[2,0,0],stl:[1,2,0],blk:[0,1,0],tov:[3,2,0]};
 assert.deepEqual(gradeProp(s,'stl','over',1.5),{wins:1,losses:1,pushes:0,voids:1});
 for(const line of [-1,NaN,.25])assert.throws(()=>gradeProp(s,'pts','over',line));
 assert.throws(()=>gradeProp({...s,stl:undefined},'stl','over',.5));
});
