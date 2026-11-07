import type {CompletedEvent} from './parse-summary.ts';

/**
 * Real games give part of a lead back: in permitted play histories the fourth quarter returns about a tenth of the
 * lead it starts with, after controlling for team strength. Independent possessions cannot do that, which left the
 * simulated margin spread too wide. The fitted give-back becomes a small tilt on field-goal makes that favors the
 * trailing team.
 */
export interface LeadEffectModel {
  status:'fitted'|'unknown';
  /** Log make-probability change per ten points of the shooting team's lead, as a positive number. */
  early:number;
  late:number;
  /** Share of a quarter's starting departure from the expected margin path returned during that quarter (negative means given back). */
  coefficients:{early:number;late:number};
  games:number;
  heldout_games:number;
  mse:number|null;
  baseline_mse:number|null;
  reason:string|null;
}
export const MAX_LEAD_TILT=0.1;
const empty=(games:number,reason:string):LeadEffectModel=>({status:'unknown',early:0,late:0,coefficients:{early:0,late:0},games,heldout_games:0,mse:null,baseline_mse:null,reason});

/** Home margins at the end of quarters one to four, when the last regulation play agrees with the box. */
export function quarterMargins(e:CompletedEvent):[number,number,number,number]|null{
 const plays=e.play_history?.plays;
 if(!plays?.length||e.periods<4)return null;
 const end=[NaN,NaN,NaN,NaN];
 for(const p of plays)if(p.period>=1&&p.period<=4)end[p.period-1]=p.home-p.away;
 if(end.some(x=>!Number.isFinite(x)))return null;
 if(e.periods===4?end[3]!==e.home_pts-e.away_pts:end[3]!==0)return null;
 return end as [number,number,number,number];
}

interface Row {time:number;x:number[];y:number}
function solve(rows:Row[]):number[]|null{
 const k=rows[0]?.x.length??0;if(!k||rows.length<=k)return null;
 const a=Array.from({length:k},()=>new Array(k+1).fill(0));
 for(const r of rows)for(let i=0;i<k;i++){for(let j=0;j<k;j++)a[i][j]+=r.x[i]*r.x[j];a[i][k]+=r.x[i]*r.y;}
 for(let c=0;c<k;c++){
  let p=c;for(let r=c+1;r<k;r++)if(Math.abs(a[r][c])>Math.abs(a[p][c]))p=r;
  [a[c],a[p]]=[a[p],a[c]];if(Math.abs(a[c][c])<1e-9)return null;
  for(let r=0;r<k;r++)if(r!==c){const f=a[r][c]/a[c][c];for(let j=c;j<=k;j++)a[r][j]-=f*a[c][j];}
 }
 return a.map((row,i)=>row[k]/row[i]);
}
const mse=(rows:Row[],b:number[])=>rows.reduce((s,r)=>s+(r.y-r.x.reduce((v,x,i)=>v+x*b[i],0))**2,0)/rows.length;

/**
 * expectedMargin gives the pre-game home margin for a completed event (a team-strength control; it may be in-sample).
 * fgPointsPerPossession and possessionsPerQuarter convert the quarter coefficient into the per-shot tilt.
 */
export function fitLeadEffect(events:CompletedEvent[],expectedMargin:(e:CompletedEvent)=>number|null,fgPointsPerPossession:number,possessionsPerQuarter:number):LeadEffectModel{
 const games:{time:number;rows:Row[]}[]=[];
 for(const e of [...events].sort((a,b)=>a.start_time.localeCompare(b.start_time))){
  const q=quarterMargins(e),expected=expectedMargin(e);
  if(!q||expected===null||!Number.isFinite(expected))continue;
  const time=Date.parse(e.start_time);
  // Quarter change = intercept + expected quarter margin + early/late share of the lead's departure from its expected path.
  // Ratings are fitted on final scores that already include give-back, so only departures are pulled back.
  games.push({time,rows:[0,1,2].map(i=>{const departure=q[i]-expected*(i+1)/4;return {time,x:[1,expected/4,i<2?departure:0,i===2?departure:0],y:q[i+1]-q[i]};})});
 }
 if(games.length<200)return empty(games.length,'Fewer than 200 games with reconciled quarter scores');
 const split=Math.floor(games.length*0.7);
 const train=games.slice(0,split).flatMap(g=>g.rows),hold=games.slice(split).flatMap(g=>g.rows);
 const full=solve(train),base=solve(train.map(r=>({...r,x:r.x.slice(0,2)})));
 if(!full||!base)return empty(games.length,'Singular quarter regression');
 // A positive coefficient would push leads further apart; that is not modelled, so it is held at zero.
 const clamp=(b:number[])=>[b[0],b[1],Math.min(0,b[2]),Math.min(0,b[3])];
 const heldout=mse(hold,clamp(full)),baseline=mse(hold.map(r=>({...r,x:r.x.slice(0,2)})),base);
 const report={games:games.length,heldout_games:games.length-split,mse:heldout,baseline_mse:baseline};
 if(!(heldout<baseline))return {...empty(games.length,'Lead give-back did not improve later games'),...report};
 const all=solve(games.flatMap(g=>g.rows));
 if(!all)return empty(games.length,'Singular quarter regression');
 const [,,early,late]=clamp(all);
 // Over a quarter, a log tilt t per ten points of lead moves the margin by about -2 * fgPoints * possessions * t/10 per point of lead.
 const scale=2*fgPointsPerPossession*possessionsPerQuarter/10;
 const tilt=(c:number)=>Math.min(MAX_LEAD_TILT,Math.max(0,-c/scale));
 return {status:'fitted',early:tilt(early),late:tilt(late),coefficients:{early,late},...report,reason:null};
}

/** Log make-probability change for the shooting team, from its lead minus the lead its ratings imply by now. Quarter 4 and overtime use the late tilt. */
export function leadTilt(model:LeadEffectModel|undefined,departure:number,late:boolean):number{
 if(model?.status!=='fitted')return 0;
 return -(late?model.late:model.early)*departure/10;
}

/**
 * Out-of-sample pre-game home margins from a points Elo updated only after each game, so the strength control never
 * sees the game it describes. Ratings shrink a quarter of the way to zero between seasons.
 */
export function runningMargins(events:CompletedEvent[],k=0.08,carry=0.75):Map<string,number>{
 const rating=new Map<string,number>(),out=new Map<string,number>();
 let home=2,homeGames=0,season:number|null=null;
 for(const e of [...events].sort((a,b)=>a.start_time.localeCompare(b.start_time)||a.event_id.localeCompare(b.event_id))){
  if(season!==null&&e.season!==season)for(const [t,r] of rating)rating.set(t,r*carry);
  season=e.season;
  const h=rating.get(e.home_team_id)??0,a=rating.get(e.away_team_id)??0,venue=e.neutral?0:home;
  const expected=h-a+venue;
  out.set(e.event_id,expected);
  const error=(e.home_pts-e.away_pts)-expected;
  rating.set(e.home_team_id,h+k*error);rating.set(e.away_team_id,a-k*error);
  if(!e.neutral){homeGames++;home+=(e.home_pts-e.away_pts-(h-a)-home)/Math.min(homeGames,400);}
 }
 return out;
}
