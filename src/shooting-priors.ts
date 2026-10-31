import type {CompletedEvent,ParsedPlayerGame} from './parse-summary.ts';
export const SHOT_KEYS=['share','fg2','tp','ft'] as const;
type Key=typeof SHOT_KEYS[number];type Counts=Record<Key,{s:number;n:number}>;
export interface ShootingPriorFit {heldout_samples?:number;heldout_loss?:Partial<Record<Key,number>>;heldout_baseline_loss?:Partial<Record<Key,number>>;accepted?:Partial<Record<Key,boolean>>;strengths:Record<Key,number>;samples:number;source:'chronological-selection'|'labelled-prior';roles:Record<string,string>;rates:Record<string,Partial<Record<Key,number>>>;player_rates:Record<string,Partial<Record<Key,number>>>;loss:Partial<Record<Key,number>>;baseline_loss:Partial<Record<Key,number>>}
const empty=():Counts=>Object.fromEntries(SHOT_KEYS.map(k=>[k,{s:0,n:0}])) as Counts;
const archetype=(own:Counts,role:string)=>own.share.n<100?role:own.share.s/own.share.n<.02?'interior':own.share.s/own.share.n>.4?'perimeter':role; // Explicit shot-mix bins, not fitted cutoffs.
const counts=(p:ParsedPlayerGame):Counts=>({share:{s:p.tpa,n:p.fga},fg2:{s:p.fgm-p.tpm,n:p.fga-p.tpa},tp:{s:p.tpm,n:p.tpa},ft:{s:p.ftm,n:p.fta}});
export function fitShootingPriors(events:CompletedEvent[],season:number):ShootingPriorFit{
 const strengths={share:80,fg2:60,tp:40,ft:30},candidates=[10,30,60,120,240],loss=Object.fromEntries(SHOT_KEYS.map(k=>[k,candidates.map(()=>0)])) as Record<Key,number[]>;
 const heldLoss=Object.fromEntries(SHOT_KEYS.map(k=>[k,candidates.map(()=>0)])) as Record<Key,number[]>;
 const heldBaseline={share:0,fg2:0,tp:0,ft:0},heldAttempts={share:0,fg2:0,tp:0,ft:0};let heldSamples=0;
 const sorted=[...events].sort((a,b)=>a.start_time.localeCompare(b.start_time)),priorEvents=sorted.filter(e=>e.season<season),heldIds=new Set(priorEvents.slice(Math.floor(priorEvents.length*.8)).map(e=>e.event_id));
 const baseline={share:0,fg2:0,tp:0,ft:0},attempts={share:0,fg2:0,tp:0,ft:0};
 const players=new Map<string,Counts>(),roles:Record<string,string>={},groups=new Map<string,Counts>(),league=empty(),members=new Map<string,Counts>();let samples=0;
 for(const e of sorted){
  for(const p of e.players){
   const own=players.get(p.athlete_id)??empty(),role=archetype(own,roles[p.athlete_id]??'unknown'),group=groups.get(role)??empty(),target=counts(p);
   if(e.season<season&&own.share.n>=10&&league.share.n>=100){const held=heldIds.has(e.event_id);if(held)heldSamples++;else samples++;
    for(const k of SHOT_KEYS){if(!league[k].n||!target[k].n)continue;const member=members.get(`${p.athlete_id}:${role}`)??empty(),leagueRate=(league[k].s-own[k].s)/Math.max(1,league[k].n-own[k].n);const prior=(group[k].s-member[k].s+30*leagueRate)/(group[k].n-member[k].n+30); // 30-attempt league shrinkage prior for sparse roles.
     const score=(prob:number)=>target[k].s*(1-prob)**2+(target[k].n-target[k].s)*prob**2;
     candidates.forEach((strength,i)=>(held?heldLoss:loss)[k][i]+=score((own[k].s+strength*prior)/(own[k].n+strength)));
     (held?heldBaseline:baseline)[k]+=score((own[k].s+strengths[k]*leagueRate)/(own[k].n+strengths[k]));(held?heldAttempts:attempts)[k]+=target[k].n;
    }
   }
  }
  for(const p of e.players){const own=players.get(p.athlete_id)??empty(),role=archetype(own,roles[p.athlete_id]??'unknown'),group=groups.get(role)??empty(),target=counts(p);
   const member=members.get(`${p.athlete_id}:${role}`)??empty();
   for(const k of SHOT_KEYS){for(const dest of [own,group,league,member]){dest[k].s+=target[k].s;dest[k].n+=target[k].n;}}
   members.set(`${p.athlete_id}:${role}`,member);players.set(p.athlete_id,own);groups.set(role,group);if(p.starter!==undefined)roles[p.athlete_id]=p.starter?'starter':'bench';
  }
 }
 const heldout_loss:Partial<Record<Key,number>>={},heldout_baseline_loss:Partial<Record<Key,number>>={},accepted:Partial<Record<Key,boolean>>={};
 const selected:Partial<Record<Key,number>>={},base:Partial<Record<Key,number>>={};
 for(const k of SHOT_KEYS)if(samples>=100&&attempts[k]>0){const i=loss[k].indexOf(Math.min(...loss[k]));strengths[k]=candidates[i];selected[k]=loss[k][i]/attempts[k];base[k]=baseline[k]/attempts[k];if(heldAttempts[k]>0){heldout_loss[k]=heldLoss[k][i]/heldAttempts[k];heldout_baseline_loss[k]=heldBaseline[k]/heldAttempts[k];accepted[k]=heldout_loss[k]!<=heldout_baseline_loss[k]!;}}
 const rates=Object.fromEntries([...groups].map(([role,g])=>[role,Object.fromEntries(SHOT_KEYS.filter(k=>league[k].n>0).map(k=>[k,(g[k].s+30*league[k].s/league[k].n)/(g[k].n+30)]))]));
 const player_rates:Record<string,Partial<Record<Key,number>>>={};
 for(const [id,own] of players){const role=archetype(own,roles[id]??'unknown');roles[id]=role;const group=groups.get(role)??empty(),member=members.get(`${id}:${role}`)??empty();player_rates[id]=Object.fromEntries(SHOT_KEYS.filter(k=>league[k].n>own[k].n).map(k=>[k,(group[k].s-member[k].s+30*(league[k].s-own[k].s)/(league[k].n-own[k].n))/(group[k].n-member[k].n+30)]));}
 return {heldout_samples:heldSamples,heldout_loss,heldout_baseline_loss,accepted,player_rates,strengths,samples,source:samples>=100?'chronological-selection':'labelled-prior',roles,rates,loss:selected,baseline_loss:base};
}
