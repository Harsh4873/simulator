import { readFileSync } from 'node:fs';
import { simulate } from '../src/simulate.ts';
import { fnv1a } from '../src/rng.ts';
import type { RateCard, Slate } from '../src/types.ts';
const card: RateCard=JSON.parse(readFileSync('public/data/rate-card.json','utf8'));
const slate: Slate=JSON.parse(readFileSync('public/data/slate.json','utf8'));
const rows=card.games.map(g=>{
  const s=slate.games.find(x=>x.event_id===g.event_id)!;
  const start=performance.now();
  const r=simulate(g,fnv1a(`${g.event_id}:${card.generated_at ?? ''}`));
  const avg=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
  return {game:`${s.away.abbreviation}@${s.home.abbreviation}`,simTotal:+avg(r.combinedTotals).toFixed(1),simHomeSpread:+(avg(r.awayTotals)-avg(r.homeTotals)).toFixed(1),homeWin:+(100*r.wins.home/r.homeTotals.length).toFixed(1),milliseconds:Math.round(performance.now()-start)};
});
console.log(JSON.stringify({generated_at:card.generated_at,rows},null,2));
