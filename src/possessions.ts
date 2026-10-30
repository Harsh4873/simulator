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
 * Synthetic five-player stints realize period minutes; actual substitution history is unknown.
 */
export function drawPossessions(
  away: DrawnPlayer[], home: DrawnPlayer[], roster: RatePlayer[], awayMinutes: number[], homeMinutes: number[],
  context: MatchupContext, possessions: number, rng: Rng,
): void {
  const periodLength=awayMinutes.reduce((a,b)=>a+b,0)/5;
  const awayLineups=minuteLineups(awayMinutes,periodLength,rng),homeLineups=minuteLineups(homeMinutes,periodLength,rng);
  const rates = new Map(roster.map(p=>[p.athlete_id,p]));
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
    const ftShare = fta/2/Math.max(1,fga+fta/2);
    const fgValue = sum(p.map((x,i)=>shots[i]*(2*(1-x.tpa_given_fga)*x.fg2_pct+3*x.tpa_given_fga*x.tp_pct)))/Math.max(1,fga);
    const fgPct = sum(p.map((x,i)=>shots[i]*((1-x.tpa_given_fga)*x.fg2_pct+x.tpa_given_fga*x.tp_pct)))/Math.max(1,fga);
    const ftPct = sum(p.map((x,i)=>fts[i]*x.ft_pct))/Math.max(1,fta);
    const orb = bound(profile.offensive_rebound_rate);
    const tov = bound(profile.turnover_rate);
    const raw = (1-tov)*((1-ftShare)*fgValue+ftShare*2*ftPct)/Math.max(0.1,1-(1-tov)*(1-ftShare)*(1-fgPct)*orb);
    // Equal-strength shrinkage between the available lineup's scoring profile and observed team efficiency.
    // This prior weight requires walk-forward calibration; no market values enter this expression.
    const target = Math.sqrt(Math.max(0.01,raw)*profile.offense)*opponent.defense/context.league_efficiency*Math.exp(venue);
    // Solve expected points per possession for a make-rate multiplier, including second chances.
    const expected = (scale:number) => {
      const fg = sum(p.map((x,i)=>shots[i]*((1-x.tpa_given_fga)*bound(x.fg2_pct*scale)+x.tpa_given_fga*bound(x.tp_pct*scale))))/Math.max(1,fga);
      const pts = sum(p.map((x,i)=>shots[i]*(2*(1-x.tpa_given_fga)*bound(x.fg2_pct*scale)+3*x.tpa_given_fga*bound(x.tp_pct*scale))))/Math.max(1,fga);
      return (1-tov)*((1-ftShare)*pts+ftShare*2*ftPct)/(1-(1-tov)*(1-ftShare)*(1-fg)*orb);
    };
    let lo=0,hi=3;
    for(let j=0;j<20;j++){const mid=(lo+hi)/2;if(expected(mid)<target)lo=mid;else hi=mid;}
    const efficiency=(lo+hi)/2;
    const stealChance=bound(sum(steals)/Math.max(1,possessions*tov));
    const blockChance=bound(sum(blocks)/Math.max(1,possessions*(1-tov)*(1-fgPct)));
    for(let n=0;n<possessions;n++) {
      const minute=Math.min(periodLength-1,Math.floor(n*periodLength/possessions));
      const on=new Set(offStints[minute]),against=new Set(defStints[minute]);
      shots=p.map((x,i)=>on.has(i)?x.fga_per_min:0);fts=p.map((x,i)=>on.has(i)?x.fta_per_min:0);
      creators=p.map((x,i)=>on.has(i)?x.ast_per_min:0);offensiveBoards=p.map((x,i)=>on.has(i)?x.reb_per_min:0);
      turnovers=p.map((x,i)=>on.has(i)?x.tov_per_min??0:0);
      defensiveBoards=q.map((x,i)=>against.has(i)?x.reb_per_min:0);steals=q.map((x,i)=>against.has(i)?x.stl_per_min??0:0);blocks=q.map((x,i)=>against.has(i)?x.blk_per_min??0:0);
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
        const free=rng()<ftShare;
        const shooter=pick(free?fts:shots,rng);
        if(shooter<0)throw new Error('No active shooting exposure');
        const line=off[shooter],rate=p[shooter];
        let miss=false;
        if(free) {
          line.fta+=2;
          for(let attempt=0;attempt<2;attempt++) {
            const made=rng()<rate.ft_pct;
            if(made){line.ftm++;line.pts++;}
            if(attempt===1)miss=!made;
          }
        } else {
          const three=rng()<rate.tpa_given_fga;
          line.fga++;if(three)line.tpa++;
          const made=rng()<bound((three?rate.tp_pct:rate.fg2_pct)*efficiency);
          if(made) {
            line.fgm++;if(three)line.tpm++;line.pts+=three?3:2;
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
  const venue=(context.neutral?0:context.home_log_advantage)+rest;
  attack(away,home,awayMinutes,homeMinutes,context.away,context.home,-venue,awayLineups,homeLineups);
  attack(home,away,homeMinutes,awayMinutes,context.home,context.away,venue,homeLineups,awayLineups);
}
