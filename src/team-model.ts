import {fitAvailability,type AvailabilityObservation} from './model-evidence.ts';
import { selectRolePrior } from './role-model.ts';
import { fitTeamEffects, restDays } from './team-effects.ts';
import { chicagoDate } from './date.ts';
import type { CompletedEvent } from './parse-summary.ts';
import type { MatchupContext, RatePlayer, SlateGame, TeamProfile } from './types.ts';

export const MODEL_VERSION = 'possessions-v2';
// Shrinkage strengths are modeling priors, not fitted calibration coefficients.
const TEAM_PRIOR_GAMES = 12;
const PRIOR_SEASON_WEIGHT = 0.2;
export const FT_POSSESSION_EQUIVALENT = 0.44; // Conventional box-score possession estimator; trips are approximated.
const sum = (xs: number[]) => xs.reduce((a,b) => a+b,0);
const mean = (xs: number[]) => sum(xs)/xs.length;
export function eventPossessions(e: CompletedEvent, team: string): number {
  const rows = e.players.filter(p => p.team_id === team);
  if (rows.some(p => p.tov === undefined || p.orb === undefined)) throw new Error('Missing possession stats');
  return sum(rows.map(p => p.fga + FT_POSSESSION_EQUIVALENT*p.fta - p.orb! + p.tov!));
}
export function eligibleEvents(events: CompletedEvent[], cutoff: string): CompletedEvent[] {
  // No historical final timestamps: conservatively exclude the entire target Chicago date.
  return events.filter(e => e.season_type === 2 && Date.parse(e.start_time) < Date.parse(cutoff) && chicagoDate(new Date(e.start_time)) < chicagoDate(new Date(cutoff)));
}
export function fitMatchup(events: CompletedEvent[], game: SlateGame, cutoff: string): MatchupContext {
  const history = eligibleEvents(events,cutoff).filter(e => e.players.every(p => p.tov !== undefined && p.orb !== undefined));
  if (!history.length) throw new Error('No completed possession history');
  const effects=fitTeamEffects(history,eventPossessions);
  const samples = history.flatMap(e => [e.away_team_id,e.home_team_id].map(team => {
    const rows = e.players.filter(p => p.team_id === team);
    const other = e.players.filter(p => p.team_id !== team);
    const poss = (eventPossessions(e,team) + eventPossessions(e,team === e.home_team_id ? e.away_team_id : e.home_team_id))/2;
    return {e,team,rows,other,poss,pace:poss*48/(48+5*(e.periods-4)),weight:e.season===game.season?1:PRIOR_SEASON_WEIGHT};
  }));
  const possessions = sum(samples.map(x => x.poss*x.weight));
  const league = sum(samples.map(x => sum(x.rows.map(p => p.pts))*x.weight))/possessions;
  const pace = sum(samples.map(x => x.pace*x.weight))/sum(samples.map(x => x.weight));
  const leagueTov = sum(samples.map(x => sum(x.rows.map(p => p.tov!))*x.weight))/possessions;
  const leagueOrb = sum(samples.map(x => sum(x.rows.map(p => p.orb!))*x.weight))/sum(samples.map(x => sum(x.rows.map(p => p.fga-p.fgm))*x.weight));
  const leagueAst = sum(samples.map(x => sum(x.rows.map(p => p.ast))*x.weight))/sum(samples.map(x => sum(x.rows.map(p => p.fgm))*x.weight));
  const leagueTrips = sum(samples.map(x => sum(x.rows.map(p => p.fta/2))*x.weight))/possessions;
  const profile = (team: string): TeamProfile => {
    const xs = samples.filter(x => x.team===team);
    const n = sum(xs.map(x => x.weight));
    const shrink = (values: number[], prior: number) => (sum(values.map((v,i) => v*xs[i].weight)) + TEAM_PRIOR_GAMES*prior)/(n+TEAM_PRIOR_GAMES);
    const last = xs.map(x=>Date.parse(x.e.start_time)).sort((a,b)=>b-a)[0];
    return { pace:shrink(xs.map(x=>x.pace),pace), offense:effects.offense[team]??league,
      defense:effects.defense[team]??league,
      turnover_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.tov!))/x.poss),leagueTov),
      offensive_rebound_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.orb!))/Math.max(1,sum(x.rows.map(p=>p.fga-p.fgm)))),leagueOrb),
      assist_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.ast))/Math.max(1,sum(x.rows.map(p=>p.fgm)))),leagueAst),
      ft_trip_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.fta/2))/x.poss),leagueTrips),
      games:xs.length, rest_days:Number.isFinite(last)?restDays(new Date(last).toISOString(),game.start_time):null };
  };
  const paceSD = Math.sqrt(mean(samples.map(x => (x.pace-pace)**2)));
  return {away:profile(game.away.team_id),home:profile(game.home.team_id),league_efficiency:league,pace_sd:paceSD,home_log_advantage:effects.home,rest_coefficient:effects.rest,neutral:game.neutral_site===true,training_games:history.length};
}

export function fitCurrentRoles(players: RatePlayer[], events: CompletedEvent[], season: number, availability:AvailabilityObservation[]=[], cutoff:string=new Date().toISOString()): void {
  const selection=selectRolePrior(events,season);
  const ROLE_PRIOR_GAMES=selection.prior_games;
  for (const p of players) {
    p.active_season=season;p.role_prior_games=ROLE_PRIOR_GAMES;
    const teamEvents = events.filter(e => e.season===season && [e.home_team_id,e.away_team_id].includes(p.team_id));
    const current = teamEvents.flatMap(e => e.players.filter(r=>r.athlete_id===p.athlete_id).map(r=>({r,date:e.start_time})) ).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    const prior = events.filter(e=>e.season===season-1).flatMap(e=>e.players.filter(r=>r.athlete_id===p.athlete_id));
    const priorMean = prior.length ? mean(prior.map(r=>r.minutes)) : p.minutes_mean;
    const recent = current.slice(0,5);
    const weights = recent.map(()=>1);
    p.minutes_mean = !recent.length ? priorMean : (sum(recent.map((x,i)=>x.r.minutes*weights[i]))+ROLE_PRIOR_GAMES*priorMean)/(sum(weights)+ROLE_PRIOR_GAMES);
    const starts=current.filter(x=>x.r.starter!==undefined);
    p.starter_rate=starts.length?starts.filter(x=>x.r.starter).length/starts.length:null;
    p.team_games = teamEvents.length;
    p.current_team_games = current.length;
    const known=teamEvents.flatMap(e=>(e.participation??[]).filter(r=>r.athlete_id===p.athlete_id&&r.team_id===p.team_id));
    const priorKnown=events.filter(e=>e.season===season-1).flatMap(e=>(e.participation??[]).filter(r=>r.athlete_id===p.athlete_id));
    // Weak Beta(1,1) participation prior where explicit roster/DNP records exist.
    // Legacy boxes do not identify absent roster members: use their appearance-based scenario prior and expose unknown coverage.
    const priorPlay=priorKnown.length?(1+priorKnown.filter(r=>r.played).length)/(2+priorKnown.length):.5;
    let play=known.length?(known.filter(r=>r.played).length+2*priorPlay)/(known.length+2):teamEvents.length?(current.length+2*priorPlay)/(teamEvents.length+2):priorPlay;
    p.participation_coverage={known:known.length,unknown:teamEvents.length-known.length,source:known.length?'explicit-DNP':'scenario-prior'};
    const status = p.injury_status;
    const fittedAvailability=fitAvailability(availability,status,cutoff);
    p.availability_calibration_n=fittedAvailability?.n??0;
    if (p.minutes_weight===0) play=0;
    else if(fittedAvailability)play*=fittedAvailability.probability;
    else if (status==='doubtful') play*=0.1;
    else if (status==='probable') play*=0.9;
    else if (p.questionable_widen) play*=0.5;
    if(fittedAvailability?.conditional_minutes!=null&&p.injury_status!=='healthy')p.minutes_mean=Math.min(p.minutes_mean,fittedAvailability.conditional_minutes);
    if(p.minutes_restriction!=null)p.minutes_mean=Math.min(p.minutes_mean,p.minutes_restriction);
    p.play_probability=play;
    p.minutes_source = `recent regular-season appearances (${current.length}/${teamEvents.length}); ${ROLE_PRIOR_GAMES}-game prior (${selection.source}, ${selection.samples} validation appearances)`;
  }
}
