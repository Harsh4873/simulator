import {join} from 'node:path';
import {archivedForecast,type ForecastArchive} from '../src/forecast-archive.ts';
import {pairedMarketProbability,type MarketObservation} from '../src/market-evaluation.ts';
import {selectRolePrior} from '../src/role-model.ts';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fitPlayers } from '../src/fit.ts';
import { fitMatchup, fitCurrentRoles, eligibleEvents, MODEL_VERSION } from '../src/team-model.ts';
import { eventOutcomes } from './build-rate-card.ts';
import { simulate } from '../src/simulate.ts';
import { fnv1a, mulberry32 } from '../src/rng.ts';
import { mean, scoreDistribution, scoreProbability, reliability } from '../src/evaluation.ts';
import type { ShootingCache, ShootingRow, SlateGame } from '../src/types.ts';
import type { CompletedEvent } from '../src/parse-summary.ts';

const cache:ShootingCache=JSON.parse(readFileSync('data/shooting-cache.json','utf8'));
const events=(cache.events??[]).filter(e=>e.season_type===2).sort((a,b)=>Date.parse(a.start_time)-Date.parse(b.start_time));
const max=Number(process.env.BACKTEST_GAMES??60),iterations=Number(process.env.BACKTEST_ITERATIONS??1000);
if(!Number.isInteger(max)||max<1||!Number.isInteger(iterations)||iterations<100)throw new Error('Invalid backtest size');
function shooting(history:CompletedEvent[]):ShootingRow[]{return history.flatMap(e=>e.players.map(p=>({...p,season:e.season,games:1})));}
const activeSeason=Math.max(...events.map(e=>e.season));
const targets=events.filter(e=>e.season===activeSeason).slice(-max);
const readArchives=(dir:string):unknown[]=>existsSync(dir)?readdirSync(dir,{recursive:true}).map(String).filter(f=>f.endsWith('.json')&&!f.split('/').at(-1)!.startsWith('inputs-')).map(f=>JSON.parse(readFileSync(join(dir,f),'utf8'))):[];
const archives=readArchives('data/forecast-archive') as ForecastArchive[];
const markets=readArchives('data/market-archive').flat() as MarketObservation[];
type DistributionScore=ReturnType<typeof scoreDistribution>;
type PlayerScore=DistributionScore & {athlete_id:string;team_id:string;stat:string};
type Result={event_id:string;cutoff:string;training_games:number;p:number;y:number;brier:number;logLoss:number;margin:DistributionScore;total:DistributionScore;baseline:{margin:DistributionScore;total:DistributionScore;brier:number;logLoss:number};playerStats:PlayerScore[];unmatched_players:number;archived:boolean;market:{brier:number;logLoss:number;closing_confirmed:false}|null;participation:{p:number;y:number;brier:number;logLoss:number}[];strata:{month:string;historical_availability:string;rest_home:number|null;rest_away:number|null}};
const results:Result[]=[];
const skipped=[];
for(const actual of targets){
  const history=eligibleEvents(events,actual.start_time);
  if(history.length<50){skipped.push({event:actual.event_id,reason:'fewer than 50 training games'});continue;}
  // Historical roster/injury snapshots do not exist. Infer candidates from prior boxes ONLY.
  // This reconstruction is a diagnostic, never an archived pregame forecast or release validation.
  const rosters=[actual.away_team_id,actual.home_team_id].flatMap(team=>{
    const recent=history.filter(e=>[e.home_team_id,e.away_team_id].includes(team)).slice(-5);
    const ids=new Set(recent.flatMap(e=>e.players.filter(p=>p.team_id===team).map(p=>p.athlete_id)));
    return [...ids].map(athlete_id=>({athlete_id,team_id:team,name:athlete_id,position:''}));
  });
  if(new Set(rosters.map(p=>p.athlete_id)).size!==rosters.length){skipped.push({event:actual.event_id,reason:'ambiguous historical membership'});continue;}
  const fitted=fitPlayers({roster:rosters,injuries:[],outcomes:eventOutcomes(history),shooting:shooting(history),activeSeason:actual.season});
  fitCurrentRoles(fitted.players,history,actual.season,[],actual.start_time);
  const game:SlateGame={event_id:actual.event_id,date:actual.start_time.slice(0,10),start_time:actual.start_time,season:actual.season,season_type:'regular',status_state:'pre',completed:false,spread_caption:null,neutral_site:actual.neutral,away:{team_id:actual.away_team_id,name:'away',abbreviation:''},home:{team_id:actual.home_team_id,name:'home',abbreviation:''}};
  try {
    const context=fitMatchup(history,game,actual.start_time);
    const archive=archivedForecast(archives,actual.event_id,actual.start_time,MODEL_VERSION);
    const rate=archive?.card.games.find(g=>g.event_id===actual.event_id)??{event_id:actual.event_id,away_team_id:actual.away_team_id,home_team_id:actual.home_team_id,players:fitted.players,context};
    const sim=simulate(rate,fnv1a(archive?`${actual.event_id}:${archive.card.generated_at}`:`${actual.event_id}:${MODEL_VERSION}:walk-forward`),iterations);
    const quote=markets.filter(q=>q.event_id===actual.event_id&&Date.parse(q.captured_at)<Date.parse(actual.start_time)).sort((a,b)=>Date.parse(b.captured_at)-Date.parse(a.captured_at))[0]??null;
    const marketP=pairedMarketProbability(quote,actual.event_id,actual.start_time);
    const participation=(actual.participation??[]).flatMap(a=>{const draws=sim.playerDraws.get(a.athlete_id);if(!draws)return [];const p=Array.from(draws.min).filter(m=>m>0).length/iterations;return [{p,y:Number(a.played),...scoreProbability(p,a.played)}];});
    const margin=actual.home_pts-actual.away_pts,total=actual.home_pts+actual.away_pts;
    const p=sim.wins.home/iterations;
    const baselineMargins=history.map(e=>e.home_pts-e.away_pts),baselineTotals=history.map(e=>e.home_pts+e.away_pts);
    const playerStats=actual.players.flatMap(a=>{
      const draws=sim.playerDraws.get(a.athlete_id);if(!draws)return [];
      return (['min','pts','reb','ast','stl','blk','tov'] as const).flatMap(stat=>{
        const truth=stat==='min'?a.minutes:a[stat];const series=draws[stat];
        return truth===undefined||!series?[]:[{athlete_id:a.athlete_id,team_id:a.team_id,stat,...scoreDistribution(Array.from(series),truth)}];
      });
    });
    results.push({archived:!!archive,market:marketP===null?null:{...scoreProbability(marketP,margin>0),closing_confirmed:false},participation,strata:{month:actual.start_time.slice(0,7),historical_availability:archive?'archived':'unknown',rest_home:context.home.rest_days,rest_away:context.away.rest_days},event_id:actual.event_id,cutoff:actual.start_time,training_games:history.length,p,y:Number(margin>0),...scoreProbability(p,margin>0),margin:scoreDistribution(sim.homeTotals.map((x,i)=>x-sim.awayTotals[i]),margin),total:scoreDistribution(sim.combinedTotals,total),baseline:{margin:scoreDistribution(baselineMargins,margin),total:scoreDistribution(baselineTotals,total),...scoreProbability(history.filter(e=>e.home_pts>e.away_pts).length/history.length,margin>0)},playerStats,unmatched_players:actual.players.filter(p=>!sim.playerDraws.has(p.athlete_id)).length});
  }catch(e){skipped.push({event:actual.event_id,reason:e instanceof Error?e.message:'simulation failed'});}
}
const aggregate=(xs:ReturnType<typeof scoreDistribution>[])=>Object.fromEntries((['error','mae','crps','coverage80','coverage90'] as const).map(k=>[k,xs.length?mean(xs.map(x=>x[k])):null]));
const stats=['min','pts','reb','ast','stl','blk','tov'];
const rng=mulberry32(731);
function pairedInterval(metric:(r:Result)=>number){
  if(!results.length)return null;
  const differences=Array.from({length:1000},()=>mean(Array.from({length:results.length},()=>metric(results[Math.floor(rng()*results.length)])))).sort((a,b)=>a-b);
  return {difference:mean(results.map(metric)),lower95:differences[24],upper95:differences[974]};
}
const report={model_version:MODEL_VERSION,mode:'chronological reconstruction; historical availability unknown',iterations,games:results.length,skipped,closing_market_coverage:0,observed_market_coverage:results.filter(r=>r.market).length,archived_forecasts:results.filter(r=>r.archived).length,release_eligible:false,role_prior_selection:selectRolePrior(events,activeSeason),participation:reliability(results.flatMap(r=>r.participation)),
  limitations:['No archived historical injury/roster snapshots; candidates inferred from preceding five team boxes.','No historical closing quotes; no market-relative accuracy claim.','Role prior selected on preceding-season appearances; no settled prop-market archive and no release gate passed.','Player metrics cover actual participants present in inferred rosters; unmatched players reported separately.'],
  release_gates:{minimum_games:500,minimum_settled_player_markets:2000,margin_bias_max:1,total_bias_max:2,coverage_tolerance:.03,ece_max:.03,requires_clustered_baseline_and_market_comparisons:true},
  paired_game_bootstrap:{brier:pairedInterval(r=>r.brier-r.baseline.brier),margin_crps:pairedInterval(r=>r.margin.crps-r.baseline.margin.crps),total_crps:pairedInterval(r=>r.total.crps-r.baseline.total.crps)},
  summary:{brier:results.length?mean(results.map(r=>r.brier)):null,logLoss:results.length?mean(results.map(r=>r.logLoss)):null,reliability:reliability(results),margin:aggregate(results.map(r=>r.margin)),total:aggregate(results.map(r=>r.total)),baseline:{brier:results.length?mean(results.map(r=>r.baseline.brier)):null,margin:aggregate(results.map(r=>r.baseline.margin)),total:aggregate(results.map(r=>r.baseline.total))},players:Object.fromEntries(stats.map(stat=>[stat,aggregate(results.flatMap(r=>r.playerStats.filter(s=>s.stat===stat)))]))},results};
writeFileSync('data/backtest-report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,results:undefined},null,2));
