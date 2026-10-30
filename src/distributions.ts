export interface DistributionSummary {mean:number;median:number;p05:number;p10:number;p90:number;p95:number;standardError:number}
export function summarizeDistribution(values:ArrayLike<number>):DistributionSummary{
 if(!values.length||Array.from(values).some(v=>!Number.isFinite(v)))throw new Error('Invalid distribution');
 const sorted=Array.from(values).sort((a,b)=>a-b),n=sorted.length,mean=sorted.reduce((a,b)=>a+b,0)/n;
 const q=(p:number)=>{const at=(n-1)*p,lo=Math.floor(at);return sorted[lo]+(sorted[Math.ceil(at)]-sorted[lo])*(at-lo);};
 return {mean,median:q(.5),p05:q(.05),p10:q(.1),p90:q(.9),p95:q(.95),standardError:Math.sqrt(sorted.reduce((s,x)=>s+(x-mean)**2,0)/Math.max(1,n-1)/n)};
}
export function lineProbability(values:ArrayLike<number>,line:number){
 if(!Number.isFinite(line)||!values.length)throw new Error('Invalid line');
 let over=0,under=0,push=0;
 for(const v of Array.from(values)){if(v>line)over++;else if(v<line)under++;else push++;}
 return {over:over/values.length,under:under/values.length,push:push/values.length};
}
export function discreteRead(values:ArrayLike<number>,shown:number){
 let below=0,equal=0;for(let i=0;i<values.length;i++){if(values[i]<shown)below++;if(values[i]===shown)equal++;}
 return {percent:values.length?100*(below+equal/2)/values.length:50,mass:values.length?equal/values.length:0};
}
