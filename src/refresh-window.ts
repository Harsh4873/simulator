import {chicagoDate} from './date.ts';
import type {Slate} from './types.ts';
/** Operational policy: hourly runs within four hours of a tip; one daily rollover rebuild. */
export function shouldRefresh(slate:Slate,now:Date):boolean{
 if(slate.date!==chicagoDate(now)||!slate.generated_at)return true;
 return slate.games.some(g=>g.status_state==='pre'&&Date.parse(g.start_time)>=now.getTime()&&Date.parse(g.start_time)-now.getTime()<=4*3600000);
}
export function freshnessBudget(slate:Slate,now:Date):number{
 return shouldRefresh(slate,now)&&slate.date===chicagoDate(now)?90*60000:6*3600000;
}
