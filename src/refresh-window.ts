import {chicagoDate} from './date.ts';
import type {Slate} from './types.ts';

export const PRE_TIP_WINDOW_MS=4*3600000;
/** Inside the pre-tip window the browser accepts a source check for 90 minutes; refreshing every 45 leaves room for one slow or failed run. */
export const PRE_TIP_INTERVAL_MS=45*60000;
/** One refresh lands about half an hour before each tip, when final injury designations and starters post. */
export const FINAL_CHECK_LEAD_MS=30*60000;
/** Outside the window: under the freshness monitor's four-hour deadline and the browser's six-hour expiry. */
export const OFF_WINDOW_INTERVAL_MS=3.5*3600000;
export const ROLLOVER_DELAY_MS=5*60000;
export const MIN_REFRESH_GAP_MS=10*60000;

function upcomingTips(slate:Slate,now:Date):number[]{
 return [...new Set(slate.games.filter(g=>g.status_state==='pre').map(g=>Date.parse(g.start_time)).filter(t=>Number.isFinite(t)&&t>=now.getTime()))].sort((a,b)=>a-b);
}

/** Operational policy: summary backfill and full checks within four hours of a tip; one rollover rebuild after Chicago midnight. */
export function shouldRefresh(slate:Slate,now:Date):boolean{
 if(slate.date!==chicagoDate(now)||!slate.generated_at)return true;
 return upcomingTips(slate,now).some(t=>t-now.getTime()<=PRE_TIP_WINDOW_MS);
}
export function freshnessBudget(slate:Slate,now:Date):number{
 return shouldRefresh(slate,now)&&slate.date===chicagoDate(now)?90*60000:6*3600000;
}

/** First instant (to the minute) that belongs to the next Chicago calendar date, across DST changes. */
export function nextChicagoMidnight(now:Date):number{
 const today=chicagoDate(now);
 let lo=now.getTime(),hi=lo+26*3600000;
 while(hi-lo>60000){const mid=lo+Math.floor((hi-lo)/2);if(chicagoDate(new Date(mid))===today)lo=mid;else hi=mid;}
 // Chicago offsets are whole hours, so the boundary is the minute that contains hi.
 return Math.floor(hi/60000)*60000;
}

/**
 * When the next refresh should start, from the slate that was just published.
 * GitHub's own cron drops or delays most slots, so a timer workflow dispatches this time instead.
 */
export function nextRefreshAt(slate:Slate,now:Date):Date{
 const t=now.getTime(),candidates=[t+OFF_WINDOW_INTERVAL_MS,nextChicagoMidnight(now)+ROLLOVER_DELAY_MS];
 for(const tip of upcomingTips(slate,now)){
  if(tip-PRE_TIP_WINDOW_MS>t)candidates.push(tip-PRE_TIP_WINDOW_MS);
  else if(t+PRE_TIP_INTERVAL_MS<tip)candidates.push(t+PRE_TIP_INTERVAL_MS);
  if(tip-FINAL_CHECK_LEAD_MS>t)candidates.push(tip-FINAL_CHECK_LEAD_MS);
 }
 return new Date(Math.max(t+MIN_REFRESH_GAP_MS,Math.min(...candidates)));
}
