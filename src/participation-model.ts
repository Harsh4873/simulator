import type {CompletedEvent} from './parse-summary.ts';

/** One team game from a player's point of view. Absent means the team's explicit box listed active players and this player was not among them. */
export interface ParticipationStatus {played:boolean;minutes:number;starter:boolean|null;absent:boolean}
export interface ParticipationFit {coefficients:number[]|null;samples:number;brier:number|null;baseline_brier:number|null;log_loss?:number|null;baseline_log_loss?:number|null;reason:string|null;selection_events?:number;heldout_events?:number;penalty?:number;features?:readonly string[]}

export const PARTICIPATION_FEATURES=['intercept','role_minutes','played_last5','played_last','start_share','absent_last5','missed_streak'] as const;
const HISTORY_LIMIT=15;
const PRUNE_ABSENCES=15;
const PENALTIES=[0.1,1,10,100];

const sigmoid=(x:number)=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
const logLoss=(p:number,y:number)=>{const q=Math.min(1-1e-9,Math.max(1e-9,p));return -(y*Math.log(q)+(1-y)*Math.log(1-q));};

/** Features use only statuses before the game being predicted. */
export function participationFeatures(history:readonly ParticipationStatus[]):number[]{
 const last5=history.slice(-5),played=history.filter(s=>s.played).slice(-10),recentPlayed=played.slice(-5);
 const role=played.length?played.reduce((s,x)=>s+x.minutes,0)/played.length:0;
 let streak=0;for(let i=history.length-1;i>=0&&!history[i].played;i--)streak++;
 return [1,Math.min(48,role)/48,last5.length?last5.filter(s=>s.played).length/last5.length:0,history.at(-1)?.played?1:0,recentPlayed.length?recentPlayed.filter(s=>s.starter===true).length/recentPlayed.length:0,last5.length?last5.filter(s=>s.absent).length/last5.length:0,Math.min(10,streak)/10];
}
export function participationProbability(fit:ParticipationFit,features:number[]):number|null{return fit.coefficients?sigmoid(fit.coefficients.reduce((s,b,i)=>s+b*features[i],0)):null;}

interface Row {event:string;x:number[];y:number}

/**
 * Follows every player a team has listed in an explicit box (played or DNP).
 * A later explicit team box without that player counts as an absence until the player is listed by another team.
 * Legacy boxes without explicit participation add no statuses; omission there stays unknown.
 */
export class ParticipationTracker {
 private teams=new Map<string,Map<string,ParticipationStatus[]>>();
 private current=new Map<string,string>();
 private explicitGames=new Map<string,{season:number;start:string}[]>();
 private lastListed=new Map<string,string>();
 observe(e:CompletedEvent,collect?:(row:Row)=>void):void{
  for(const team of [e.away_team_id,e.home_team_id]){
   const listed=(e.participation??[]).filter(r=>r.team_id===team);
   if(!listed.length)continue;
   const present=new Map(listed.map(r=>[r.athlete_id,r]));
   const tracked=this.teams.get(team)??new Map<string,ParticipationStatus[]>();
   // A regular who vanishes from the box after playing has usually just been hurt or rested, which the pre-tip report shows;
   // those onset rows would teach the model to doubt every healthy regular. DNPs and continuing absences stay.
   if(collect)for(const [athlete,history] of tracked){const row=present.get(athlete);if(!row&&history.at(-1)?.played)continue;collect({event:e.event_id,x:participationFeatures(history),y:Number(row?.played===true)});}
   for(const [athlete,history] of tracked)if(!present.has(athlete)){history.push({played:false,minutes:0,starter:null,absent:true});if(history.length>HISTORY_LIMIT)history.shift();}
   for(const [athlete,row] of present){
    const box=e.players.find(p=>p.athlete_id===athlete&&p.team_id===team);
    const status:ParticipationStatus={played:row.played&&!!box&&box.minutes>0,minutes:row.played&&box?box.minutes:0,starter:row.starter??box?.starter??null,absent:false};
    const previous=this.current.get(athlete);
    if(previous&&previous!==team)this.teams.get(previous)?.delete(athlete);
    const history=tracked.get(athlete)??[];
    history.push(status);if(history.length>HISTORY_LIMIT)history.shift();
    tracked.set(athlete,history);this.current.set(athlete,team);this.lastListed.set(athlete,e.start_time);
   }
   for(const [athlete,history] of tracked)if(history.length>=PRUNE_ABSENCES&&history.slice(-PRUNE_ABSENCES).every(s=>s.absent)){tracked.delete(athlete);if(this.current.get(athlete)===team)this.current.delete(athlete);}
   this.teams.set(team,tracked);
   const games=this.explicitGames.get(team)??[];games.push({season:e.season,start:e.start_time});this.explicitGames.set(team,games);
  }
 }
 /**
  * Status history for a rostered player. A player last listed elsewhere keeps that stint's listed games and is absent for this
  * team's explicit boxes since then; a player never listed is absent for this team's explicit boxes this season.
  * Returns null only when nothing is known (no stint and no explicit team boxes this season).
  */
 history(team:string,athlete:string,season:number):ParticipationStatus[]|null{
  const own=this.teams.get(team)?.get(athlete);
  if(own&&this.current.get(athlete)===team)return own.slice();
  const since=this.lastListed.get(athlete);
  const missed=(this.explicitGames.get(team)??[]).filter(g=>g.season===season&&(!since||Date.parse(g.start)>Date.parse(since))).slice(-HISTORY_LIMIT).map(()=>({played:false,minutes:0,starter:null,absent:true}));
  const elsewhere=this.current.get(athlete);
  const before=elsewhere?this.teams.get(elsewhere)?.get(athlete)??[]:[];
  let end=before.length;while(end>0&&before[end-1].absent)end--;
  const combined=[...before.slice(0,end),...missed].slice(-HISTORY_LIMIT);
  return combined.length?combined:null;
 }
}

function solve(a:number[][],b:number[]):number[]{
 const n=b.length,m=a.map((row,i)=>[...row,b[i]]);
 for(let c=0;c<n;c++){
  let pivot=c;for(let r=c+1;r<n;r++)if(Math.abs(m[r][c])>Math.abs(m[pivot][c]))pivot=r;
  [m[c],m[pivot]]=[m[pivot],m[c]];
  const d=m[c][c];if(Math.abs(d)<1e-12)throw new Error('Singular participation system');
  for(let k=c;k<=n;k++)m[c][k]/=d;
  for(let r=0;r<n;r++)if(r!==c&&m[r][c]!==0){const f=m[r][c];for(let k=c;k<=n;k++)m[r][k]-=f*m[c][k];}
 }
 return m.map(row=>row[n]);
}

/** Ridge-penalized logistic regression by Newton steps; the intercept is not penalized. */
export function fitLogistic(rows:{x:number[];y:number}[],penalty:number):number[]{
 const k=rows[0]?.x.length??0;let b=new Array(k).fill(0);
 for(let iter=0;iter<30;iter++){
  const g=b.map((v,i)=>i===0?0:-penalty*v),h=Array.from({length:k},(_,i)=>Array.from({length:k},(_,j)=>i===j&&i>0?-penalty:0));
  for(const r of rows){const p=sigmoid(r.x.reduce((s,x,i)=>s+x*b[i],0)),w=p*(1-p);for(let i=0;i<k;i++){g[i]+=(r.y-p)*r.x[i];for(let j=0;j<k;j++)h[i][j]-=w*r.x[i]*r.x[j];}}
  const step=solve(h.map(row=>row.map(v=>-v)),g);
  b=b.map((v,i)=>v+step[i]);
  if(Math.max(...step.map(Math.abs))<1e-8)break;
 }
 return b;
}

export function participationRows(events:CompletedEvent[]):Row[]{
 const tracker=new ParticipationTracker(),rows:Row[]=[];
 for(const e of [...events].sort((a,b)=>a.start_time.localeCompare(b.start_time)||a.event_id.localeCompare(b.event_id)))tracker.observe(e,row=>rows.push(row));
 return rows;
}

export function fitParticipation(events:CompletedEvent[]):ParticipationFit{
 const rows=participationRows(events);
 const empty:ParticipationFit={coefficients:null,samples:rows.length,brier:null,baseline_brier:null,reason:'Fewer than 200 explicit as-of participation rows',features:PARTICIPATION_FEATURES};
 if(rows.length<200)return empty;
 const ids=[...new Set(rows.map(r=>r.event))],trainIds=new Set(ids.slice(0,Math.floor(ids.length*.6))),selectIds=new Set(ids.slice(Math.floor(ids.length*.6),Math.floor(ids.length*.8))),holdIds=new Set(ids.slice(Math.floor(ids.length*.8)));
 const train=rows.filter(r=>trainIds.has(r.event)),selection=rows.filter(r=>selectIds.has(r.event)),hold=rows.filter(r=>holdIds.has(r.event));
 if(!train.length||!selection.length||!hold.length)return {...empty,reason:'Insufficient independent event blocks'};
 const predict=(b:number[],r:Row)=>sigmoid(b.reduce((s,v,i)=>s+v*r.x[i],0));
 const mean=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
 const best=PENALTIES.map(penalty=>{const b=fitLogistic(train,penalty);return {penalty,loss:mean(selection.map(r=>logLoss(predict(b,r),r.y)))};}).sort((a,b)=>a.loss-b.loss||a.penalty-b.penalty)[0];
 const coefficients=fitLogistic([...train,...selection],best.penalty);
 const base=mean([...train,...selection].map(r=>r.y));
 const brier=mean(hold.map(r=>(predict(coefficients,r)-r.y)**2)),baseline=mean(hold.map(r=>(base-r.y)**2));
 const loss=mean(hold.map(r=>logLoss(predict(coefficients,r),r.y))),baselineLoss=mean(hold.map(r=>logLoss(base,r.y)));
 const report={samples:rows.length,brier,baseline_brier:baseline,log_loss:loss,baseline_log_loss:baselineLoss,selection_events:selectIds.size,heldout_events:holdIds.size,penalty:best.penalty,features:PARTICIPATION_FEATURES};
 if(loss>baselineLoss||brier>baseline)return {...empty,...report,reason:'Untouched holdout did not improve participation baseline'};
 // Final coefficients use every as-of row; the holdout above was scored before it was added.
 return {...report,coefficients:fitLogistic(rows,best.penalty),reason:null};
}

export interface HealthyCalibrationContext {
  career_minutes?: number;
  coach_dnp_last5?: number;
  inactive_last5?: number;
  missing_minutes?: number;
}
export interface HealthyCalibrationRow extends HealthyCalibrationContext {
  tip: string;
  p: number;
  y: number;
}
export interface HealthyCalibration {
  status: 'fitted' | 'unknown';
  a: number;
  b: number;
  coefficients?: number[];
  penalty?: number;
  rows: number;
  heldout_rows: number;
  log_loss: number | null;
  baseline_log_loss: number | null;
  reason: string | null;
}
const logit=(p:number)=>{const q=Math.min(1-1e-6,Math.max(1e-6,p));return Math.log(q/(1-q));};
export const MIN_CALIBRATION_ROWS=300;
const HEALTHY_PENALTIES=[0.5,1,3] as const;

function healthyFeatures(p:number,ctx?:HealthyCalibrationContext):number[]{
 const role=Math.min(40,Math.max(0,ctx?.career_minutes??0))/40;
 const dnp=Math.min(1,Math.max(0,ctx?.coach_dnp_last5??0));
 const inactive=Math.min(1,Math.max(0,ctx?.inactive_last5??0));
 const missing=Math.min(80,Math.max(0,ctx?.missing_minutes??0))/80;
 return [1,logit(p),role,dnp,inactive*role,missing];
}

/**
 * Participation rows include absences that a pre-tip injury report would already show. Archived pre-tip reports pair a
 * player listed healthy with the model probability, role/DNP/absence context, tonight's missing team minutes and the
 * settled outcome, fitting a regularized logistic map on earlier games and accepting it only when it beats baseline on later games.
 */
export function calibrateHealthy(rows:HealthyCalibrationRow[]):HealthyCalibration{
 const sorted=[...rows].filter(r=>Number.isFinite(r.p)&&Number.isFinite(Date.parse(r.tip))).sort((a,b)=>Date.parse(a.tip)-Date.parse(b.tip));
 const empty:HealthyCalibration={status:'unknown',a:0,b:1,rows:sorted.length,heldout_rows:0,log_loss:null,baseline_log_loss:null,reason:`Fewer than ${MIN_CALIBRATION_ROWS} archived healthy pre-tip rows`};
 if(sorted.length<MIN_CALIBRATION_ROWS)return empty;
 const tips=[...new Set(sorted.map(r=>r.tip))],cut=tips[Math.floor(tips.length*.7)];
 const fit=sorted.filter(r=>Date.parse(r.tip)<Date.parse(cut)),hold=sorted.filter(r=>Date.parse(r.tip)>=Date.parse(cut));
 if(fit.length<MIN_CALIBRATION_ROWS/2||!hold.length)return {...empty,reason:'Insufficient chronological calibration blocks'};
 const design1d=(xs:typeof sorted)=>xs.map(r=>({x:[1,logit(r.p)],y:r.y}));
 const [a,b]=fitLogistic(design1d(fit),0.01);
 const mean=(xs:number[])=>xs.reduce((s,x)=>s+x,0)/xs.length;
 const loss1d=mean(hold.map(r=>logLoss(sigmoid(a+b*logit(r.p)),r.y))),baseline=mean(hold.map(r=>logLoss(r.p,r.y)));
 const hasContext=sorted.some(r=>r.career_minutes!==undefined);
 if(hasContext){
  const innerTips=[...new Set(fit.map(r=>r.tip))];
  const innerCut=innerTips[Math.max(1,Math.floor(innerTips.length*.75))];
  const subTrain=fit.filter(r=>Date.parse(r.tip)<Date.parse(innerCut)),subVal=fit.filter(r=>Date.parse(r.tip)>=Date.parse(innerCut));
  const chosenPenalty=subTrain.length>=80&&subVal.length>=20
   ?HEALTHY_PENALTIES.map(pen=>{const coef=fitLogistic(subTrain.map(r=>({x:healthyFeatures(r.p,r),y:r.y})),pen);return {pen,loss:mean(subVal.map(r=>logLoss(sigmoid(healthyFeatures(r.p,r).reduce((s,v,i)=>s+v*coef[i],0)),r.y)))};}).sort((x,y)=>x.loss-y.loss||x.pen-y.pen)[0].pen
   :1;
  const coefHold=fitLogistic(fit.map(r=>({x:healthyFeatures(r.p,r),y:r.y})),chosenPenalty);
  const lossMulti=mean(hold.map(r=>logLoss(sigmoid(healthyFeatures(r.p,r).reduce((s,v,i)=>s+v*coefHold[i],0)),r.y)));
  if(lossMulti<baseline&&lossMulti<=loss1d&&coefHold[1]>0){
   const [fa,fb]=fitLogistic(design1d(sorted),0.01);
   const finalCoef=fitLogistic(sorted.map(r=>({x:healthyFeatures(r.p,r),y:r.y})),chosenPenalty);
   return {status:'fitted',a:fa,b:fb,coefficients:finalCoef,penalty:chosenPenalty,rows:sorted.length,heldout_rows:hold.length,log_loss:lossMulti,baseline_log_loss:baseline,reason:null};
  }
 }
 if(!(loss1d<baseline)||!(b>0))return {...empty,heldout_rows:hold.length,log_loss:loss1d,baseline_log_loss:baseline,reason:'Calibration did not improve later archived games'};
 const [fa,fb]=fitLogistic(design1d(sorted),0.01);
 return {status:'fitted',a:fa,b:fb,rows:sorted.length,heldout_rows:hold.length,log_loss:loss1d,baseline_log_loss:baseline,reason:null};
}
export function applyHealthyCalibration(calibration:HealthyCalibration|null|undefined,p:number,context?:HealthyCalibrationContext):number{
 if(calibration?.status!=='fitted')return p;
 if(context&&Array.isArray(calibration.coefficients)&&calibration.coefficients.length===6){
  const feats=healthyFeatures(p,context);
  return sigmoid(feats.reduce((s,v,i)=>s+v*calibration.coefficients![i],0));
 }
 return sigmoid(calibration.a+calibration.b*logit(p));
}
