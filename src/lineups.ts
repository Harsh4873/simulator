import type { Rng } from './rng.ts';
/** Realize integer minute degrees as five-player one-minute stints. */
export function minuteLineups(minutes:readonly number[],periodLength:number,rng:Rng,roles?:{opening:number[];closing:number[]}):number[][] {
  if(!Number.isInteger(periodLength)||periodLength<1||minutes.some(m=>!Number.isInteger(m)||m<0||m>periodLength)||minutes.reduce((a,b)=>a+b,0)!==5*periodLength)throw new Error('Infeasible stint budget');
  const remaining=[...minutes],stints:number[][]=[];
  const roleLineup=(weights:number[],slots:number)=>{
    const order=remaining.map((m,i)=>({m,i,tie:rng(),role:weights[i]??0})).filter(x=>x.m>0).sort((a,b)=>Number(b.m===slots)-Number(a.m===slots)||b.role-a.role||b.m-a.m||a.tie-b.tie);
    const chosen=order.slice(0,5).map(x=>x.i);chosen.forEach(i=>remaining[i]--);return chosen;
  };
  const closing=roles&&roles.closing.some(x=>x>0)?roleLineup(roles.closing,periodLength):null;
  const slots=periodLength-(closing?1:0);
  for(let minute=0;minute<slots;minute++){
    if(minute===0&&roles&&roles.opening.some(x=>x>0)){stints.push(roleLineup(roles.opening,slots));continue;}
    const order=remaining.map((m,i)=>({m,i,tie:rng()})).filter(x=>x.m>0).sort((a,b)=>b.m-a.m||a.tie-b.tie);
    if(order.length<5)throw new Error('Fewer than five players in a stint');
    const lineup=order.slice(0,5).map(x=>x.i);lineup.forEach(i=>remaining[i]--);stints.push(lineup);
  }
  if(closing)stints.push(closing);
  if(remaining.some(x=>x!==0))throw new Error('Unallocated stint minutes');return stints;
}
export interface GameState { seconds_remaining:number; margin:number; period:number; team_fouls:number|null }
export interface Tactics { validated:boolean; sample_count:number; late_seconds:number; close_margin:number; intentional_foul_probability:number; garbage_margin:number; bench_usage_multiplier:number; trip_weights:[number,number,number] }
export function tacticalState(state:GameState,fit:Tactics|null|undefined):{intentional_foul_probability:number;bench_usage_multiplier:number;trip_weights:[number,number,number]|null;status:'fitted'|'unknown'} {
  if(!fit||!fit.validated||fit.sample_count<100)return {intentional_foul_probability:0,bench_usage_multiplier:1,trip_weights:null,status:'unknown'};
  if(fit.trip_weights.some(x=>!Number.isFinite(x)||x<0)||Math.abs(fit.trip_weights.reduce((a,b)=>a+b,0)-1)>1e-6||fit.intentional_foul_probability<0||fit.intentional_foul_probability>1)throw new Error('Invalid tactical fit');
  return {intentional_foul_probability:state.seconds_remaining<=fit.late_seconds&&state.margin<0&&-state.margin<=fit.close_margin?fit.intentional_foul_probability:0,bench_usage_multiplier:Math.abs(state.margin)>=fit.garbage_margin?fit.bench_usage_multiplier:1,trip_weights:fit.trip_weights,status:'fitted'};
}
