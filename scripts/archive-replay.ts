// Rebuilds each archived pre-tip card from its stored lineage (roster, injury report, training event ids, cutoff)
// with the current source, simulates it, and scores the result against the settled box score and the last archived
// pre-tip market quote. A diagnostic of the current code on past inputs; not a calibration certificate.
import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {simulate} from '../src/simulate.ts';
import {fnv1a} from '../src/rng.ts';
import {attachPlayCache} from './play-cache.ts';
import {fitPlayers} from '../src/fit.ts';
import {fitMatchup,fitCurrentRoles,eligibleEvents,MODEL_VERSION} from '../src/team-model.ts';
import {addEvidence} from '../src/model-evidence.ts';
import {aggregateShooting} from '../src/event-cache.ts';
import {fitShootingPriors} from '../src/shooting-priors.ts';
import {availabilityHistory} from '../src/availability-history.ts';
import {fillThinRoster,rosterIssue} from '../src/roster-capacity.ts';
import {noVigProbability} from '../src/props.ts';
import {eventOutcomes} from './build-rate-card.ts';
import type {ForecastArchive} from '../src/forecast-archive.ts';
import type {MarketObservation} from '../src/market-evaluation.ts';
import type {CompletedEvent} from '../src/parse-summary.ts';
import type {ShootingCache} from '../src/types.ts';

const draws=Number(process.env.REPLAY_DRAWS??2000);
if(!Number.isInteger(draws)||draws<200)throw new Error('REPLAY_DRAWS must be an integer of at least 200');
const cache=JSON.parse(readFileSync('data/shooting-cache.json','utf8')) as ShootingCache;
attachPlayCache(cache,'data/shooting-cache.json');
const events=cache.events??[];
const byId=new Map(events.map(e=>[e.event_id,e]));
const read=(dir:string)=>existsSync(dir)?readdirSync(dir,{recursive:true}).map(String).filter(f=>f.endsWith('.json')&&!f.split('/').at(-1)!.startsWith('inputs-')).sort().map(f=>({file:f,data:JSON.parse(readFileSync(join(dir,f),'utf8'))})):[];
const archives=read('data/forecast-archive') as {file:string;data:ForecastArchive}[];
const quotes=read('data/market-archive').flatMap(x=>x.data as MarketObservation[]);
const latest=new Map<string,{file:string;archive:ForecastArchive;game:ForecastArchive['slate']['games'][number]}>();
for(const {file,data} of archives)for(const game of data.slate.games){
 if(!(Date.parse(data.card.generated_at!)<Date.parse(game.start_time))||!data.source_lineage?.roster||!data.source_lineage?.injuries||!byId.has(game.event_id))continue;
 const previous=latest.get(game.event_id);
 if(!previous||Date.parse(data.card.generated_at!)>Date.parse(previous.archive.card.generated_at!))latest.set(game.event_id,{file,archive:data,game});
}
const groups=new Map<string,{archive:ForecastArchive;games:ForecastArchive['slate']['games']}>();
for(const {file,archive,game} of latest.values()){const g=groups.get(file)??{archive,games:[]};g.games.push(game);groups.set(file,g);}
const mean=(xs:ArrayLike<number>)=>{let s=0;for(let i=0;i<xs.length;i++)s+=xs[i];return xs.length?s/xs.length:NaN;};
const games:{margin:number;total:number;predMargin:number;predTotal:number;p:number;marketMargin:number|null;marketTotal:number|null;marketP:number|null}[]=[];
const players:{p:number;played:number;predMin:number;actMin:number;predPts:number;actPts:number}[]=[];
for(const [,{archive,games:slateGames}] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
 const cutoff=archive.card.generated_at!,lineage=archive.source_lineage!;
 const ids=new Set(lineage.training_event_ids);
 const training=eligibleEvents(events.filter(e=>ids.has(e.event_id)),cutoff);
 const season=slateGames[0].season;
 const prior=archives.map(x=>x.data).filter(x=>Date.parse(x.card.generated_at!)<Date.parse(cutoff));
 const fitted=fitPlayers({roster:lineage.roster!,injuries:lineage.injuries!,outcomes:eventOutcomes(training),shooting:aggregateShooting(training),skillModel:fitShootingPriors(training,season),activeSeason:season});
 fitCurrentRoles(fitted.players,training,season,availabilityHistory(prior,training,cutoff),cutoff);
 addEvidence(fitted.players,training,cutoff);
 for(const game of slateGames){
  const actual=byId.get(game.event_id) as CompletedEvent;
  const rate=fillThinRoster({event_id:game.event_id,away_team_id:game.away.team_id,home_team_id:game.home.team_id,players:fitted.players.filter(p=>p.team_id===game.away.team_id||p.team_id===game.home.team_id),context:fitMatchup(training,game,cutoff)});
  if(rosterIssue(rate))continue;
  const sim=simulate(rate,fnv1a(`${game.event_id}:${cutoff}`),draws);
  const quote=quotes.filter(q=>q.event_id===game.event_id&&Date.parse(q.captured_at)<Date.parse(game.start_time)&&q.home_spread!==null&&q.total!==null).sort((a,b)=>Date.parse(b.captured_at)-Date.parse(a.captured_at))[0]??null;
  games.push({margin:actual.home_pts-actual.away_pts,total:actual.home_pts+actual.away_pts,predMargin:mean(sim.homeTotals)-mean(sim.awayTotals),predTotal:mean(sim.combinedTotals),p:sim.wins.home/draws,
   marketMargin:quote?-quote.home_spread!:null,marketTotal:quote?quote.total:null,marketP:quote&&quote.home_moneyline!==null&&quote.away_moneyline!==null?noVigProbability(quote.home_moneyline,quote.away_moneyline):null});
  for(const p of rate.players){
   if(p.replacement_level||p.minutes_weight===0)continue;
   const d=sim.playerDraws.get(p.athlete_id);if(!d)continue;
   const box=actual.players.find(x=>x.athlete_id===p.athlete_id);
   const min=Array.from(d.min);
   players.push({p:min.filter(m=>m>0).length/draws,played:Number(!!box&&box.minutes>0),predMin:mean(min),actMin:box?.minutes??0,predPts:mean(Array.from(d.pts)),actPts:box?.pts??0});
  }
 }
}
const avg=<T>(xs:T[],f:(x:T)=>number)=>xs.length?mean(xs.map(f)):null;
const priced=games.filter(g=>g.marketMargin!==null&&g.marketTotal!==null);
const moneyline=games.filter(g=>g.marketP!==null);
const ll=(p:number,y:number)=>{const q=Math.min(1-1e-6,Math.max(1e-6,p));return -(y*Math.log(q)+(1-y)*Math.log(1-q));};
const report={model_version:MODEL_VERSION,draws,games:games.length,player_rows:players.length,
 margin:{mae:avg(games,g=>Math.abs(g.predMargin-g.margin)),bias:avg(games,g=>g.predMargin-g.margin),market_mae:avg(priced,g=>Math.abs(g.marketMargin!-g.margin))},
 total:{mae:avg(games,g=>Math.abs(g.predTotal-g.total)),bias:avg(games,g=>g.predTotal-g.total),market_mae:avg(priced,g=>Math.abs(g.marketTotal!-g.total)),minus_market:avg(priced,g=>g.predTotal-g.marketTotal!)},
 win:{brier:avg(games,g=>(g.p-Number(g.margin>0))**2),market_brier:avg(moneyline,g=>(g.marketP!-Number(g.margin>0))**2)},
 participation:{log_loss:avg(players,r=>ll(r.p,r.played)),brier:avg(players,r=>(r.p-r.played)**2)},
 minutes:{mae:avg(players,r=>Math.abs(r.predMin-r.actMin)),bias:avg(players,r=>r.predMin-r.actMin)},
 points:{mae:avg(players,r=>Math.abs(r.predPts-r.actPts)),bias:avg(players,r=>r.predPts-r.actPts)},
 limitations:['Only games with an archived pre-tip card, its lineage and a settled box are replayed.','Market quotes are pre-tip ESPN observations, not confirmed closing lines.','A few dozen games cannot certify calibration.']};
if(process.env.REPLAY_OUT)writeFileSync(process.env.REPLAY_OUT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
