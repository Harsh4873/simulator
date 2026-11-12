import {fitRotationState,fitFouls} from './game-state-model.ts';
import {fitResidualDiagnostics} from './residual-model.ts';
import {fitUsageEffects} from './usage-effects.ts';
import {scheduleContext} from './schedule-context.ts';
import {historicalStints} from './play-history.ts';
import {fitLineupEffects} from './lineup-effects.ts';
import {fitFreeThrows} from './free-throw-model.ts';
import {fitLeadEffect,runningMargins,type LeadEffectModel} from './lead-effect.ts';
import {fitUsageConcentration,type UsageConcentration} from './usage-concentration.ts';
import {fitReboundCredit,type ReboundCredit} from './rebound-credit.ts';
import {fitParticipation,participationProbability,participationFeatures,ParticipationTracker,calibrateHealthy,applyHealthyCalibration} from './participation-model.ts';
import {fitAvailability,type AvailabilityObservation} from './model-evidence.ts';
import { selectRolePrior } from './role-model.ts';
import { fitTeamEffects, restDays } from './team-effects.ts';
import { chicagoDate } from './date.ts';
import type { CompletedEvent } from './parse-summary.ts';
import type { MatchupContext, RatePlayer, SlateGame, TeamProfile } from './types.ts';

export const MODEL_VERSION = 'possessions-v8';
// Shrinkage strengths are modeling priors, not fitted calibration coefficients.
const TEAM_PRIOR_GAMES = 12;
// Pace settles faster than efficiency; a six-game prior beat twelve on walk-forward total error.
export const PACE_PRIOR_GAMES = 6;
export const PRIOR_SEASON_WEIGHT = 0.2;
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
const fitCache=new WeakMap<CompletedEvent[],{cutoff:string;rotation:ReturnType<typeof fitRotationState>;fouls:ReturnType<typeof fitFouls>;residual:ReturnType<typeof fitResidualDiagnostics>;usage:ReturnType<typeof fitUsageEffects>;effects:ReturnType<typeof fitTeamEffects>;freeThrows:ReturnType<typeof fitFreeThrows>;lineups:ReturnType<typeof fitLineupEffects>;lead:LeadEffectModel;usageShare:UsageConcentration;reboundCredit:ReboundCredit}>();

/** Lead give-back fitted on the same history, with an out-of-sample running rating as the strength control. */
export function fitGameLeadEffect(history:CompletedEvent[]):LeadEffectModel{
  const paces=history.map(e=>(eventPossessions(e,e.home_team_id)+eventPossessions(e,e.away_team_id))/2*48/(48+5*(e.periods-4)));
  const pace=paces.length?mean(paces):100;
  const possessions=sum(history.flatMap(e=>[eventPossessions(e,e.home_team_id),eventPossessions(e,e.away_team_id)]));
  const fgPoints=sum(history.flatMap(e=>e.players.map(p=>2*(p.fgm-p.tpm)+3*p.tpm)));
  // The strength control is out-of-sample: a running points rating that has not seen the game.
  const prior=runningMargins(history);
  return fitLeadEffect(history,e=>prior.get(e.event_id)??null,possessions>0?fgPoints/possessions:0.88,pace/4);
}
export function fitMatchup(events: CompletedEvent[], game: SlateGame, cutoff: string): MatchupContext {
  const history = eligibleEvents(events,cutoff).filter(e => e.players.every(p => p.tov !== undefined && p.orb !== undefined));
  if (!history.length) throw new Error('No completed possession history');
  let cached=fitCache.get(events);
  if(!cached||cached.cutoff!==cutoff){const effects=fitTeamEffects(history,eventPossessions);cached={cutoff,rotation:fitRotationState(history),fouls:fitFouls(history),residual:fitResidualDiagnostics(history,eventPossessions),usage:fitUsageEffects(history),effects,freeThrows:fitFreeThrows(history),lineups:fitLineupEffects(history),lead:fitGameLeadEffect(history),usageShare:fitUsageConcentration(history),reboundCredit:fitReboundCredit(history)};fitCache.set(events,cached);}
  const effects=cached.effects;
  const samples = history.flatMap(e => [e.away_team_id,e.home_team_id].map(team => {
    const rows = e.players.filter(p => p.team_id === team);
    const other = e.players.filter(p => p.team_id !== team);
    const poss = (eventPossessions(e,team) + eventPossessions(e,team === e.home_team_id ? e.away_team_id : e.home_team_id))/2;
    return {e,team,rows,other,poss,pace:poss*48/(48+5*(e.periods-4)),weight:e.season===game.season?1:PRIOR_SEASON_WEIGHT};
  }));
  const possessions = sum(samples.map(x => x.poss*x.weight));
  // The fitted intercept is this season's level; a pooled average would keep last season's scoring environment.
  const pooled = sum(samples.map(x => sum(x.rows.map(p => p.pts))*x.weight))/possessions;
  const league = effects.level !== undefined && Number.isFinite(effects.level) && effects.level > 0 ? effects.level : pooled;
  const pace = sum(samples.map(x => x.pace*x.weight))/sum(samples.map(x => x.weight));
  const leagueTov = sum(samples.map(x => sum(x.rows.map(p => p.tov!))*x.weight))/possessions;
  // Missed final free throws (~0.5 of missed FT attempts) also create live rebound opportunities in drawPossessions.
  const reboundMisses = (rows: typeof samples[number]['rows']) => sum(rows.map(p => (p.fga - p.fgm) + 0.5 * (p.fta - p.ftm)));
  const leagueOrb = sum(samples.map(x => sum(x.rows.map(p => p.orb!))*x.weight))/Math.max(1,sum(samples.map(x => reboundMisses(x.rows)*x.weight)));
  const leagueAst = sum(samples.map(x => sum(x.rows.map(p => p.ast))*x.weight))/sum(samples.map(x => sum(x.rows.map(p => p.fgm))*x.weight));
  const leagueTrips = sum(samples.map(x => sum(x.rows.map(p => p.fta/2))*x.weight))/possessions;
  const profile = (team: string): TeamProfile => {
    const xs = samples.filter(x => x.team===team);
    const n = sum(xs.map(x => x.weight));
    const shrink = (values: number[], prior: number) => (sum(values.map((v,i) => v*xs[i].weight)) + TEAM_PRIOR_GAMES*prior)/(n+TEAM_PRIOR_GAMES);
    const last = xs.map(x=>Date.parse(x.e.start_time)).sort((a,b)=>b-a)[0];
    const pacePrior = (sum(xs.map(x=>x.pace*x.weight)) + PACE_PRIOR_GAMES*pace)/(n+PACE_PRIOR_GAMES);
    return { pace:pacePrior, offense:effects.offense[team]??league,
      defense:effects.defense[team]??league,
      turnover_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.tov!))/x.poss),leagueTov),
      offensive_rebound_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.orb!))/Math.max(1,reboundMisses(x.rows))),leagueOrb),
      assist_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.ast))/Math.max(1,sum(x.rows.map(p=>p.fgm)))),leagueAst),
      ft_trip_rate:shrink(xs.map(x=>sum(x.rows.map(p=>p.fta/2))/x.poss),leagueTrips),
      schedule:scheduleContext(xs.at(-1)?.e??null,game.start_time,game.venue),games:xs.length, rest_days:Number.isFinite(last)?restDays(new Date(last).toISOString(),game.start_time):null };
  };
  const paceSD = Math.sqrt(mean(samples.map(x => (x.pace-pace)**2)));
  return {lead_effect:cached.lead,usage_concentration:cached.usageShare,rebound_credit:cached.reboundCredit,rotation_state:cached.rotation,fouls:cached.fouls,residual_diagnostics:cached.residual,usage_effects:cached.usage,free_throws:cached.freeThrows,lineup_effects:cached.lineups,away:profile(game.away.team_id),home:profile(game.home.team_id),league_efficiency:league,pace_sd:paceSD,home_log_advantage:effects.home,rest_coefficient:effects.rest,workload_coefficient:effects.workload,travel_coefficient:effects.travel,timezone_coefficient:effects.timezone,neutral:game.neutral_site===true,training_games:history.length};
}

/** Minutes in a player's first appearances when no earlier NBA appearance exists in the permitted history. */
export function newcomerMinutes(events: CompletedEvent[], season: number): number {
  const earlier = new Set(events.filter(e => e.season < season).flatMap(e => e.players.filter(p => p.minutes > 0).map(p => p.athlete_id)));
  const seen = new Map<string, number>();
  const minutes: number[] = [];
  for (const e of [...events].filter(e => e.season === season).sort((a, b) => a.start_time.localeCompare(b.start_time))) {
    for (const p of e.players) {
      if (!(p.minutes > 0) || earlier.has(p.athlete_id)) continue;
      const count = seen.get(p.athlete_id) ?? 0;
      if (count < 3) minutes.push(p.minutes);
      seen.set(p.athlete_id, count + 1);
    }
  }
  return minutes.length >= 20 ? mean(minutes) : NEWCOMER_MINUTES_PRIOR;
}
// Labelled prior for a rostered player with no NBA appearance in the permitted history, until 20 newcomer appearances exist.
export const NEWCOMER_MINUTES_PRIOR = 10;

const OUT_DESIGNATIONS=new Set(['out','injured reserve','suspension','suspended','inactive','out for season']);
const K_ORB_REBOUNDS=25;

export function fitCurrentRoles(players: RatePlayer[], events: CompletedEvent[], season: number, availability:AvailabilityObservation[]=[], cutoff:string=new Date().toISOString()): void {
  events=eligibleEvents(events,cutoff);
  const selection=selectRolePrior(events,season);
  const ROLE_PRIOR_GAMES=selection.prior_games;
  const participationFit=fitParticipation(events);
  const tracker=new ParticipationTracker();
  // Score each archived healthy pre-tip row with the tracker state, career role minutes, DNP/absence split and missing team minutes just before that game.
  const archived=new Map<string,AvailabilityObservation[]>();
  const outByEventTeam=new Map<string,number>();
  for(const row of availability){
    if(!row.event_id||!row.team_id)continue;
    if(row.designation==='healthy'){const xs=archived.get(row.event_id)??[];xs.push(row);archived.set(row.event_id,xs);}
    else if(OUT_DESIGNATIONS.has(row.designation)){const k=`${row.event_id}:${row.team_id}`;outByEventTeam.set(k,(outByEventTeam.get(k)??0)+(row.expected_minutes??0));}
  }
  const careerMinutes=new Map<string,{sum:number;w:number}>();
  const calibrationRows:import('./participation-model.ts').HealthyCalibrationRow[]=[];
  for(const e of [...events].sort((a,b)=>a.start_time.localeCompare(b.start_time)||a.event_id.localeCompare(b.event_id))){
    for(const row of archived.get(e.event_id)??[]){
      const history=tracker.history(row.team_id!,row.athlete_id,e.season);
      const p=history?participationProbability(participationFit,participationFeatures(history)):null;
      if(p!==null){
        const cm=careerMinutes.get(row.athlete_id);
        const last5=history!.slice(-5);
        calibrationRows.push({
          tip:e.start_time,
          p,
          y:Number(row.played&&row.minutes>0),
          career_minutes:cm?cm.sum/cm.w:0,
          coach_dnp_last5:last5.length?last5.filter(s=>!s.played&&!s.absent).length/last5.length:0,
          inactive_last5:last5.length?last5.filter(s=>s.absent).length/last5.length:0,
          missing_minutes:outByEventTeam.get(`${e.event_id}:${row.team_id}`)??0,
        });
      }
    }
    tracker.observe(e);
    for(const gp of e.players){
      if(gp.minutes>0){
        const w=e.season===season?1:0.3;
        const cur=careerMinutes.get(gp.athlete_id)??{sum:0,w:0};
        cur.sum+=w*gp.minutes;cur.w+=w;
        careerMinutes.set(gp.athlete_id,cur);
      }
    }
  }
  const healthyCalibration=calibrateHealthy(calibrationRows);
  const newcomer=newcomerMinutes(events,season);
  const closing=events.map(e=>({e,stint:historicalStints(e).stints.filter(s=>s.period===4&&s.end_seconds===0).at(-1)})).filter(x=>x.stint);

  // Fit player offensive-rebound share (orb / reb) shrunk toward position-group and league priors.
  const groupByAthlete=new Map<string,string>();
  for(const p of players)if(p.position_group)groupByAthlete.set(p.athlete_id,p.position_group);
  let leagueOrbSum=0,leagueRebSum=0;
  const posOrb=new Map<string,{orb:number;reb:number}>();
  const ownOrb=new Map<string,{orb:number;reb:number}>();
  for(const e of events){
    const w=e.season===season?1:e.season===season-1?0.5:0;
    if(!(w>0))continue;
    for(const gp of e.players){
      if(gp.orb===undefined||gp.drb===undefined||!(gp.minutes>0))continue;
      const reb=gp.orb+gp.drb;
      leagueOrbSum+=w*gp.orb;leagueRebSum+=w*reb;
      const g=groupByAthlete.get(gp.athlete_id)??'';
      if(g){const pc=posOrb.get(g)??{orb:0,reb:0};pc.orb+=w*gp.orb;pc.reb+=w*reb;posOrb.set(g,pc);}
      const oc=ownOrb.get(gp.athlete_id)??{orb:0,reb:0};oc.orb+=w*gp.orb;oc.reb+=w*reb;ownOrb.set(gp.athlete_id,oc);
    }
  }
  const leagueOrbShare=leagueRebSum>0?leagueOrbSum/leagueRebSum:null;

  // Pre-compute typical_minutes and missing team minutes for tonight's healthy participation context.
  const teamEventsByTeam=new Map<string,CompletedEvent[]>();
  const getTeamEvents=(teamId:string)=>{
    let xs=teamEventsByTeam.get(teamId);
    if(!xs){xs=events.filter(e=>e.season===season&&[e.home_team_id,e.away_team_id].includes(teamId));teamEventsByTeam.set(teamId,xs);}
    return xs;
  };
  for(const p of players){
    const te=getTeamEvents(p.team_id);
    p.typical_minutes=te.length?sum(te.map(e=>e.players.find(r=>r.athlete_id===p.athlete_id&&r.team_id===p.team_id)?.minutes??0))/te.length:null;
  }
  const missingByTeam=new Map<string,number>();
  for(const p of players){
    if(p.minutes_weight===0){
      missingByTeam.set(p.team_id,(missingByTeam.get(p.team_id)??0)+(p.typical_minutes??p.minutes_mean??0));
    }
  }

  for (const p of players) {
    p.active_season=season;p.role_prior_games=ROLE_PRIOR_GAMES;
    const teamEvents = getTeamEvents(p.team_id);
    const current = teamEvents.flatMap(e => e.players.filter(r=>r.athlete_id===p.athlete_id&&r.team_id===p.team_id&&r.minutes>0).map(r=>({r,date:e.start_time})) ).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
    const prior = events.filter(e=>e.season===season-1).flatMap(e=>e.players.filter(r=>r.athlete_id===p.athlete_id&&r.minutes>0));
    const everPlayedOwnOrOlder = prior.length>0 || current.length>0 || events.some(e=>e.season<season-1&&e.players.some(r=>r.athlete_id===p.athlete_id&&r.minutes>0));
    const priorMean = prior.length ? mean(prior.map(r=>r.minutes)) : everPlayedOwnOrOlder ? p.minutes_mean : Math.min(p.minutes_mean,newcomer);
    const recent = current.slice(0,selection.window);
    const weights = recent.map((_,i)=>selection.half_life===null?1:2**(-i/selection.half_life));
    p.minutes_mean = !recent.length ? priorMean : (sum(recent.map((x,i)=>x.r.minutes*weights[i]))+ROLE_PRIOR_GAMES*priorMean)/(sum(weights)+ROLE_PRIOR_GAMES);
    if(leagueOrbShare!==null){
      const pc=p.position_group?posOrb.get(p.position_group):undefined;
      const targetShare=pc&&pc.reb>0?(pc.orb+K_ORB_REBOUNDS*leagueOrbShare)/(pc.reb+K_ORB_REBOUNDS):leagueOrbShare;
      const oc=ownOrb.get(p.athlete_id)??{orb:0,reb:0};
      p.orb_share=Math.min(1,Math.max(0,(oc.orb+K_ORB_REBOUNDS*targetShare)/(oc.reb+K_ORB_REBOUNDS)));
    }
    const starts=current.filter(x=>x.r.starter!==undefined);
    const closings=closing.filter(x=>[x.e.home_team_id,x.e.away_team_id].includes(p.team_id));
    p.closing_rate=closings.length?closings.filter(x=>[...x.stint!.home,...x.stint!.away].includes(p.athlete_id)).length/closings.length:null;
    p.starter_rate=starts.length?starts.filter(x=>x.r.starter).length/starts.length:null;
    p.minutes_residual_sd=selection.residual_sd[p.starter_rate===null?'unknown':p.starter_rate>=.5?'starter':'bench']??null;
    p.team_games = teamEvents.length;
    p.current_team_games = current.length;
    const known=teamEvents.flatMap(e=>{const explicit=(e.participation??[]).filter(r=>r.athlete_id===p.athlete_id&&r.team_id===p.team_id);if(explicit.length)return explicit;const box=e.players.find(r=>r.athlete_id===p.athlete_id&&r.team_id===p.team_id);return box?[{athlete_id:p.athlete_id,team_id:p.team_id,played:true,starter:box.starter??null}]:[];});
    const priorKnown=events.filter(e=>e.season===season-1).flatMap(e=>(e.participation??[]).filter(r=>r.athlete_id===p.athlete_id));
    // Weak Beta(1,1) participation prior where explicit roster/DNP records exist.
    // A positive box establishes participation; absence from a legacy box does not establish a DNP.
    const priorPlay=priorKnown.length?(1+priorKnown.filter(r=>r.played).length)/(2+priorKnown.length):.5;
    let play=known.length?(known.filter(r=>r.played).length+2*priorPlay)/(known.length+2):priorPlay;
    const history=tracker.history(p.team_id,p.athlete_id,season);
    const raw=history?participationProbability(participationFit,participationFeatures(history)):null;
    const cm=careerMinutes.get(p.athlete_id);
    const last5=history?history.slice(-5):[];
    // The calibration describes players listed healthy; uncertain designations are scaled from that baseline below.
    const predicted=raw===null?null:applyHealthyCalibration(healthyCalibration,raw,{
      career_minutes:cm?cm.sum/cm.w:0,
      coach_dnp_last5:last5.length?last5.filter(s=>!s.played&&!s.absent).length/last5.length:0,
      inactive_last5:last5.length?last5.filter(s=>s.absent).length/last5.length:0,
      missing_minutes:missingByTeam.get(p.team_id)??0,
    });
    if(predicted!==null)play=predicted;
    p.participation_coverage={known:known.length,unknown:teamEvents.length-known.length,absent:history?.filter(s=>s.absent).length??0,source:predicted!==null?'team-boxes':known.length?'explicit-DNP':'scenario-prior'};
    p.participation_model={...participationFit,applied:predicted!==null,healthy_calibration:healthyCalibration};
    p.role_context={window:selection.window,half_life:selection.half_life,team_changed:events.some(e=>e.season===season&&e.players.some(r=>r.athlete_id===p.athlete_id&&r.team_id!==p.team_id)),return_from_injury:'unknown'};
    const status = p.injury_status;
    // A designation-level rate never replaces a healthy player's own history; it calibrates uncertain designations only.
    const fittedAvailability=p.minutes_weight!==0&&status!=='healthy'?fitAvailability(availability,status,cutoff):null;
    p.availability_calibration_n=fittedAvailability?.n??0;
    if (p.minutes_weight===0) play=0;
    else if(fittedAvailability)play*=fittedAvailability.probability;
    else if (status==='doubtful') play*=0.1;
    else if (status==='probable') play*=0.9;
    else if (p.questionable_widen) play*=0.5;
    if(fittedAvailability?.minutes_multiplier!=null&&p.injury_status!=='healthy')p.minutes_mean*=fittedAvailability.minutes_multiplier;
    if(p.role_context&&availability.some(r=>r.athlete_id===p.athlete_id&&!r.played&&['out','injured reserve','out for season'].includes(r.designation)&&current.some(c=>Date.parse(c.date)>Date.parse(r.tip))))p.role_context.return_from_injury='observed';
    if(p.minutes_restriction!=null)p.minutes_mean=Math.min(p.minutes_mean,p.minutes_restriction);
    p.play_probability=play;
    p.minutes_source = `recent regular-season appearances (${current.length}/${teamEvents.length}); window ${selection.window}, half-life ${selection.half_life??'none'}; ${ROLE_PRIOR_GAMES}-game prior (${selection.source}, ${selection.samples} validation appearances)`;
  }
}
