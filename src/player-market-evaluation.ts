import {scoreProbability} from './evaluation.ts';
/** Evaluation inputs only. A missing archived line/quote is never reconstructed from a prediction. */
export interface SettledPlayerMarket {event_id:string;athlete_id:string;stat:'pts'|'reb'|'ast'|'tpm'|'stl'|'blk'|'tov';line:number;captured_at:string;tip:string;settled_at:string;actual:number;played:boolean;source:'ESPN scoreboard'|'PickLedger public outcome';}
export function scorePlayerMarket(market:SettledPlayerMarket,draws:{min:ArrayLike<number>;value:ArrayLike<number>},cutoff:string):{brier:number;logLoss:number;p:number;y:number;n:number}|null{
 if(!Number.isFinite(market.line)||!Number.isFinite(market.actual)||!market.played||market.actual===market.line||!(Date.parse(market.captured_at)<Date.parse(market.tip)&&Date.parse(market.tip)<Date.parse(market.settled_at)&&Date.parse(market.settled_at)<Date.parse(cutoff))||draws.min.length!==draws.value.length)return null;
 const values=Array.from(draws.value).filter((x,i)=>draws.min[i]>0&&x!==market.line&&Number.isFinite(x));if(!values.length)return null;
 const p=values.filter(x=>x>market.line).length/values.length,y=Number(market.actual>market.line);return {...scoreProbability(p,!!y),p,y,n:values.length};
}
