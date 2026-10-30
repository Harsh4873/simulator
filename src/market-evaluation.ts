import {noVigProbability} from './props.ts';
export interface MarketObservation {event_id:string;captured_at:string;tip:string;source:'ESPN scoreboard';book:string;home_moneyline:number|null;away_moneyline:number|null;home_spread:number|null;total:number|null;closing_confirmed:false}
const record=(x:unknown):Record<string,unknown>=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:{};
const number=(x:unknown):number|null=>x!==undefined&&x!==null&&x!==''&&Number.isFinite(Number(x))?Number(x):null;
/** Validation archive only: these fields never enter fitting, inputs hashes or simulation. */
export function marketObservations(payload:unknown,captured:string):MarketObservation[]{
 const events=record(payload).events;if(!Array.isArray(events))return [];
 return events.flatMap(value=>{
  const e=record(value),comps=e.competitions,c=record(Array.isArray(comps)?comps[0]:null),tip=String(e.date??c.date??'');
  if(!Number.isFinite(Date.parse(captured))||!(Date.parse(captured)<Date.parse(tip)))return [];
  const odds=c.odds;if(!Array.isArray(odds))return [];
  return odds.map(o=>{
    const q=record(o),money=record(q.moneyline),spread=record(q.pointSpread);
    return {event_id:String(e.id),captured_at:captured,tip,source:'ESPN scoreboard' as const,book:String(record(q.provider).name??'unknown'),home_moneyline:number(record(record(money.home).close).odds),away_moneyline:number(record(record(money.away).close).odds),home_spread:number(record(record(spread.home).close).line),total:number(q.overUnder),closing_confirmed:false as const};
  });
 });
}
export function pairedMarketProbability(quote:MarketObservation|null,eventId:string,tip:string):number|null{
 if(!quote||quote.event_id!==eventId||quote.tip!==tip||Date.parse(quote.captured_at)>=Date.parse(tip)||quote.home_moneyline===null||quote.away_moneyline===null)return null;
 return noVigProbability(quote.home_moneyline,quote.away_moneyline);
}
