import type {CompletedEvent} from './parse-summary.ts';
export interface ParticipationFit {coefficients:number[]|null;samples:number;brier:number|null;baseline_brier:number|null;reason:string|null}
const sigmoid=(x:number)=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
export function participationFeatures(minutes:number,recentPlay:number,starter:number|null):number[]{return [1,Math.min(48,minutes)/48,recentPlay,starter??recentPlay];}
export function participationProbability(fit:ParticipationFit,features:number[]):number|null{return fit.coefficients?sigmoid(fit.coefficients.reduce((s,b,i)=>s+b*features[i],0)):null;}
export function fitParticipation(events:CompletedEvent[]):ParticipationFit{
 const history=new Map<string,{minutes:number;played:boolean;starter:boolean|null}[]>(),rows:{event:string;x:number[];y:number}[]=[];
 for(const e of [...events].sort((a,b)=>a.start_time.localeCompare(b.start_time)))for(const p of e.participation??[]){
  const key=`${p.team_id}:${p.athlete_id}`,past=history.get(key)??[],recent=past.slice(-5),played=recent.filter(r=>r.played);
  if(recent.length>=2)rows.push({event:e.event_id,x:participationFeatures(played.length?played.reduce((s,x)=>s+x.minutes,0)/played.length:0,recent.filter(x=>x.played).length/recent.length,recent.at(-1)?.starter===null?null:Number(recent.at(-1)?.starter)),y:Number(p.played)});
  past.push({minutes:e.players.find(r=>r.athlete_id===p.athlete_id)?.minutes??0,played:p.played,starter:p.starter});history.set(key,past);
 }
 const empty={coefficients:null,samples:rows.length,brier:null,baseline_brier:null,reason:'Fewer than 200 explicit as-of participation rows'};
 if(rows.length<200)return empty;
 const ids=[...new Set(rows.map(r=>r.event))],holdIds=new Set(ids.slice(Math.floor(ids.length*.8)));
 const train=rows.filter(r=>!holdIds.has(r.event)),hold=rows.filter(r=>holdIds.has(r.event));
 if(!train.length||!hold.length)return {...empty,reason:'Insufficient independent event blocks'};
 const fit=(xs:typeof rows,penalty:number)=>{const b=[0,0,0,0];for(let iter=0;iter<120;iter++){const gradient=b.map(v=>-penalty*v);for(const r of xs){const residual=r.y-sigmoid(b.reduce((s,v,i)=>s+v*r.x[i],0));r.x.forEach((x,i)=>gradient[i]+=x*residual);}b.forEach((_,i)=>b[i]+=gradient[i]/xs.length);}return b;};
 const candidates=[1,10,50].map(penalty=>{const coefficients=fit(train,penalty);const loss=hold.reduce((s,r)=>s+(sigmoid(coefficients.reduce((v,b,i)=>v+b*r.x[i],0))-r.y)**2,0)/hold.length;return {penalty,coefficients,loss};});
 const best=candidates.sort((a,b)=>a.loss-b.loss)[0],base=train.reduce((s,r)=>s+r.y,0)/train.length,baseline=hold.reduce((s,r)=>s+(base-r.y)**2,0)/hold.length;
 if(best.loss>baseline)return {...empty,brier:best.loss,baseline_brier:baseline,reason:'Chronological holdout did not improve participation baseline'};
 return {coefficients:fit(rows,best.penalty),samples:rows.length,brier:best.loss,baseline_brier:baseline,reason:null};
}
