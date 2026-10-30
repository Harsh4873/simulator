import type { Rng } from './rng.ts';
/** Exact Bernoulli draw conditional on at least k successes, without forcing any zero-probability entry. */
export function conditionalParticipants(probabilities:readonly number[],k:number,rng:Rng):boolean[] {
  if(!Number.isInteger(k)||k<0||probabilities.some(p=>!Number.isFinite(p)||p<0||p>1))throw new Error('Invalid availability probabilities');
  const n=probabilities.length,tail=Array.from({length:n+1},()=>new Array(k+1).fill(0));
  tail[n][0]=1;
  for(let i=n-1;i>=0;i--){tail[i][0]=1;for(let need=1;need<=k;need++)tail[i][need]=probabilities[i]*tail[i+1][need-1]+(1-probabilities[i])*tail[i+1][need];}
  if(!(tail[0][k]>0))throw new Error('Insufficient eligible rotation for regulation and overtime');
  let need=k;
  return probabilities.map((p,i)=>{const yes=need===0?p:p*tail[i+1][need-1]/tail[i][need];const included=rng()<yes;if(included)need=Math.max(0,need-1);return included;});
}
