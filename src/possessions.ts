import { availablePlayer, healthyReserve, InsufficientRosterError, relaxMinuteCaps } from './roster-capacity.ts';
import {rotationStateKey} from './game-state-model.ts';
import {lateFoulState} from './free-throw-model.ts';
import {usageWeights} from './usage-effects.ts';
import {lineupLogEffect} from './lineup-effects.ts';
import { minuteLineups } from './lineups.ts';
import { personnelFactor } from './personnel.ts';
import { leadTilt } from './lead-effect.ts';
import { concentrate } from './usage-concentration.ts';
import type { DrawnPlayer } from './simulate.ts';
import type { MatchupContext, RatePlayer, TeamProfile } from './types.ts';
import type { Rng } from './rng.ts';

function pick(weights: readonly number[], rng: Rng): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (!(total>0)) return -1;
  let target = rng()*total;
  for (let i=0;i<weights.length;i++) {target-=weights[i];if(target<0)return i;}
  return weights.length-1;
}
function sum(xs: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < xs.length; i++) total += xs[i];
  return total;
}
const bound = (v:number) => Math.max(0,Math.min(1,v));


/** Largest share of a lineup's makes a player is credited with when turning an assist rate into a per-teammate-make propensity. */
export const MAX_OWN_MAKE_SHARE=0.6;
/** Minute average of a lineup's summed rates over the planned stints; dividing by it keeps team totals where the team model put them. */
export function plannedLineupMean(values:number[],stints:number[][]):number{
 if(!stints.length)return 0;
 return stints.reduce((n,on)=>n+on.reduce((m,i)=>m+values[i],0),0)/stints.length;
}

/** Aggregate possession model: shared pace, competitive rebounds, one assister per make.
 * Synthetic five-player stints realize minute targets and observed opening/closing roles.
 */
export function drawPossessions(
  away: DrawnPlayer[], home: DrawnPlayer[], roster: RatePlayer[], awayMinutes: number[], homeMinutes: number[],
  context: MatchupContext, possessions: number, rng: Rng,
): number[] {
  const periodLength=sum(awayMinutes)/5;
  const rates = new Map(roster.map(p=>[p.athlete_id,p]));
  const awayRates = away.map(p=>rates.get(p.athlete_id)!), homeRates = home.map(p=>rates.get(p.athlete_id)!);
  const awayStarter = awayRates.map(r=>(r.starter_rate??0)>=.5), homeStarter = homeRates.map(r=>(r.starter_rate??0)>=.5);
  const roles=(teamRates:RatePlayer[])=>({opening:teamRates.map(r=>r?.starter_rate??0),closing:teamRates.map(r=>r?.closing_rate??0)});
  const awayLineups=minuteLineups(awayMinutes,periodLength,rng,roles(awayRates)),homeLineups=minuteLineups(homeMinutes,periodLength,rng,roles(homeRates));
  const dynamic=context.rotation_state?.status==='fitted'||context.fouls?.status==='fitted';
  const actual=[new Array<number>(away.length).fill(0),new Array<number>(home.length).fill(0)];
  const emergency=[new Set<number>(),new Set<number>()];
  const before=[away.map((p,i)=>p.min-awayMinutes[i]),home.map((p,i)=>p.min-homeMinutes[i])];
  const beforeMinutesOffset=sum(before[0])/5;
  let awayScore=0,homeScore=0;
  for(let i=0;i<away.length;i++)awayScore+=away[i].pts;
  for(let i=0;i<home.length;i++)homeScore+=home[i].pts;
  const caps=[away,home].map((team,t)=>team.map((p,i)=>{
    const rate=t===0?awayRates[i]:homeRates[i];
    const thin=rate.shooting_games===0&&(rate.games<3||(rate.games_2027===0&&rate.games_2026<20));
    if (p.minute_cap_relaxed) return periodLength;
    return Math.max(0,Math.floor(Math.min(periodLength,(rate.minutes_restriction??(thin?12:Infinity))-before[t][i])));
  }));
  const eligMask=[new Uint8Array(away.length),new Uint8Array(home.length)];
  const adjust=(team:DrawnPlayer[],teamRates:RatePlayer[],isStarter:boolean[],stints:number[][],mins:number[],minute:number,t:number)=>{
    const n=team.length,mask=eligMask[t],act=actual[t],cap=caps[t],bef=before[t],emerg=emergency[t];
    mask.fill(0);
    const eligible:number[]=[];
    for(let i=0;i<n;i++){
      if((bef[i]+mins[i]>0||emerg.has(i))&&(team[i].fouls??0)<6&&act[i]<cap[i]){eligible.push(i);mask[i]=1;}
    }
    // A healthy coach-DNP can enter if a foul-out exhausts the sampled rotation.
    // A missed uncertain/injured availability draw never becomes an emergency substitute.
    if(eligible.length<5){
      const reserves:number[]=[];
      for(let i=0;i<n;i++)if(!mask[i]&&bef[i]+mins[i]===0&&healthyReserve(team[i])&&(team[i].fouls??0)<6&&cap[i]-act[i]>=periodLength-minute)reserves.push(i);
      reserves.sort((a,b)=>teamRates[b].minutes_mean-teamRates[a].minutes_mean);
      while(eligible.length<5&&reserves.length){const i=reserves.shift()!;emerg.add(i);eligible.push(i);mask[i]=1;}
    }
    if(eligible.length<5){
      const sitters:number[]=[];
      for(let i=0;i<n;i++)if(!mask[i]&&availablePlayer(team[i])&&(team[i].fouls??0)<6&&cap[i]-act[i]>=periodLength-minute)sitters.push(i);
      sitters.sort((a,b)=>teamRates[b].minutes_mean-teamRates[a].minutes_mean);
      while(eligible.length<5&&sitters.length){const i=sitters.shift()!;emerg.add(i);eligible.push(i);mask[i]=1;}
    }
    if (eligible.length < 5) {
      const available:number[]=[];
      for(let i=0;i<n;i++)if(availablePlayer(team[i])&&(team[i].fouls??0)<6&&(bef[i]+mins[i]>0||emerg.has(i)||healthyReserve(team[i])))available.push(i);
      if (available.length < 5) throw new InsufficientRosterError(team[0].team_id);
      const remaining = periodLength-minute;
      const oldCaps = available.map(i=>Math.max(0,Math.min(remaining,cap[i]-act[i])));
      const relaxed = relaxMinuteCaps(oldCaps,available.map(()=>remaining),remaining*5,team[0].team_id);
      available.forEach((i,j)=>{
        if(relaxed[j]>oldCaps[j]){cap[i]=act[i]+relaxed[j];team[i].minute_cap_relaxed=true;}
        if(healthyReserve(team[i]))emerg.add(i);
      });
      eligible.length=0;mask.fill(0);
      for(let j=0;j<available.length;j++){const i=available[j];if(act[i]<cap[i]){eligible.push(i);mask[i]=1;}}
    }
    const planned=stints[minute],chosen:number[]=[];
    for(let k=0;k<planned.length;k++){const i=planned[k];if(mask[i])chosen.push(i);}
    if(chosen.length<5){
      const candidates:number[]=[];
      for(let k=0;k<eligible.length;k++){const i=eligible[k];if(!chosen.includes(i))candidates.push(i);}
      candidates.sort((a,b)=>(mins[b]-act[b])-(mins[a]-act[a]));
      let cIdx=0;
      while(chosen.length<5&&cIdx<candidates.length)chosen.push(candidates[cIdx++]);
    }
    if(chosen.length!==5)throw new InsufficientRosterError(team[0].team_id);
    const model=context.rotation_state;
    if(periodLength===48&&model?.status==='fitted'){
      const margin=awayScore-homeScore,key=rotationStateKey(minute,margin),base=model.baseline[key.split(':')[0]],share=model.shares[key]??base;
      // Replace only the excess role probability relative to the observed time-only baseline.
      const increase=share>base,probability=increase?(share-base)/(1-base):(base-share)/base;
      for(let slot=0;slot<chosen.length;slot++)if(isStarter[chosen[slot]]!==increase&&rng()<probability){
        const replacements:number[]=[];
        for(let k=0;k<eligible.length;k++){
          const i=eligible[k];
          if(isStarter[i]===increase&&!chosen.includes(i))replacements.push(i);
        }
        if(replacements.length){
          replacements.sort((a,b)=>(mins[b]-act[b])-(mins[a]-act[a]));
          chosen[slot]=replacements[0];
        }
      }
    }
    stints[minute]=chosen;for(let k=0;k<chosen.length;k++)act[chosen[k]]++;
  };
  const foulMinute=(team:DrawnPlayer[],stints:number[][],minute:number)=>{
    const model=context.fouls;if(model?.status!=='fitted')return;
    const on=stints[minute];
    for(let k=0;k<on.length;k++){
      const i=on[k],p=team[i],previousFouls=p.fouls??0,weights=model.conditional?model.by_count[previousFouls]??model.probabilities:model.probabilities;
      p.fouls=Math.min(6,previousFouls+Math.max(0,pick(weights,rng)));if(p.fouls===6&&previousFouls<6)p.foul_out_minute=beforeMinutesOffset+minute+1;
    }
  };
  // Home minus away expected points per possession, set once both targets are solved.
  let edge=0;
  const attack = (off: DrawnPlayer[], def: DrawnPlayer[], p: RatePlayer[], q: RatePlayer[], mins: number[], defMins: number[], profile: TeamProfile, opponent: TeamProfile, venue: number, offStints:number[][], defStints:number[][], side: 1|-1) => {
    const pLen = p.length, qLen = q.length;
    let shots = p.map((x,i)=>mins[i]*x.fga_per_min);
    let fts = p.map((x,i)=>mins[i]*x.fta_per_min);
    const creators = p.map((x,i)=>mins[i]*x.ast_per_min);
    const offensiveBoards = p.map((x,i)=>mins[i]*x.reb_per_min*(x.orb_share ?? 1));
    const defensiveBoards = q.map((x,i)=>defMins[i]*x.reb_per_min*(x.orb_share !== undefined ? 1 - x.orb_share : 1));
    const steals = q.map((x,i)=>defMins[i]*(x.stl_per_min ?? 0));
    const blocks = q.map((x,i)=>defMins[i]*(x.blk_per_min ?? 0));
    const turnovers = p.map((x,i)=>mins[i]*(x.tov_per_min ?? 0));
    const fga=sum(shots), fta=sum(fts);
    // Shot and trip shares lean toward high-usage players by the fitted exponent; team totals stay the same.
    const usage=context.usage_concentration?.status==='fitted'?context.usage_concentration:null;
    const shotExponent=usage?.shots??1,tripExponent=usage?.trips??1,assistExponent=usage?.assists??1,reboundExponent=usage?.rebounds??1;
    // Box scores credit only part of non-offensive-rebound misses to a defender; the rest are uncredited team rebounds.
    const defensiveCredit=context.rebound_credit?.status==='fitted'?context.rebound_credit.defensive:1;
    const rescale=(xs:number[],total:number)=>{const s=sum(xs);return s>0?xs.map(x=>x*total/s):xs;};
    shots=rescale(p.map((x,i)=>mins[i]*concentrate(x.fga_per_min,shotExponent)),fga);
    fts=rescale(p.map((x,i)=>mins[i]*concentrate(x.fta_per_min,tripExponent)),fta);
    // Lineup intensity: a unit's assists, offensive boards and free-throw trips scale with its players' summed rates,
    // normalized over the planned stints so team totals stay with the team model. Splitting a fixed number of events
    // each minute instead gave stars, who play beside other high-rate starters, less than their rate and bench units more.
    const assistBase=p.map(x=>concentrate(x.ast_per_min,assistExponent)),tripBase=p.map(x=>concentrate(x.fta_per_min,tripExponent));
    const offBoardBase=p.map(x=>concentrate(x.reb_per_min*(x.orb_share ?? 1),reboundExponent)),defBoardBase=q.map(x=>concentrate(x.reb_per_min*(x.orb_share !== undefined ? 1 - x.orb_share : 1),reboundExponent));
    const assistMean=plannedLineupMean(assistBase,offStints),tripLineupMean=plannedLineupMean(tripBase,offStints);
    const offBoardMean=plannedLineupMean(offBoardBase,offStints),defBoardMean=plannedLineupMean(defBoardBase,defStints);
    const makeRate=p.map(x=>(1-x.tpa_given_fga)*x.fg2_pct+x.tpa_given_fga*x.tp_pct);
    let tripScale=1,boardOdds=1,turnoversPositive=false;
    const ftModel=context.free_throws?.status==='fitted'?context.free_throws:null;
    const tripTypes=ftModel?.trip_types?.length?ftModel.trip_types:null;
    const tripTypeWeights=tripTypes?tripTypes.map(t=>t.weight):null;
    const tripMean=ftModel?2*ftModel.trip_weights[0]+3*ftModel.trip_weights[1]:2;
    const andOne=ftModel?.and_one_per_make??0,technical=ftModel?.technical_per_possession??0;
    const retained=ftModel?.retained_per_possession??0,retainedWeights=ftModel?.retained_trip_weights??[0,0,0];
    const retainedAttempts=retainedWeights.reduce((s,w,i)=>s+w*(i+1),0)*retained;
    const expectedMakesAtBase=sum(p.map((_,i)=>shots[i]*makeRate[i]));
    const ordinaryAttempts=Math.max(0,fta-expectedMakesAtBase*andOne-possessions*(technical+retainedAttempts));
    const ftShare = ordinaryAttempts/tripMean/Math.max(1,fga+ordinaryAttempts/tripMean);
    const fgPct = expectedMakesAtBase/Math.max(1,fga);
    const ftPct = sum(p.map((x,i)=>fts[i]*x.ft_pct))/Math.max(1,fta);
    const orb = bound(profile.offensive_rebound_rate);
    const tov = bound(profile.turnover_rate);
    const factor = personnelFactor(p,mins,profile,context.free_throws,possessions);
    // Tonight's lineup relative to the same roster at role minutes, including OUT players still on the card.
    // Full-strength personnel keeps the fitted team rating; absences scale it. No geometric-mean shrinkage toward league-like player rates.
    const target = Math.max(0.01,profile.offense*factor)*opponent.defense/context.league_efficiency*Math.exp(venue);
    // Solve expected points per possession for a make-rate multiplier, including second chances.
    const expected = (scale:number) => {
      let fgNum=0,ptsNum=0;
      for(let i=0;i<pLen;i++){
        const x=p[i],sh=shots[i],p2=bound(x.fg2_pct*scale),p3=bound(x.tp_pct*scale),tpa=x.tpa_given_fga;
        fgNum+=sh*((1-tpa)*p2+tpa*p3);
        ptsNum+=sh*(2*(1-tpa)*p2+3*tpa*p3);
      }
      const fg = fgNum/Math.max(1,fga);
      const pts = ptsNum/Math.max(1,fga);
      return ((1-tov)*((1-ftShare)*(pts+fg*andOne*ftPct)+ftShare*tripMean*ftPct)+(technical+retainedAttempts)*ftPct)/(1-(1-tov)*((1-ftShare)*(1-fg+fg*andOne*(1-ftPct))+ftShare*(1-ftPct))*orb);
    };
    let lo=0,hi=3;
    for(let j=0;j<20;j++){const mid=(lo+hi)/2;if(expected(mid)<target)lo=mid;else hi=mid;}
    const efficiency=(lo+hi)/2;
    const stealChance=bound(sum(steals)/Math.max(1,possessions*tov));
    const blockChance=bound(sum(blocks)/Math.max(1,possessions*(1-tov)*(1-fgPct)));
    const lineupEffectsFitted=context.lineup_effects?.status==='fitted';
    const leadModel=context.lead_effect?.status==='fitted'?context.lead_effect:null;
    const lateModel=ftModel?.late?.status==='fitted'?ftModel.late:null;
    const lateOddsRatio=lateModel?(lateModel.share/(1-lateModel.share))/(lateModel.baseline_share/(1-lateModel.baseline_share)):1;
    const addOffPts=(pts:number)=>{if(side===1)homeScore+=pts;else awayScore+=pts;};
    let lastMinute=-1,lineupEffect=0;
    const play = (n:number) => {
      const minute=Math.min(periodLength-1,Math.floor(n*periodLength/possessions));
      if(minute!==lastMinute){
        lastMinute=minute;
        const active=offStints[minute],against=defStints[minute];
        const activeSet=new Set(active),againstSet=new Set(against);
        const activeOrdered=[...activeSet],againstOrdered=[...againstSet];
        shots.fill(0);fts.fill(0);creators.fill(0);offensiveBoards.fill(0);turnovers.fill(0);
        defensiveBoards.fill(0);steals.fill(0);blocks.fill(0);
        const activeWeights=usageWeights(context.usage_effects,off[0].team_id,activeOrdered.map(i=>off[i].athlete_id),activeOrdered.map(i=>p[i].fga_per_min));
        for(let j=0;j<activeOrdered.length;j++)shots[activeOrdered[j]]=concentrate(activeWeights[j],shotExponent);
        for(let i=0;i<pLen;i++)if(activeSet.has(i)){
          fts[i]=tripBase[i];
          offensiveBoards[i]=offBoardBase[i];
          turnovers[i]=p[i].tov_per_min??0;
        }
        // An assist rate counts only teammates' baskets, so divide out the player's own share of the unit's makes:
        // with the shooter skipped on each make, expected assists then follow the rate instead of losing that share twice.
        let unitMakes=0;
        for(let i=0;i<pLen;i++)unitMakes+=shots[i]*makeRate[i];
        for(let i=0;i<pLen;i++)if(activeSet.has(i)){
          const m=shots[i]*makeRate[i];
          creators[i]=assistBase[i]/(1-Math.min(MAX_OWN_MAKE_SHARE,unitMakes>0?m/unitMakes:0));
        }
        tripScale=tripLineupMean>0?sum(fts)/tripLineupMean:1;
        turnoversPositive=sum(turnovers)>0;
        for(let i=0;i<qLen;i++)if(againstSet.has(i)){
          defensiveBoards[i]=defBoardBase[i];
          steals[i]=q[i].stl_per_min??0;
          blocks[i]=q[i].blk_per_min??0;
        }
        const sumDefBoards=sum(defensiveBoards);
        boardOdds=offBoardMean>0&&defBoardMean>0&&sumDefBoards>0?(sum(offensiveBoards)/offBoardMean)/(sumDefBoards/defBoardMean):1;
        lineupEffect=lineupEffectsFitted?lineupLogEffect(context.lineup_effects,off[0].team_id,activeOrdered.map(i=>off[i].athlete_id),'offense')+lineupLogEffect(context.lineup_effects,def[0].team_id,againstOrdered.map(i=>def[i].athlete_id),'defense'):0;
      }
      if(technical>0&&rng()<technical){const who=pick(fts,rng);if(who>=0){off[who].fta++;off[who].ft_technical=(off[who].ft_technical??0)+1;if(rng()<p[who].ft_pct){off[who].ftm++;off[who].pts++;addOffPts(1);}}}
      if(retained>0&&rng()<retained){const who=pick(fts,rng),size=pick(retainedWeights,rng)+1;if(who>=0&&size>0){off[who].fta+=size;off[who].ft_retained=(off[who].ft_retained??0)+size;for(let i=0;i<size;i++)if(rng()<p[who].ft_pct){off[who].ftm++;off[who].pts++;addOffPts(1);}}}

      let live=true;
      let guard=0;
      while(live) {
        if(++guard>1000)throw new Error('Possession did not end');
        live=false;
        if(rng()<tov) {
          const who=pick(turnoversPositive?turnovers:shots,rng);
          if(who>=0)off[who].tov=(off[who].tov??0)+1;
          if(rng()<stealChance){const who=pick(steals,rng);if(who>=0)def[who].stl=(def[who].stl??0)+1;}
          continue;
        }
        const margin=lateModel&&minute>=periodLength-2?(side===1?homeScore-awayScore:awayScore-homeScore):0;
        const inLate=lateModel!==null&&lateFoulState(periodLength===48?Math.floor(minute/12)+1:5,(periodLength-minute)*60,margin);
        const odds=inLate?lateOddsRatio:1;
        const tripOdds=odds*tripScale;
        const free=rng()<(ftShare*tripOdds/(1-ftShare+ftShare*tripOdds));
        const shooter=pick(free?fts:shots,rng);
        if(shooter<0)throw new Error('No active shooting exposure');
        const line=off[shooter],rate=p[shooter];
        let miss=false;
        if(free) {
          const trip=tripTypes&&tripTypeWeights?tripTypes[pick(tripTypeWeights,rng)]:null;
          const attempts=trip?.attempts??(ftModel&&rng()<ftModel.trip_weights[1]?3:2);
          if(trip?.kind==='bonus')line.ft_bonus=(line.ft_bonus??0)+attempts;
          line.ft_possession_trips=(line.ft_possession_trips??0)+1;
          line.fta+=attempts;
          for(let attempt=0;attempt<attempts;attempt++) {
            const made=rng()<rate.ft_pct;
            if(made){line.ftm++;line.pts++;addOffPts(1);}
            if(attempt===attempts-1)miss=!made;
          }
        } else {
          const three=rng()<rate.tpa_given_fga;
          line.fga++;if(three)line.tpa++;
          // Trailing teams make a little more and leading teams a little less, fitted from quarter-by-quarter give-back.
          const offMargin=side===1?homeScore-awayScore:awayScore-homeScore;
          const tilt=leadModel?leadTilt(leadModel,offMargin-side*edge*n,periodLength!==48||minute>=36):0;
          const made=rng()<bound((three?rate.tp_pct:rate.fg2_pct)*efficiency*Math.exp(lineupEffect+tilt));
          if(made) {
            const fgPts=three?3:2;
            line.fgm++;if(three)line.tpm++;line.pts+=fgPts;addOffPts(fgPts);
            if(andOne>0&&rng()<andOne){line.fta++;line.ft_and_one=(line.ft_and_one??0)+1;if(rng()<rate.ft_pct){line.ftm++;line.pts++;addOffPts(1);}else miss=true;}
            // Averaged over shooters, the teammates' propensities sum to the unit's assist rates, so this keeps the
            // team's assisted share on its fitted rate while a unit of playmakers assists more of its makes.
            const savedCreator=creators[shooter];
            creators[shooter]=0;
            const helperSum=sum(creators);
            if(rng()<bound(profile.assist_rate*(assistMean>0?helperSum/assistMean:1))) {
              const helper=pick(creators,rng);
              if(helper>=0)off[helper].ast++;
            }
            creators[shooter]=savedCreator;
          } else {
            miss=true;
            if(rng()<blockChance){const who=pick(blocks,rng);if(who>=0)def[who].blk=(def[who].blk??0)+1;}
          }
        }
        if(miss) {
          const unitOrb=boardOdds===1?orb:(orb*boardOdds)/(1-orb+orb*boardOdds);
          if(rng()<unitOrb) {
            const who=pick(offensiveBoards,rng);
            if(who>=0){off[who].reb++;off[who].orb=(off[who].orb??0)+1;live=true;}
          } else if(defensiveCredit>=1||rng()<defensiveCredit) {
            const who=pick(defensiveBoards,rng);
            if(who>=0){def[who].reb++;def[who].drb=(def[who].drb??0)+1;}
          }
        }
      }
    };
    return Object.assign(play,{target});
  };
  const rest=context.away.rest_days!==null&&context.home.rest_days!==null?(context.rest_coefficient??0)*(Math.log1p(context.home.rest_days)-Math.log1p(context.away.rest_days)):0;
  const delta=(key:'previous_minutes'|'travel_km'|'timezone_change_hours')=>{const a=context.away.schedule?.[key],h=context.home.schedule?.[key];return a!=null&&h!=null?h-a:0;};
  const venue=(context.neutral?0:context.home_log_advantage)+rest+(context.workload_coefficient??0)*delta('previous_minutes')/5+(context.travel_coefficient??0)*delta('travel_km')/1000+(context.timezone_coefficient??0)*delta('timezone_change_hours');
  const a=attack(away,home,awayRates,homeRates,awayMinutes,homeMinutes,context.away,context.home,-venue,awayLineups,homeLineups,-1);
  const h=attack(home,away,homeRates,awayRates,homeMinutes,awayMinutes,context.home,context.away,venue,homeLineups,awayLineups,1);
  edge=h.target-a.target;
  // Home margins at the end of the first three quarters, for checking quarter dynamics against real games.
  const checkpoints:number[]=[];
  for(let minute=0;minute<periodLength;minute++){
    if(dynamic){adjust(away,awayRates,awayStarter,awayLineups,awayMinutes,minute,0);adjust(home,homeRates,homeStarter,homeLineups,homeMinutes,minute,1);}
    for(let n=Math.ceil(minute*possessions/periodLength);n<Math.ceil((minute+1)*possessions/periodLength);n++){a(n);h(n);}
    if(dynamic){foulMinute(away,awayLineups,minute);foulMinute(home,homeLineups,minute);}
    if(periodLength===48&&minute%12===11&&minute<47)checkpoints.push(homeScore-awayScore);
  }
  if(dynamic)for(const [t,team,mins] of [[0,away,awayMinutes],[1,home,homeMinutes]] as const)team.forEach((p,i)=>{mins[i]=actual[t][i];p.min=before[t][i]+mins[i];});
  return checkpoints;
}
