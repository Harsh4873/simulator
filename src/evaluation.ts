export function mean(xs: number[]): number { return xs.reduce((a,b)=>a+b,0)/xs.length; }
export function crps(draws: number[], actual: number): number {
  if(!draws.length || !Number.isFinite(actual) || draws.some(x=>!Number.isFinite(x)))throw new Error('Invalid scoring inputs');
  const sorted=draws.slice().sort((a,b)=>a-b),n=sorted.length;
  return mean(draws.map(x=>Math.abs(x-actual))) - sorted.reduce((s,x,i)=>s+(2*i-n+1)*x,0)/(n*n);
}
export function scoreDistribution(draws:number[],actual:number) {
  const sorted=draws.slice().sort((a,b)=>a-b);
  const q=(p:number)=>sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
  return {error:mean(draws)-actual,mae:Math.abs(mean(draws)-actual),crps:crps(draws,actual),coverage80:Number(actual>=q(.1)&&actual<=q(.9)),coverage90:Number(actual>=q(.05)&&actual<=q(.95))};
}
export function scoreProbability(p:number,actual:boolean) {
  if(!Number.isFinite(p)||p<0||p>1)throw new Error('Invalid probability');
  const y=Number(actual),v=Math.max(1e-12,Math.min(1-1e-12,p));
  return {brier:(p-y)**2,logLoss:-(y*Math.log(v)+(1-y)*Math.log(1-v))};
}
export function reliability(rows:{p:number;y:number}[]) {
  const bins=Array.from({length:10},(_,i)=>rows.filter(r=>Math.min(9,Math.floor(r.p*10))===i));
  return {ece:bins.reduce((s,b)=>s+(b.length?Math.abs(mean(b.map(r=>r.p))-mean(b.map(r=>r.y)))*b.length:0),0)/Math.max(1,rows.length),bins:bins.map(b=>({n:b.length,p:b.length?mean(b.map(r=>r.p)):null,actual:b.length?mean(b.map(r=>r.y)):null}))};
}
