import { shownPercent, typicalityBucket, winCounts, type WinCounts } from './display.ts';
import {
  K_FG2,
  K_FGA_SHARE,
  K_FT,
  K_GAMES,
  K_MINUTES,
  K_TP,
  assignInjury,
  isThinSample,
  normalizeName,
  positionGroup,
  seasonWeight,
  shrinkRate,
  type FitInput,
  type FitResult,
  type InjuryInput,
  type RosterPlayer,
} from './fit.ts';
import { binomial, gamma, iterationSeed, mulberry32, normal, type Rng } from './rng.ts';
import {
  DIRICHLET_KAPPA,
  PHI_AST,
  PHI_FGA,
  PHI_FTA,
  PHI_REB,
  QUESTIONABLE_SIGMA,
  REGULATION_MINUTES,
  TEAM_SHOCK_SIGMA,
  largestRemainder,
  percentileDrawIndex,
  quantile,
  type Draw,
  type DrawnPlayer,
  type MarginalRead,
  type PointsBand,
  type SimulatedPlayer,
  type SimulatedTeam,
} from './simulate.ts';
import type { PositionGroup, RateGame, RatePlayer } from './types.ts';

const OT_PROBABILITY = 4 / 104;
const OT_MINUTES = 265;

export interface LegacySimulation {
  overtime: boolean;
  budget: number;
  index: number;
  combinedTotals: number[];
  wins: WinCounts;
  away: SimulatedTeam;
  home: SimulatedTeam;
}

const COUNT_KEYS = ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'pts', 'reb', 'ast'] as const;

function byAthleteId(a: { athlete_id: string }, b: { athlete_id: string }): number {
  if (a.athlete_id < b.athlete_id) return -1;
  if (a.athlete_id > b.athlete_id) return 1;
  return 0;
}

function zeroLine(player: RatePlayer): DrawnPlayer {
  return {
    athlete_id: player.athlete_id,
    name: player.name,
    team_id: player.team_id,
    injury_status: player.injury_status,
    minutes_weight: 0,
    thin_sample: player.thin_sample,
    games: player.games,
    games_2026: player.games_2026,
    games_2027: player.games_2027,
    shooting_games: player.shooting_games,
    min: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
    pts: 0,
    reb: 0,
    ast: 0,
  };
}

function drawTeam(players: RatePlayer[], budget: number, rng: Rng): { lines: DrawnPlayer[]; volumeShock: number } {
  const z = normal(rng);
  // Mean-1 lognormal shock shared by the team's volume rates.
  const shock = Math.exp(TEAM_SHOCK_SIGMA * z - (TEAM_SHOCK_SIGMA ** 2) / 2);
  const active = players.filter((player) => player.minutes_weight !== 0).sort(byAthleteId);
  const inactive = players.filter((player) => player.minutes_weight === 0).sort(byAthleteId);
  if (active.length === 0) return { lines: inactive.map(zeroLine), volumeShock: shock };

  const meanSum = active.reduce((sum, player) => sum + Math.max(0, player.minutes_mean), 0);
  const scaled =
    meanSum > 0
      ? active.map((player) => (Math.max(0, player.minutes_mean) * budget) / meanSum)
      : active.map(() => budget / active.length);
  const shares = new Array<number>(active.length);
  let shareSum = 0;
  for (let i = 0; i < active.length; i += 1) {
    const alpha = (DIRICHLET_KAPPA * scaled[i]) / budget;
    const drawn = alpha > 0 ? gamma(alpha, rng) : 0;
    shares[i] = drawn;
    shareSum += drawn;
  }
  if (!(shareSum > 0)) {
    for (let i = 0; i < shares.length; i += 1) shares[i] = 1 / shares.length;
  } else {
    for (let i = 0; i < shares.length; i += 1) shares[i] /= shareSum;
  }
  for (let i = 0; i < active.length; i += 1) {
    if (!active[i].questionable_widen) continue;
    const noise = normal(rng);
    shares[i] *= Math.exp(noise * QUESTIONABLE_SIGMA - (QUESTIONABLE_SIGMA ** 2) / 2);
  }
  let renorm = 0;
  for (const share of shares) renorm += share;
  if (!(renorm > 0)) {
    for (let i = 0; i < shares.length; i += 1) shares[i] = 1 / shares.length;
  } else {
    for (let i = 0; i < shares.length; i += 1) shares[i] /= renorm;
  }

  const minutes = largestRemainder(
    active.map((player, index) => ({ athlete_id: player.athlete_id, raw: shares[index] * budget })),
    budget,
  );
  const lines: DrawnPlayer[] = [];
  for (let i = 0; i < active.length; i += 1) {
    const player = active[i];
    const min = minutes[i];
    const volume = min * shock;
    const fga = poisson(volume * player.fga_per_min * gammaMean1(PHI_FGA, rng), rng);
    const tpa = binomial(fga, player.tpa_given_fga, rng);
    const tpm = binomial(tpa, player.tp_pct, rng);
    const fg2m = binomial(fga - tpa, player.fg2_pct, rng);
    const fgm = fg2m + tpm;
    const fta = poisson(volume * player.fta_per_min * gammaMean1(PHI_FTA, rng), rng);
    const ftm = binomial(fta, player.ft_pct, rng);
    const pts = 2 * (fgm - tpm) + 3 * tpm + ftm;
    const reb = poisson(volume * player.reb_per_min * gammaMean1(PHI_REB, rng), rng);
    const ast = poisson(volume * player.ast_per_min * gammaMean1(PHI_AST, rng), rng);
    lines.push({
      athlete_id: player.athlete_id,
      name: player.name,
      team_id: player.team_id,
      injury_status: player.injury_status,
      minutes_weight: 1,
      thin_sample: player.thin_sample,
      games: player.games,
      games_2026: player.games_2026,
      games_2027: player.games_2027,
      shooting_games: player.shooting_games,
      min,
      fgm,
      fga,
      tpm,
      tpa,
      ftm,
      fta,
      pts,
      reb,
      ast,
    });
  }
  for (const player of inactive) lines.push(zeroLine(player));
  return { lines, volumeShock: shock };
}

function validateTeam(players: DrawnPlayer[], budget: number): void {
  let activeMinutes = 0;
  let activeCount = 0;
  for (const player of players) {
    for (const key of COUNT_KEYS) {
      if (!Number.isInteger(player[key]) || player[key] < 0) {
        throw new Error('counting stat is not a non-negative integer');
      }
    }
    if (!(player.tpm <= player.tpa && player.tpa <= player.fga)) throw new Error('attempt constraint failed');
    if (player.fgm > player.fga || player.ftm > player.fta || player.tpm > player.fgm) {
      throw new Error('make constraint failed');
    }
    const pts = 2 * (player.fgm - player.tpm) + 3 * player.tpm + player.ftm;
    if (pts !== player.pts) throw new Error('points identity failed');
    if (player.minutes_weight === 0) {
      for (const key of COUNT_KEYS) {
        if (player[key] !== 0) throw new Error('an out player drew a counting stat');
      }
    } else {
      activeCount += 1;
      activeMinutes += player.min;
    }
  }
  if (activeCount > 0 && activeMinutes !== budget) throw new Error('minutes do not sum to the budget');
  if (activeCount === 0 && players.reduce((sum, player) => sum + player.pts, 0) !== 0) {
    throw new Error('empty rotation drew points');
  }
}

function validateDraw(draw: Draw): void {
  if (draw.budget !== (draw.overtime ? OT_MINUTES : REGULATION_MINUTES)) {
    throw new Error('overtime budget does not match the draw');
  }
  validateTeam(draw.away, draw.budget);
  validateTeam(draw.home, draw.budget);
}

export function legacyDrawGame(game: RateGame, rng: Rng): Draw {
  const overtime = rng() < OT_PROBABILITY;
  const budget = overtime ? OT_MINUTES : REGULATION_MINUTES;
  const awayDraw = drawTeam(
    game.players.filter((player) => player.team_id === game.away_team_id),
    budget,
    rng,
  );
  const homeDraw = drawTeam(
    game.players.filter((player) => player.team_id === game.home_team_id),
    budget,
    rng,
  );
  const draw: Draw = {
    overtime,
    budget,
    away: awayDraw.lines,
    home: homeDraw.lines,
    awayVolumeShock: awayDraw.volumeShock,
    homeVolumeShock: homeDraw.volumeShock,
  };
  validateDraw(draw);
  return draw;
}

function bandFrom(values: ArrayLike<number>): PointsBand {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return {
    p05: quantile(sorted, 0.05),
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
  };
}

function teamPoints(players: DrawnPlayer[]): number {
  return players.reduce((sum, player) => sum + player.pts, 0);
}

interface ToneSeries {
  min: Uint16Array;
  tpm: Uint16Array;
  pts: Uint16Array;
  reb: Uint16Array;
  ast: Uint16Array;
}

function blankSeries(iterations: number): ToneSeries {
  return {
    min: new Uint16Array(iterations),
    tpm: new Uint16Array(iterations),
    pts: new Uint16Array(iterations),
    reb: new Uint16Array(iterations),
    ast: new Uint16Array(iterations),
  };
}

function marginalRead(values: ArrayLike<number>, shown: number): MarginalRead {
  const sorted = Array.from(values, (value) => value).sort((a, b) => a - b);
  const constant = sorted.length > 0 && sorted[0] === sorted[sorted.length - 1];
  const percent = shownPercent(sorted, shown);
  return { percent, constant, bucket: typicalityBucket(percent, constant) };
}

function readsFor(series: ToneSeries | undefined, line: DrawnPlayer): SimulatedPlayer['reads'] {
  const empty = new Uint16Array();
  return {
    min: marginalRead(series?.min ?? empty, line.min),
    tpm: marginalRead(series?.tpm ?? empty, line.tpm),
    pts: marginalRead(series?.pts ?? empty, line.pts),
    reb: marginalRead(series?.reb ?? empty, line.reb),
    ast: marginalRead(series?.ast ?? empty, line.ast),
  };
}

function withReads(players: DrawnPlayer[], series: Map<string, ToneSeries>): SimulatedPlayer[] {
  return players.map((player) => {
    const stats = series.get(player.athlete_id);
    return {
      ...player,
      band: bandFrom(stats?.pts ?? new Uint16Array()),
      reads: readsFor(stats, player),
    };
  });
}

function shownTeam(
  teamId: string,
  lines: DrawnPlayer[],
  totals: Float64Array,
  volumeShock: number,
  series: Map<string, ToneSeries>,
): SimulatedTeam {
  const pts = teamPoints(lines);
  return {
    team_id: teamId,
    pts,
    band: bandFrom(totals),
    volumeShock,
    pointsRead: marginalRead(totals, pts),
    players: withReads(lines, series),
  };
}

export function legacySimulate(game: RateGame, baseSeed: number, iterations: number): LegacySimulation {
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('iterations must be a positive integer');
  const seed = baseSeed >>> 0;
  const awayTotals = new Float64Array(iterations);
  const homeTotals = new Float64Array(iterations);
  const series = new Map<string, ToneSeries>();
  for (const player of game.players) series.set(player.athlete_id, blankSeries(iterations));
  const combinedTotals = new Array<number>(iterations);

  for (let index = 0; index < iterations; index += 1) {
    const draw = legacyDrawGame(game, mulberry32(iterationSeed(seed, index)));
    const awayPts = teamPoints(draw.away);
    const homePts = teamPoints(draw.home);
    awayTotals[index] = awayPts;
    homeTotals[index] = homePts;
    combinedTotals[index] = awayPts + homePts;
    for (const line of [...draw.away, ...draw.home]) {
      const bucket = series.get(line.athlete_id);
      if (!bucket) continue;
      bucket.min[index] = line.min;
      bucket.tpm[index] = line.tpm;
      bucket.pts[index] = line.pts;
      bucket.reb[index] = line.reb;
      bucket.ast[index] = line.ast;
    }
  }

  const index = percentileDrawIndex(combinedTotals, 0.95);
  const chosen = legacyDrawGame(game, mulberry32(iterationSeed(seed, index)));
  return {
    overtime: chosen.overtime,
    budget: chosen.budget,
    index,
    combinedTotals,
    wins: winCounts(awayTotals, homeTotals),
    away: shownTeam(game.away_team_id, chosen.away, awayTotals, chosen.awayVolumeShock, series),
    home: shownTeam(game.home_team_id, chosen.home, homeTotals, chosen.homeVolumeShock, series),
  };
}

interface Exposure {
  s: number;
  e: number;
}

interface Pool {
  league: Exposure;
  team: Map<string, Exposure>;
  position: Map<string, Exposure>;
  player: Map<string, Exposure>;
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
  const byName = injuries.find((item) => item.name && normalizeName(item.name) === key);
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

export function legacyFitPlayers(input: FitInput): FitResult {
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
  const games2026 = new Map<string, number>();
  const games2027 = new Map<string, number>();
  const shootingGames = new Map<string, number>();

  for (const row of input.outcomes) {
    const weight = seasonWeight(row.season);
    if (weight === 0 || !(row.minutes > 0) || !row.athlete_id) continue;
    const group = groupFor(row.athlete_id);
    if (row.stat_key === 'points') {
      add(minutes, row.athlete_id, row.team_id, group, weight * row.minutes, weight);
      const bucket = row.season === 2027 ? games2027 : games2026;
      bucket.set(row.athlete_id, (bucket.get(row.athlete_id) ?? 0) + 1);
    } else if (row.stat_key === 'totalRebounds') {
      add(reb, row.athlete_id, row.team_id, group, weight * row.actual, weight * row.minutes);
    } else if (row.stat_key === 'assists') {
      add(ast, row.athlete_id, row.team_id, group, weight * row.actual, weight * row.minutes);
    }
  }

  for (const row of input.shooting) {
    const weight = seasonWeight(row.season);
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
    const ratePlayer: RatePlayer = {
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
      games: priorGames2026 + priorGames2027,
      shooting_games: shootingGames.get(player.athlete_id) ?? 0,
      thin_sample: isThinSample(priorGames2026, priorGames2027),
      minutes_mean: minutesMean(rate(minutes, K_GAMES, player.athlete_id, player.team_id, group)),
      fga_per_min: clampPerMinute(rate(fga, K_MINUTES, player.athlete_id, player.team_id, group)),
      fta_per_min: clampPerMinute(rate(fta, K_MINUTES, player.athlete_id, player.team_id, group)),
      tpa_given_fga: clampProbability(rate(tpaShare, K_FGA_SHARE, player.athlete_id, player.team_id, group)),
      fg2_pct: clampProbability(rate(fg2, K_FG2, player.athlete_id, player.team_id, group)),
      tp_pct: clampProbability(rate(tp, K_TP, player.athlete_id, player.team_id, group)),
      ft_pct: clampProbability(rate(ft, K_FT, player.athlete_id, player.team_id, group)),
      reb_per_min: clampPerMinute(rate(reb, K_MINUTES, player.athlete_id, player.team_id, group)),
      ast_per_min: clampPerMinute(rate(ast, K_MINUTES, player.athlete_id, player.team_id, group)),
    };
    if (typeof player.headshot_url === 'string' && player.headshot_url.trim()) {
      ratePlayer.headshot_url = player.headshot_url;
    }
    players.push(ratePlayer);
  }

  return { players, publish };
}

// Preserve the historical audit's random stream, including its obsolete numerical limits.
function gammaMean1(shape: number,rng:Rng):number {
  let sum=0;
  for(let i=0;i<Math.floor(shape);i++){let u=rng();while(u<=0)u=rng();sum+=-Math.log(u)/shape;}
  return sum;
}
function poisson(mean:number,rng:Rng):number {
  if(!Number.isFinite(mean)||mean<=0)return 0;
  const limit=Math.exp(-Math.min(mean,80));let count=0,product=1;
  do{count++;product*=rng();}while(product>limit);
  return count-1;
}
