import type { CompletedEvent } from './parse-summary.ts';
import type { RatePlayer } from './types.ts';
export type EvidenceState = 'observed' | 'thin' | 'stale' | 'missing';
export interface StatEvidence { state: EvidenceState; exposure: number; games: number; last_observed: string | null; prior_fraction: number; standard_error: number | null }
export interface PlayerEvidence { minutes: StatEvidence; shooting: StatEvidence; reb: StatEvidence; ast: StatEvidence; stl: StatEvidence; blk: StatEvidence; role_changed: boolean; availability: 'observed' | 'scenario-prior'; historical_roster_coverage: 'unknown' | 'complete' }
export interface CalibrationArtifact {
  model_version: string; input_hash: string; training_cutoff: string; evaluated_through: string;
  games: number; settled_markets: number; margin_bias: number; total_bias: number; coverage80: number; coverage90: number; ece: number;
  baseline_improvement: boolean; market_noninferiority: boolean | null;
  markets: string[]; status: 'passed' | 'failed';
}
export function calibrationIssue(a: CalibrationArtifact | null | undefined, version: string, market: string, cutoff: string): string | null {
  if(!a)return 'Calibration artifact unavailable';
  if(a.model_version!==version || !/^[a-f0-9]{64}$/.test(a.input_hash))return 'Calibration provenance mismatch';
  if(!Number.isFinite(Date.parse(cutoff))||!Number.isFinite(Date.parse(a.training_cutoff)) || !Number.isFinite(Date.parse(a.evaluated_through)) || Date.parse(a.training_cutoff)>=Date.parse(a.evaluated_through) || Date.parse(a.evaluated_through)>=Date.parse(cutoff))return 'Invalid calibration cutoff';
  if([a.games,a.settled_markets,a.margin_bias,a.total_bias,a.coverage80,a.coverage90,a.ece].some(x=>!Number.isFinite(x)))return 'Invalid calibration metrics';
  if(a.ece<0||a.coverage80<0||a.coverage80>1||a.coverage90<0||a.coverage90>1||!Number.isInteger(a.games)||!Number.isInteger(a.settled_markets))return 'Invalid calibration metric bounds';
  if(a.status!=='passed'||a.games<500||a.settled_markets<2000||Math.abs(a.margin_bias)>1||Math.abs(a.total_bias)>2||Math.abs(a.coverage80-.8)>.03||Math.abs(a.coverage90-.9)>.03||a.ece>.03||!a.baseline_improvement||a.market_noninferiority!==true||!a.markets.includes(market))return 'Calibration release gates not passed';
  return null;
}
export function addEvidence(players: RatePlayer[], history: CompletedEvent[], cutoff: string): void {
  for(const p of players){
    const rows=history.flatMap(e=>e.players.filter(r=>r.athlete_id===p.athlete_id).map(r=>({r,date:e.start_time,weight:e.season===p.active_season?1:.2})));
    const stat=(key:'minutes'|'shooting'|'reb'|'ast'|'stl'|'blk'):StatEvidence=>{
      const xs=rows.filter(x=>key==='minutes'||key==='shooting'||x.r[key]!==undefined);
      const exposure=xs.reduce((n,x)=>n+x.weight*(key==='minutes'?1:key==='shooting'?x.r.fga:x.r.minutes),0);
      const last=xs.map(x=>x.date).sort().at(-1)??null;
      const k=key==='minutes'?p.role_prior_games??3:key==='shooting'?60:200;
      const values=xs.map(x=>key==='minutes'?x.r.minutes:key==='shooting'?x.r.fgm/Math.max(1,x.r.fga):x.r[key]!/x.r.minutes);
      const avg=values.reduce((a,b)=>a+b,0)/Math.max(1,values.length);
      const se=values.length>1?Math.sqrt(values.reduce((n,x)=>n+(x-avg)**2,0)/(values.length*(values.length-1))):null;
      return {state:!xs.length?'missing':Date.parse(cutoff)-Date.parse(last!)>30*86400000?'stale':exposure<k?'thin':'observed',exposure,games:xs.length,last_observed:last,prior_fraction:k/(k+exposure),standard_error:se};
    };
    const recent=rows.slice(-5);
    p.evidence={minutes:stat('minutes'),shooting:stat('shooting'),reb:stat('reb'),ast:stat('ast'),stl:stat('stl'),blk:stat('blk'),role_changed:recent.some(x=>x.r.team_id!==p.team_id),availability:(p.availability_calibration_n??0)>0?'observed':'scenario-prior',historical_roster_coverage:p.participation_coverage?.unknown===0?'complete':'unknown'};
  }
}
export interface AvailabilityObservation { event_id?:string;expected_minutes?:number;athlete_id:string; report_at:string; tip:string; settled_at:string; designation:string; played:boolean; minutes:number; roster_known:boolean }
export function fitAvailability(rows: AvailabilityObservation[], designation:string, cutoff:string): {probability:number; conditional_minutes:number|null;minutes_multiplier:number|null; n:number} | null {
  const unique=[...new Map(rows.map(r=>[`${r.athlete_id}:${r.event_id??r.tip}`,r])).values()];
  const xs=unique.filter(r=>r.designation===designation && r.roster_known && Date.parse(r.report_at)<Date.parse(r.tip) && Date.parse(r.tip)<Date.parse(r.settled_at) && Date.parse(r.settled_at)<Date.parse(cutoff) && Number.isFinite(r.minutes)&&r.minutes>=0&&r.played===(r.minutes>0));
  if(xs.length<30)return null; // Minimum evidence guard, not a fitted probability.
  const played=xs.filter(r=>r.played);
  const ratios=played.filter(r=>r.expected_minutes!==undefined&&r.expected_minutes>0).map(r=>r.minutes/r.expected_minutes!);
  return {minutes_multiplier:ratios.length>=30?ratios.reduce((a,b)=>a+b,0)/ratios.length:null,probability:played.length/xs.length,conditional_minutes:played.length?played.reduce((n,r)=>n+r.minutes,0)/played.length:null,n:xs.length};
}
export type UnavailableFeature = 'lineup_defense'|'absence_efficiency'|'residual_covariance'|'travel'|'ft_trip_types'|'late_game_tactics'|'foul_outs';
export interface EffectEvidence { feature:UnavailableFeature; training_cutoff:string; model_version:string; sample_count:number; coefficient:number; validated:boolean }
export function supportedEffect(effect:EffectEvidence|null|undefined,feature:UnavailableFeature,version:string,cutoff:string):number|null {
  return effect?.feature===feature&&effect.model_version===version&&effect.validated&&effect.sample_count>=30&&Number.isFinite(effect.coefficient)&&Date.parse(effect.training_cutoff)<Date.parse(cutoff)?effect.coefficient:null;
}
export const MISSING_FEATURES:UnavailableFeature[]=['lineup_defense','absence_efficiency','residual_covariance','travel','ft_trip_types','late_game_tactics','foul_outs'];
