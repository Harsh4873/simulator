import {rotationStateKey} from './game-state-model.ts';
import {lateFoulState} from './free-throw-model.ts';
import {usageWeights} from './usage-effects.ts';
import {lineupLogEffect} from './lineup-effects.ts';
import { minuteLineups } from './lineups.ts';
import type { DrawnPlayer } from './simulate.ts';
import type { MatchupContext, RatePlayer, TeamProfile } from './types.ts';
import type { Rng } from './rng.ts';

function pick(weights: number[], rng: Rng): number {
  const total = weights.reduce((a,b)=>a+b,0);
  if (!(total>0)) return -1;
  let target = rng()*total;
  for (let i=0;i<weights.length;i++) {target-=weights[i];if(target<0)return i;}
  return weights.length-1;
}
const sum = (xs: number[]) => xs.reduce((a,b)=>a+b,0);
const bound = (v:number) => Math.max(0,Math.min(1,v));

/** Aggregate possession model: shared pace, competitive rebounds, one assister per make.
 * Synthetic five-player stints realize minute targets and observed opening/closing roles.
 */
export function drawPossessions(
  away: DrawnPlayer[], home: DrawnPlayer[], roster: RatePlayer[], awayMinutes: number[], homeMinutes: number[],
  context: MatchupContext, possessions: number, rng: Rng,
): void {
  const periodLength=awayMinutes.reduce((a,b)=>a+b,0)/5;
  const rates = new Map(roster.map(p=>[p.athlete_id,p]));
  const roles=(players:DrawnPlayer[])=>({opening:players.map(p=>rates.get(p.athlete_id)?.starter_rate??0),closing:players.map(p=>rates.get(p.athlete_id)?.closing_rate??0)});
  const awayLineups=minuteLineups(awayMinutes,periodLength,rng,roles(away)),homeLineups=minuteLineups(homeMinutes,periodLength,rng,roles(home));
  const dynamic=context.rotation_state?.status==='fitted'||context.fouls?.status==='fitted';
  const actual=[away.map(()=>0),home.map(()=>0)];
  const emergency=[new Set<number>(),new Set<number>()];
  const before=[away.map((p,i)=>p.min-awayMinutes[i]),home.map((p,i)=>p.min-homeMinutes[i])];
  const caps=[away,home].map((team,t)=>team.map((p,i)=>{
    const rate=rates.get(p.athlete_id)!;
    const thin=rate.shooting_games===0&&(rate.games<3||(rate.games_2027===0&&rate.games_2026<20));
    return Math.max(0,Math.floor(Math.min(periodLength,(rate.minutes_restriction??(thin?12:Infinity))-before[t][i])));
  }));
  const adjust=(team:DrawnPlayer[],stints:number[][],mins:number[],minute:number,t:number)=>{
    const eligible=team.map((_,i)=>i).filter(i=>(before[t][i]+mins[i]>0||emergency[t].has(i))&&(team[i].fouls??0)<6&&actual[t][i]<caps[t][i]);
    // A healthy coach-DNP can enter if a foul-out exhausts the sampled rotation.
    // A missed uncertain/injured availability draw never becomes an emergency substitute.
    if(eligible.length<5){
      const reserves=team.map((_,i)=>i).filter(i=>!eligible.includes(i)&&before[t][i]+mins[i]===0&&team[i].minutes_weight===1&&team[i].injury_status==='healthy'&&(rates.get(team[i].athlete_id)?.play_probability??1)>0&&(team[i].fouls??0)<6&&caps[t][i]-actual[t][i]>=periodLength-minute).sort((a,b)=>rates.get(team[b].athlete_id)!.minutes_mean-rates.get(team[a].athlete_id)!.minutes_mean);
      while(eligible.length<5&&reserves.length){const i=reserves.shift()!;emergency[t].add(i);eligible.push(i);}
    }
    let chosen=stints[minute].filter(i=>eligible.includes(i));
    const candidates=eligible.filter(i=>!chosen.includes(i)).sort((a,b)=>(mins[b]-actual[t][b])-(mins[a]-actual[t][a]));
    while(chosen.length<5&&candidates.length)chosen.push(candidates.shift()!);
    if(chosen.length!==5)throw new Error('Foul-outs or minute restrictions leave fewer than five eligible players');
    const model=context.rotation_state;
    if(periodLength===48&&model?.status==='fitted'){
      const margin=sum(away.map(p=>p.pts))-sum(home.map(p=>p.pts)),key=rotationStateKey(minute,margin),base=model.baseline[key.split(':')[0]],share=model.shares[key]??base;
      const starter=(i:number)=>(rates.get(team[i].athlete_id)?.starter_rate??0)>=.5;
      // Replace only the excess role probability relative to the observed time-only baseline.
      const increase=share>base,probability=increase?(share-base)/(1-base):(base-share)/base;
      for(let slot=0;slot<chosen.length;slot++)if(starter(chosen[slot])!==increase&&rng()<probability){
        const replacement=eligible.filter(i=>!chosen.includes(i)&&starter(i)===increase).sort((a,b)=>(mins[b]-actual[t][b])-(mins[a]-actual[t][a]))[0];
        if(replacement!==undefined)chosen[slot]=replacement;
      }
    }
    stints[minute]=chosen;for(const i of chosen)actual[t][i]++;
  };
  const foulMinute=(team:DrawnPlayer[],stints:number[][],minute:number)=>{
    const model=context.fouls;if(model?.status!=='fitted')return;
    for(const i of stints[minute]){const p=team[i],previousFouls=p.fouls??0,weights=model.conditional?model.by_count[previousFouls]??model.probabilities:model.probabilities;
      p.fouls=Math.min(6,previousFouls+Math.max(0,pick(weights,rng)));if(p.fouls===6&&previousFouls<6)p.foul_out_minute=before[0].reduce((a,b)=>a+b,0)/5+minute+1;
    }
  };
  const attack = (off: DrawnPlayer[], def: DrawnPlayer[], mins: number[], defMins: number[], profile: TeamProfile, opponent: TeamProfile, venue: number, offStints:number[][], defStints:number[][]) => {
    const p = off.map(x=>rates.get(x.athlete_id)!);
    const q = def.map(x=>rates.get(x.athlete_id)!);
    let shots = p.map((x,i)=>mins[i]*x.fga_per_min);
    let fts = p.map((x,i)=>mins[i]*x.fta_per_min);
    let creators = p.map((x,i)=>mins[i]*x.ast_per_min);
    let offensiveBoards = p.map((x,i)=>mins[i]*x.reb_per_min);
    let defensiveBoards = q.map((x,i)=>defMins[i]*x.reb_per_min);
    let steals = q.map((x,i)=>defMins[i]*(x.stl_per_min ?? 0));
    let blocks = q.map((x,i)=>defMins[i]*(x.blk_per_min ?? 0));
    let turnovers = p.map((x,i)=>mins[i]*(x.tov_per_min ?? 0));
    const fga=sum(shots), fta=sum(fts);
    const ftModel=context.free_throws?.status==='fitted'?context.free_throws:null;
    const tripMean=ftModel?2*ftModel.trip_weights[0]+3*ftModel.trip_weights[1]:2;
    const andOne=ftModel?.and_one_per_make??0,technical=ftModel?.technical_per_possession??0;
    const retained=ftModel?.retained_per_possession??0,retainedWeights=ftModel?.retained_trip_weights??[0,0,0];
    const retainedAttempts=retainedWeights.reduce((s,w,i)=>s+w*(i+1),0)*retained;
    const expectedMakes=sum(p.map((x,i)=>shots[i]*((1-x.tpa_given_fga)*x.fg2_pct+x.tpa_given_fga*x.tp_pct)));
    const ordinaryAttempts=Math.max(0,fta-expectedMakes*andOne-possessions*(technical+retainedAttempts));
    const ftShare = ordinaryAttempts/tripMean/Math.max(1,fga+ordinaryAttempts/tripMean);
    const fgValue = sum(p.map((x,i)=>shots[i]*(2*(1-x.tpa_given_fga)*x.fg2_pct+3*x.tpa_given_fga*x.tp_pct)))/Math.max(1,fga);
    const fgPct = sum(p.map((x,i)=>shots[i]*((1-x.tpa_given_fga)*x.fg2_pct+x.tpa_given_fga*x.tp_pct)))/Math.max(1,fga);
    const ftPct = sum(p.map((x,i)=>fts[i]*x.ft_pct))/Math.max(1,fta);
    const orb = bound(profile.offensive_rebound_rate);
    const tov = bound(profile.turnover_rate);
    const raw = ((1-tov)*((1-ftShare)*(fgValue+fgPct*andOne*ftPct)+ftShare*tripMean*ftPct)+(technical+retainedAttempts)*ftPct)/Math.max(0.1,1-(1-tov)*((1-ftShare)*(1-fgPct+fgPct*andOne*(1-ftPct))+ftShare*(1-ftPct))*orb);
    // Equal-strength shrinkage between the available lineup's scoring profile and observed team efficiency.
    // This prior weight requires walk-forward calibration; no market values enter this expression.
    const target = Math.sqrt(Math.max(0.01,raw)*profile.offense)*opponent.defense/context.league_efficiency*Math.exp(venue);
    // Solve expected points per possession for a make-rate multiplier, including second chances.
    const expected = (scale:number) => {
      const fg = sum(p.map((x,i)=>shots[i]*((1-x.tpa_given_fga)*bound(x.fg2_pct*scale)+x.tpa_given_fga*bound(x.tp_pct*scale))))/Math.max(1,fga);
      const pts = sum(p.map((x,i)=>shots[i]*(2*(1-x.tpa_given_fga)*bound(x.fg2_pct*scale)+3*x.tpa_given_fga*bound(x.tp_pct*scale))))/Math.max(1,fga);
      return ((1-tov)*((1-ftShare)*(pts+fg*andOne*ftPct)+ftShare*tripMean*ftPct)+(technical+retainedAttempts)*ftPct)/(1-(1-tov)*((1-ftShare)*(1-fg+fg*andOne*(1-ftPct))+ftShare*(1-ftPct))*orb);
    };
    let lo=0,hi=3;
    for(let j=0;j<20;j++){const mid=(lo+hi)/2;if(expected(mid)<target)lo=mid;else hi=mid;}
    const efficiency=(lo+hi)/2;
    const stealChance=bound(sum(steals)/Math.max(1,possessions*tov));
    const blockChance=bound(sum(blocks)/Math.max(1,possessions*(1-tov)*(1-fgPct)));
    let lastMinute=-1,lineupEffect=0;
    return (n:number) => {
      const minute=Math.min(periodLength-1,Math.floor(n*periodLength/possessions));
      if(minute!==lastMinute){
      lastMinute=minute;
      const on=new Set(offStints[minute]),against=new Set(defStints[minute]);
      const active=[...on],activeWeights=usageWeights(context.usage_effects,off[0].team_id,active.map(i=>off[i].athlete_id),active.map(i=>p[i].fga_per_min));
      shots=p.map(()=>0);active.forEach((i,j)=>shots[i]=activeWeights[j]);fts=p.map((x,i)=>on.has(i)?x.fta_per_min:0);
      creators=p.map((x,i)=>on.has(i)?x.ast_per_min:0);offensiveBoards=p.map((x,i)=>on.has(i)?x.reb_per_min:0);
      turnovers=p.map((x,i)=>on.has(i)?x.tov_per_min??0:0);
      defensiveBoards=q.map((x,i)=>against.has(i)?x.reb_per_min:0);steals=q.map((x,i)=>against.has(i)?x.stl_per_min??0:0);blocks=q.map((x,i)=>against.has(i)?x.blk_per_min??0:0);
      lineupEffect=context.lineup_effects?.status==='fitted'?lineupLogEffect(context.lineup_effects,off[0].team_id,[...on].map(i=>off[i].athlete_id),'offense')+lineupLogEffect(context.lineup_effects,def[0].team_id,[...against].map(i=>def[i].athlete_id),'defense'):0;
      }
      if(technical>0&&rng()<technical){const who=pick(fts,rng);if(who>=0){off[who].fta++;off[who].ft_technical=(off[who].ft_technical??0)+1;if(rng()<p[who].ft_pct){off[who].ftm++;off[who].pts++;}}}
      if(retained>0&&rng()<retained){const who=pick(fts,rng),size=pick(retainedWeights,rng)+1;if(who>=0&&size>0){off[who].fta+=size;off[who].ft_retained=(off[who].ft_retained??0)+size;for(let i=0;i<size;i++)if(rng()<p[who].ft_pct){off[who].ftm++;off[who].pts++;}}}

      let live=true;
      let guard=0;
      while(live) {
        if(++guard>1000)throw new Error('Possession did not end');
        live=false;
        if(rng()<tov) {
          const who=pick(sum(turnovers)>0?turnovers:shots,rng);
          if(who>=0)off[who].tov=(off[who].tov??0)+1;
          if(rng()<stealChance){const who=pick(steals,rng);if(who>=0)def[who].stl=(def[who].stl??0)+1;}
          continue;
        }
        const late=ftModel?.late;
        const margin=late?.status==='fitted'&&minute>=periodLength-2?sum(off.map(x=>x.pts))-sum(def.map(x=>x.pts)):0;
        const inLate=late?.status==='fitted'&&lateFoulState(periodLength===48?Math.floor(minute/12)+1:5,(periodLength-minute)*60,margin);
        const odds=inLate?(late.share/(1-late.share))/(late.baseline_share/(1-late.baseline_share)):1;
        const free=rng()<(ftShare*odds/(1-ftShare+ftShare*odds));
        const shooter=pick(free?fts:shots,rng);
        if(shooter<0)throw new Error('No active shooting exposure');
        const line=off[shooter],rate=p[shooter];
        let miss=false;
        if(free) {
          const trip=ftModel?.trip_types?.length?ftModel.trip_types[pick(ftModel.trip_types.map(t=>t.weight),rng)]:null;
          const attempts=trip?.attempts??(ftModel&&rng()<ftModel.trip_weights[1]?3:2);
          if(trip?.kind==='bonus')line.ft_bonus=(line.ft_bonus??0)+attempts;
          line.ft_possession_trips=(line.ft_possession_trips??0)+1;
          line.fta+=attempts;
          for(let attempt=0;attempt<attempts;attempt++) {
            const made=rng()<rate.ft_pct;
            if(made){line.ftm++;line.pts++;}
            if(attempt===attempts-1)miss=!made;
          }
        } else {
          const three=rng()<rate.tpa_given_fga;
          line.fga++;if(three)line.tpa++;
          const made=rng()<bound((three?rate.tp_pct:rate.fg2_pct)*efficiency*Math.exp(lineupEffect));
          if(made) {
            line.fgm++;if(three)line.tpm++;line.pts+=three?3:2;
            if(andOne>0&&rng()<andOne){line.fta++;line.ft_and_one=(line.ft_and_one??0)+1;if(rng()<rate.ft_pct){line.ftm++;line.pts++;}else miss=true;}
            if(rng()<bound(profile.assist_rate)) {
              const helper=pick(creators.map((v,i)=>i===shooter?0:v),rng);
              if(helper>=0)off[helper].ast++;
            }
          } else {
            miss=true;
            if(rng()<blockChance){const who=pick(blocks,rng);if(who>=0)def[who].blk=(def[who].blk??0)+1;}
          }
        }
        if(miss) {
          if(rng()<orb) {
            const who=pick(offensiveBoards,rng);
            if(who>=0){off[who].reb++;off[who].orb=(off[who].orb??0)+1;live=true;}
          } else {
            const who=pick(defensiveBoards,rng);
            if(who>=0){def[who].reb++;def[who].drb=(def[who].drb??0)+1;}
          }
        }
      }
    }
  };
  const rest=context.away.rest_days!==null&&context.home.rest_days!==null?(context.rest_coefficient??0)*(Math.log1p(context.home.rest_days)-Math.log1p(context.away.rest_days)):0;
  const delta=(key:'previous_minutes'|'travel_km'|'timezone_change_hours')=>{const a=context.away.schedule?.[key],h=context.home.schedule?.[key];return a!=null&&h!=null?h-a:0;};
  const venue=(context.neutral?0:context.home_log_advantage)+rest+(context.workload_coefficient??0)*delta('previous_minutes')/5+(context.travel_coefficient??0)*delta('travel_km')/1000+(context.timezone_coefficient??0)*delta('timezone_change_hours');
  const a=attack(away,home,awayMinutes,homeMinutes,context.away,context.home,-venue,awayLineups,homeLineups);
  const h=attack(home,away,homeMinutes,awayMinutes,context.home,context.away,venue,homeLineups,awayLineups);
  for(let minute=0;minute<periodLength;minute++){
    if(dynamic){adjust(away,awayLineups,awayMinutes,minute,0);adjust(home,homeLineups,homeMinutes,minute,1);}
    for(let n=Math.ceil(minute*possessions/periodLength);n<Math.ceil((minute+1)*possessions/periodLength);n++){a(n);h(n);}
    if(dynamic){foulMinute(away,awayLineups,minute);foulMinute(home,homeLineups,minute);}
  }
  if(dynamic)for(const [t,team,mins] of [[0,away,awayMinutes],[1,home,homeMinutes]] as const)team.forEach((p,i)=>{mins[i]=actual[t][i];p.min=before[t][i]+mins[i];});
}
