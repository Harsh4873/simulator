import type { OutcomeRow, PositionGroup, RatePlayer, ShootingRow } from './types.ts';

export const SEASON_WEIGHT_2027 = 1;
export const K_GAMES = 10;
export const K_MINUTES = 200;
export const K_FGA_SHARE = 80;
export const K_FG2 = 60;
export const K_TP = 40;
export const K_FT = 30;
export const POSITION_TEAM_WEIGHT = 0.75;

const OUT_STATUSES = new Set(['out', 'injured reserve', 'suspension', 'suspended', 'inactive', 'out for season']);

export interface Exposure {
  s: number;
  e: number;
}

export interface RosterPlayer {
  athlete_id: string;
  name: string;
  team_id: string;
  position: string;
  headshot_url?: string;
}

export interface InjuryInput {
  athlete_id?: string;
  name?: string;
  status: string;
  reported_at?: string | null;
  minutes_restriction?: number | null;
}

export interface FitInput {
  roster: RosterPlayer[];
  injuries: InjuryInput[];
  outcomes: OutcomeRow[];
  shooting: ShootingRow[];
  activeSeason?: number;
  skillModel?:import("./shooting-priors.ts").ShootingPriorFit;
}

export interface FitResult {
  players: RatePlayer[];
  publish: boolean;
}

interface Pool {
  league: Exposure;
  team: Map<string, Exposure>;
  position: Map<string, Exposure>;
  player: Map<string, Exposure>;
}

export function positionGroup(position: string): PositionGroup {
  const value = position.trim().toUpperCase();
  if (value === 'PG' || value === 'SG' || value === 'G') return 'Guard';
  if (value === 'SF' || value === 'PF' || value === 'F') return 'Forward';
  if (value === 'C' || value === 'FC') return 'Center';
  return '';
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function assignInjury(status: string): {
  injury_status: string;
  minutes_weight: 0 | 1;
  questionable_widen: boolean;
} {
  const alias:Record<string,string>={'day to day':'day-to-day','game time decision':'questionable','gtd':'questionable','available':'healthy','active':'healthy','cleared':'healthy','out for the season':'out for season'};
  const raw=status.trim().toLowerCase();
  const trimmed=alias[raw]??raw;
  if (!trimmed) {
    return { injury_status: 'healthy', minutes_weight: 1, questionable_widen: false };
  }
  if (OUT_STATUSES.has(trimmed)) {
    return { injury_status: trimmed, minutes_weight: 0, questionable_widen: false };
  }
  if (['questionable', 'day-to-day', 'gtd', 'doubtful', 'unknown'].includes(trimmed)) {
    return { injury_status: trimmed, minutes_weight: 1, questionable_widen: true };
  }
  return { injury_status: trimmed, minutes_weight: 1, questionable_widen: false };
}

export function isThinSample(games2026: number, games2027: number): boolean {
  return games2026 === 0 && games2027 < 8;
}

export function hasFreeThrowAttempts(rows: { fta: number }[]): boolean {
  return rows.some((row) => row.fta > 0);
}

export function seasonWeight(season: number, activeSeason = 2027): number {
  if (season === activeSeason-1) return 0.2;
  if (season === activeSeason) return SEASON_WEIGHT_2027;
  return 0;
}

export function shrinkRate(input: {
  k: number;
  league: Exposure;
  team: Exposure;
  position: Exposure | null;
  player: Exposure;
  blendPosition: boolean;
}): number | null {
  if (!(input.league.e > 0)) return null;
  const leagueRate = input.league.s / input.league.e;
  const teamRate = (input.team.s + input.k * leagueRate) / (input.team.e + input.k);
  let target = teamRate;
  if (input.blendPosition && input.position) {
    const positionRate = (input.position.s + input.k * leagueRate) / (input.position.e + input.k);
    target = POSITION_TEAM_WEIGHT * teamRate + (1 - POSITION_TEAM_WEIGHT) * positionRate;
  }
  return (input.player.s + input.k * target) / (input.player.e + input.k);
}

function emptyPool(): Pool {
  return {
    league: { s: 0, e: 0 },
    team: new Map(),
    position: new Map(),
    player: new Map(),
  };
}

function bump(map: Map<string, Exposure>, key: string, s: number, e: number): void {
  const current = map.get(key) ?? { s: 0, e: 0 };
  current.s += s;
  current.e += e;
  map.set(key, current);
}

function add(pool: Pool, athleteId: string, teamId: string, group: PositionGroup, s: number, e: number): void {
  if (!(e > 0) || !Number.isFinite(s) || !Number.isFinite(e)) return;
  pool.league.s += s;
  pool.league.e += e;
  if (teamId) bump(pool.team, teamId, s, e);
  if (group) bump(pool.position, group, s, e);
  if (athleteId) bump(pool.player, athleteId, s, e);
}

function exposureOf(map: Map<string, Exposure>, key: string): Exposure {
  return map.get(key) ?? { s: 0, e: 0 };
}

function resolveInjury(player: RosterPlayer, injuries: InjuryInput[]): string {
  const byId = injuries.find((item) => item.athlete_id && item.athlete_id === player.athlete_id);
  if (byId) return byId.status;
  const key = normalizeName(player.name);
  if (!key) return '';
  const byName = injuries.find((item) => !item.athlete_id && item.name && normalizeName(item.name) === key);
  return byName?.status ?? '';
}

function clampPerMinute(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(1.5, Math.max(0, value));
}

function clampProbability(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function minutesMean(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

export function pointsLogPerMinute(outcomes: readonly OutcomeRow[], athleteId: string): number | null {
  let weightedPoints = 0;
  let weightedMinutes = 0;
  for (const row of outcomes) {
    if (row.athlete_id !== athleteId || row.stat_key !== 'points' || !(row.minutes > 0)) continue;
    const weight = seasonWeight(row.season);
    if (weight === 0) continue;
    weightedPoints += weight * row.actual;
    weightedMinutes += weight * row.minutes;
  }
  if (!(weightedMinutes > 0)) return null;
  return weightedPoints / weightedMinutes;
}

export function priorPointsPerMinute(rates: {
  fga_per_min: number;
  fta_per_min: number;
  tpa_given_fga: number;
  fg2_pct: number;
  tp_pct: number;
  ft_pct: number;
}): number {
  const pointsPerFga =
    rates.tpa_given_fga * rates.tp_pct * 3 + (1 - rates.tpa_given_fga) * rates.fg2_pct * 2;
  return rates.fga_per_min * pointsPerFga + rates.fta_per_min * rates.ft_pct;
}

export function fitPlayers(input: FitInput): FitResult {
  const rosterById = new Map<string, RosterPlayer>();
  for (const player of input.roster) {
    if (!rosterById.has(player.athlete_id)) rosterById.set(player.athlete_id, player);
  }
  const groupFor = (athleteId: string): PositionGroup => {
    const player = rosterById.get(athleteId);
    return player ? positionGroup(player.position) : '';
  };

  const minutes = emptyPool();
  const fga = emptyPool();
  const fta = emptyPool();
  const tpaShare = emptyPool();
  const fg2 = emptyPool();
  const tp = emptyPool();
  const ft = emptyPool();
  const reb = emptyPool();
  const ast = emptyPool();
  const stl = emptyPool();
  const blk = emptyPool();
  const tov = emptyPool();
  const games2026 = new Map<string, number>();
  const games2027 = new Map<string, number>();
  const shootingGames = new Map<string, number>();

  for (const row of input.outcomes) {
    const weight = seasonWeight(row.season,input.activeSeason??2027);
    if (weight === 0 || !(row.minutes > 0) || !row.athlete_id) continue;
    const group = groupFor(row.athlete_id);
    if (row.stat_key === 'points') {
      add(minutes, row.athlete_id, row.team_id, group, weight * row.minutes, weight);
      const bucket = row.season === (input.activeSeason??2027) ? games2027 : games2026;
      bucket.set(row.athlete_id, (bucket.get(row.athlete_id) ?? 0) + 1);
    } else if (row.stat_key === 'totalRebounds') {
      add(reb, row.athlete_id, row.team_id, group, weight * row.actual, weight * row.minutes);
    } else if (['steals','blocks','turnovers'].includes(row.stat_key)) {
      const pool = row.stat_key === 'steals' ? stl : row.stat_key === 'blocks' ? blk : tov;
      add(pool,row.athlete_id,row.team_id,group,weight*row.actual,weight*row.minutes);
    } else if (row.stat_key === 'assists') {
      add(ast, row.athlete_id, row.team_id, group, weight * row.actual, weight * row.minutes);
    }
  }

  for (const row of input.shooting) {
    const weight = seasonWeight(row.season,input.activeSeason??2027);
    if (weight === 0 || !row.athlete_id) continue;
    shootingGames.set(row.athlete_id, (shootingGames.get(row.athlete_id) ?? 0) + row.games);
    const group = groupFor(row.athlete_id);
    add(fga, row.athlete_id, row.team_id, group, weight * row.fga, weight * row.minutes);
    add(fta, row.athlete_id, row.team_id, group, weight * row.fta, weight * row.minutes);
    add(tpaShare, row.athlete_id, row.team_id, group, weight * row.tpa, weight * row.fga);
    add(fg2, row.athlete_id, row.team_id, group, weight * (row.fgm - row.tpm), weight * (row.fga - row.tpa));
    add(tp, row.athlete_id, row.team_id, group, weight * row.tpm, weight * row.tpa);
    add(ft, row.athlete_id, row.team_id, group, weight * row.ftm, weight * row.fta);
  }

  const publish = ft.league.e > 0 && fg2.league.e > 0 && tp.league.e > 0 && tpaShare.league.e > 0;

  const rate = (pool: Pool, k: number, athleteId: string, teamId: string, group: PositionGroup): number | null =>
    shrinkRate({
      k,
      league: pool.league,
      team: exposureOf(pool.team, teamId),
      position: group ? exposureOf(pool.position, group) : null,
      player: exposureOf(pool.player, athleteId),
      blendPosition: group !== '',
    });

  const seen = new Set<string>();
  const players: RatePlayer[] = [];
  for (const player of input.roster) {
    const key = `${player.athlete_id}|${player.team_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = positionGroup(player.position);
    const priorGames2026 = games2026.get(player.athlete_id) ?? 0;
    const priorGames2027 = games2027.get(player.athlete_id) ?? 0;
    const injury = assignInjury(resolveInjury(player, input.injuries));
    const shootingCount = shootingGames.get(player.athlete_id) ?? 0;
    const gameCount = priorGames2026 + priorGames2027;
    let fgaPerMin = clampPerMinute(rate(fga, K_MINUTES, player.athlete_id, player.team_id, group));
    let ftaPerMin = clampPerMinute(rate(fta, K_MINUTES, player.athlete_id, player.team_id, group));
    const shootingPosterior:Partial<Record<'share'|'fg2'|'tp'|'ft',[number,number]>>={};
    let tpaGivenFga = clampProbability(rate(tpaShare, K_FGA_SHARE, player.athlete_id, player.team_id, group));
    let fg2Pct = clampProbability(rate(fg2, K_FG2, player.athlete_id, player.team_id, group));
    let tpPct = clampProbability(rate(tp, K_TP, player.athlete_id, player.team_id, group));
    let ftPct = clampProbability(rate(ft, K_FT, player.athlete_id, player.team_id, group));
    const skill=input.skillModel,role=skill?.roles[player.athlete_id]??'unknown';
    if(skill?.source==='chronological-selection'){
      const predict=(key:'share'|'fg2'|'tp'|'ft',pool:Pool,current:number)=>{if(skill.accepted?.[key]===false)return current;const prior=skill.player_rates[player.athlete_id]?.[key]??skill.rates[role]?.[key],own=exposureOf(pool.player,player.athlete_id),k=skill.strengths[key];if(prior===undefined)return current;shootingPosterior[key]=[own.s+k*prior,own.e-own.s+k*(1-prior)];return (own.s+k*prior)/(own.e+k);};
      tpaGivenFga=predict('share',tpaShare,tpaGivenFga);fg2Pct=predict('fg2',fg2,fg2Pct);tpPct=predict('tp',tp,tpPct);ftPct=predict('ft',ft,ftPct);
    }
    // Continuous count evidence: valid zeros contribute, and one shooting game does not erase it.
    const logs=input.outcomes.filter(r=>r.athlete_id===player.athlete_id&&r.stat_key==='points'&&r.minutes>0);
    const logExposure=logs.reduce((n,r)=>n+seasonWeight(r.season,input.activeSeason??2027)*r.minutes,0);
    const logPoints=logs.reduce((n,r)=>n+seasonWeight(r.season,input.activeSeason??2027)*r.actual,0);
    // A measured near-zero three-point profile shrinks with its own attempts, not an abrupt zero-game rule.
    const share=exposureOf(tpaShare.player,player.athlete_id);
    if(share.e>0&&(skill?.source!=='chronological-selection'||skill.accepted?.share===false)){const strength=K_FGA_SHARE/(1+share.e/K_FGA_SHARE);tpaGivenFga=(share.s+strength*tpaGivenFga)/(share.e+strength);}
    const prior=priorPointsPerMinute({fga_per_min:fgaPerMin,fta_per_min:ftaPerMin,tpa_given_fga:tpaGivenFga,fg2_pct:fg2Pct,tp_pct:tpPct,ft_pct:ftPct});
    const shootingExposure=exposureOf(fga.player,player.athlete_id).e;
    const blend=logExposure/(logExposure+shootingExposure+K_MINUTES);
    const target=logExposure>0?(1-blend)*prior+blend*logPoints/logExposure:prior;
    const pointsScale=prior>0?target/prior:1;
    fgaPerMin=clampPerMinute(fgaPerMin*pointsScale);ftaPerMin=clampPerMinute(ftaPerMin*pointsScale);
    const ratePlayer: RatePlayer = {
      active_season: input.activeSeason??2027,
      points_scale: pointsScale,
      skill_prior:skill?{source:skill.source,role,accepted:skill.accepted,strengths:{share:skill.accepted?.share===false?K_FGA_SHARE:skill.strengths.share,fg2:skill.accepted?.fg2===false?K_FG2:skill.strengths.fg2,tp:skill.accepted?.tp===false?K_TP:skill.strengths.tp,ft:skill.accepted?.ft===false?K_FT:skill.strengths.ft},older_history:priorGames2026?'observed':'unknown'}:undefined,
      injury_reported_at: input.injuries.find(x=>x.athlete_id===player.athlete_id)?.reported_at??null,
      minutes_restriction: input.injuries.find(x=>x.athlete_id===player.athlete_id)?.minutes_restriction??null,
      athlete_id: player.athlete_id,
      name: player.name,
      team_id: player.team_id,
      position: player.position.trim(),
      position_group: group,
      injury_status: injury.injury_status,
      minutes_weight: injury.minutes_weight,
      questionable_widen: injury.questionable_widen,
      games_2026: priorGames2026,
      games_2027: priorGames2027,
      games: gameCount,
      shooting_games: shootingCount,
      missing_shooting: shootingCount === 0,
      thin_sample: isThinSample(priorGames2026, priorGames2027),
      minutes_mean: minutesMean(rate(minutes, K_GAMES, player.athlete_id, player.team_id, group)),
      fga_per_min: fgaPerMin,
      fta_per_min: ftaPerMin,
      shooting_posterior:shootingPosterior,
      tpa_given_fga: tpaGivenFga,
      fg2_pct: fg2Pct,
      tp_pct: tpPct,
      ft_pct: ftPct,
      reb_per_min: clampPerMinute(rate(reb, K_MINUTES, player.athlete_id, player.team_id, group)),
      ...(stl.league.e > 0 ? {stl_per_min: clampPerMinute(rate(stl,K_MINUTES,player.athlete_id,player.team_id,group))} : {}),
      ...(blk.league.e > 0 ? {blk_per_min: clampPerMinute(rate(blk,K_MINUTES,player.athlete_id,player.team_id,group))} : {}),
      ...(tov.league.e > 0 ? {tov_per_min: clampPerMinute(rate(tov,K_MINUTES,player.athlete_id,player.team_id,group))} : {}),
      ast_per_min: clampPerMinute(rate(ast, K_MINUTES, player.athlete_id, player.team_id, group)),
    };
    if (typeof player.headshot_url === 'string' && player.headshot_url.trim()) {
      ratePlayer.headshot_url = player.headshot_url;
    }
    players.push(ratePlayer);
  }

  return { players, publish };
}
