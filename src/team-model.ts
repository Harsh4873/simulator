import { chicagoDate } from './date.ts';
import type { CompletedEvent } from './parse-summary.ts';
import type { MatchupContext, RatePlayer, SlateGame, TeamProfile } from './types.ts';

export const MODEL_VERSION = 'possessions-v1';
// Shrinkage strengths are modeling priors, not fitted calibration coefficients.
const TEAM_PRIOR_GAMES = 12;
const ROLE_PRIOR_GAMES = 3;
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
    return { pace:shrink(xs.map(x=>x.pace),pace), offense:shrink(xs.map(x=>sum(x.rows.map(p=>p.pts))/x.poss),league),
      defense:shrink(xs.map(x=>sum(x.other.map(p=>p.pts))/x.poss),league),
      turnover_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.tov!))/x.poss),leagueTov),
      offensive_rebound_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.orb!))/Math.max(1,sum(x.rows.map(p=>p.fga-p.fgm)))),leagueOrb),
      assist_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.ast))/Math.max(1,sum(x.rows.map(p=>p.fgm)))),leagueAst),
      ft_trip_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.fta/2))/x.poss),leagueTrips),
      games:xs.length, rest_days:Number.isFinite(last)?Math.max(0,(Date.parse(game.start_time)-last)/86400000-1):null };
  };
  const paired = history.filter(e => !e.neutral);
  // Paired log-efficiency difference; shrunk toward no venue effect. Not opponent-adjusted or validated yet.
  const advantage = sum(paired.map(e => Math.log(Math.max(1,e.home_pts)/Math.max(1,e.away_pts))))/(paired.length+50)/2;
  const paceSD = Math.sqrt(mean(samples.map(x => (x.pace-pace)**2)));
  return {away:profile(game.away.team_id),home:profile(game.home.team_id),league_efficiency:league,pace_sd:paceSD,home_log_advantage:advantage,neutral:game.neutral_site===true,training_games:history.length};
}

export function fitCurrentRoles(players: RatePlayer[], events: CompletedEvent[], season: number): void {
  for (const p of players) {
    const teamEvents = events.filter(e => e.season===season && [e.home_team_id,e.away_team_id].includes(p.team_id));
    const current = teamEvents.flatMap(e => e.players.filter(r=>r.athlete_id===p.athlete_id).map(r=>({r,date:e.start_time})) ).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    const prior = events.filter(e=>e.season===season-1).flatMap(e=>e.players.filter(r=>r.athlete_id===p.athlete_id));
    const priorMean = prior.length ? mean(prior.map(r=>r.minutes)) : p.minutes_mean;
    const recent = current.slice(0,10);
    const weights = recent.map((_,i)=>2**(-i/5));
    p.minutes_mean = (sum(recent.map((x,i)=>x.r.minutes*weights[i]))+ROLE_PRIOR_GAMES*priorMean)/(sum(weights)+ROLE_PRIOR_GAMES);
    p.team_games = teamEvents.length;
    p.current_team_games = current.length;
    const priorTeam = events.filter(e=>e.season===season-1 && [e.home_team_id,e.away_team_id].includes(p.team_id));
    const priorAppearances = priorTeam.filter(e=>e.players.some(r=>r.athlete_id===p.athlete_id)).length;
    // Participation prior uses measured appearances where available; otherwise a weak cameo prior.
    const priorPlay = priorTeam.length && priorAppearances ? priorAppearances/priorTeam.length : 0.2;
    let play = teamEvents.length ? (current.length+2*priorPlay)/(teamEvents.length+2) : priorPlay;
    if (current.length===teamEvents.length && current.length>=2) play=1;
    // Availability scenario priors; these are deliberately not labelled calibrated probabilities.
    const status = p.injury_status;
    if (p.minutes_weight===0) play=0;
    else if (status==='doubtful') play*=0.1;
    else if (status==='probable') play*=0.9;
    else if (p.questionable_widen) play*=0.5;
    p.play_probability=play;
    p.minutes_source = `recent regular-season appearances (${current.length}/${teamEvents.length}); ${ROLE_PRIOR_GAMES}-game prior`;
  }
}
