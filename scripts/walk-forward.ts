// Walk-forward test of the team model behind every simulation: for each Chicago date, refit on games before that
// date's first tip and predict its games from pace and efficiency, then score against final results. No simulation
// runs, so hundreds of games take about a minute. Overtime is not included, so totals read about 0.6 low.
// HALF_LIFE=none|<days> tries another recency setting.
import {readFileSync} from 'node:fs';
import {fitTeamEffects} from '../src/team-effects.ts';
import {eligibleEvents,eventPossessions,PACE_PRIOR_GAMES,PRIOR_SEASON_WEIGHT} from '../src/team-model.ts';
import {restDays} from '../src/schedule-context.ts';
import {chicagoDate} from '../src/date.ts';
import {attachPlayCache} from './play-cache.ts';
import type {ShootingCache} from '../src/types.ts';
import type {CompletedEvent} from '../src/parse-summary.ts';

const from=process.env.FROM??'2026-01-01',to=process.env.TO??chicagoDate(new Date());
const halfLife=process.env.HALF_LIFE===undefined?undefined:process.env.HALF_LIFE==='none'?null:Number(process.env.HALF_LIFE);
if(halfLife!==undefined&&halfLife!==null&&!(halfLife>0))throw new Error('HALF_LIFE must be none or a positive number of days');
const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
attachPlayCache(cache,'data/shooting-cache.json');
const all=(cache.events??[]).filter(e=>e.season_type===2&&e.players.every(p=>p.tov!==undefined&&p.orb!==undefined)).sort((a,b)=>a.start_time.localeCompare(b.start_time));
const byDate=new Map<string,CompletedEvent[]>();
for(const e of all){const d=chicagoDate(new Date(e.start_time));if(d<from||d>to)continue;byDate.set(d,[...(byDate.get(d)??[]),e]);}
const sum=(xs:number[])=>xs.reduce((a,b)=>a+b,0),mean=(xs:number[])=>sum(xs)/xs.length;
const rows:{season:number;margin:number;total:number;predMargin:number;predTotal:number}[]=[];
for(const [,games] of [...byDate].sort(([a],[b])=>a.localeCompare(b))){
 const cutoff=games.map(g=>g.start_time).sort()[0];
 const history=eligibleEvents(all,cutoff);
 if(history.length<300)continue;
 const season=games[0].season;
 const effects=fitTeamEffects(history,eventPossessions,halfLife===undefined?{}:{halfLives:[halfLife]});
 const samples=history.flatMap(e=>[e.away_team_id,e.home_team_id].map(team=>({team,pace:(eventPossessions(e,e.home_team_id)+eventPossessions(e,e.away_team_id))/2*48/(48+5*(e.periods-4)),weight:e.season===season?1:PRIOR_SEASON_WEIGHT})));
 const league=sum(samples.map(x=>x.pace*x.weight))/sum(samples.map(x=>x.weight));
 const pace=(team:string)=>{const xs=samples.filter(x=>x.team===team);return (sum(xs.map(x=>x.pace*x.weight))+PACE_PRIOR_GAMES*league)/(sum(xs.map(x=>x.weight))+PACE_PRIOR_GAMES);};
 const last=(team:string)=>history.filter(e=>e.season===season&&(e.home_team_id===team||e.away_team_id===team)).at(-1)?.start_time??null;
 const level=effects.level??1.12;
 for(const g of games){
  const hr=restDays(last(g.home_team_id),g.start_time),ar=restDays(last(g.away_team_id),g.start_time);
  const venue=(g.neutral?0:effects.home)+(hr!==null&&ar!==null?effects.rest*(Math.log1p(hr)-Math.log1p(ar)):0);
  const p=(pace(g.home_team_id)+pace(g.away_team_id))/2;
  const home=p*(effects.offense[g.home_team_id]??level)*(effects.defense[g.away_team_id]??level)/level*Math.exp(venue);
  const away=p*(effects.offense[g.away_team_id]??level)*(effects.defense[g.home_team_id]??level)/level*Math.exp(-venue);
  rows.push({season:g.season,margin:g.home_pts-g.away_pts,total:g.home_pts+g.away_pts,predMargin:home-away,predTotal:home+away});
 }
}
const score=(xs:typeof rows)=>xs.length?{games:xs.length,margin_mae:+mean(xs.map(r=>Math.abs(r.predMargin-r.margin))).toFixed(3),margin_bias:+mean(xs.map(r=>r.predMargin-r.margin)).toFixed(3),total_mae:+mean(xs.map(r=>Math.abs(r.predTotal-r.total))).toFixed(3),total_bias:+mean(xs.map(r=>r.predTotal-r.total)).toFixed(3),favorite_won:+mean(xs.map(r=>Number((r.predMargin>0)===(r.margin>0)))).toFixed(3),margin_residual_sd:+Math.sqrt(mean(xs.map(r=>(r.margin-r.predMargin)**2))).toFixed(2)}:null;
console.log(JSON.stringify({from,to,half_life_days:halfLife===undefined?'default':halfLife,all:score(rows),by_season:Object.fromEntries([...new Set(rows.map(r=>r.season))].map(s=>[s,score(rows.filter(r=>r.season===s))]))},null,2));
