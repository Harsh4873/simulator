import { shownPercent, typicalityBucket, winCounts, type TypicalityBucket, type WinCounts } from './display.ts';
import type { RateGame, RatePlayer } from './types.ts';
import { binomial, gamma, gammaMean1, iterationSeed, mulberry32, normal, poisson, type Rng } from './rng.ts';

export const ITERATIONS = 10000;
export const REGULATION_MINUTES = 240;
export const OT_PERIOD_MINUTES = 25;
export const DIRICHLET_KAPPA = 80;
export const QUESTIONABLE_SIGMA = 0.35;
export const TEAM_SHOCK_SIGMA = 0.06;
export const PHI_FGA = 10;
export const PHI_FTA = 8;
export const PHI_REB = 8;
export const PHI_AST = 8;
export const UNOBSERVED_MAX_GAMES = 3;
export const UNOBSERVED_PLAY_PROBABILITY = 0.2;
export const UNOBSERVED_MINUTE_CAP = 12;
export const PLAYER_CAP_REGULATION = 48;
export const PLAYER_CAP_PER_OT = 5;
export const MAX_OT_PERIODS = 8;

export interface PointsBand {
  p05: number;
  p10: number;
  p50: number;
  p90: number;
  p95: number;
}

export interface DrawnPlayer {
  athlete_id: string;
  name: string;
  team_id: string;
  injury_status: string;
  minutes_weight: 0 | 1;
  thin_sample: boolean;
  games: number;
  shooting_games: number;
  min: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  pts: number;
  reb: number;
  ast: number;
}

export interface Draw {
  overtime: boolean;
  budget: number;
  away: DrawnPlayer[];
  home: DrawnPlayer[];
  awayVolumeShock: number;
  homeVolumeShock: number;
}

export interface RevisedDraw extends Draw {
  overtimePeriods: number;
  regulationAwayPts: number;
  regulationHomePts: number;
  missingShootingAthleteIds: string[];
}

export interface MarginalRead {
  percent: number;
  constant: boolean;
  bucket: TypicalityBucket;
}

export interface SimulatedPlayer extends DrawnPlayer {
  band: PointsBand;
  reads: {
    min: MarginalRead;
    tpm: MarginalRead;
    pts: MarginalRead;
    reb: MarginalRead;
    ast: MarginalRead;
  };
}

export interface SimulatedTeam {
  team_id: string;
  pts: number;
  band: PointsBand;
  volumeShock: number;
  pointsRead: MarginalRead;
  players: SimulatedPlayer[];
}

export interface ScenarioView {
  overtime: boolean;
  budget: number;
  overtimePeriods: number;
  regulationAwayPts: number;
  regulationHomePts: number;
  away: SimulatedTeam;
  home: SimulatedTeam;
}

export interface Simulation {
  overtime: boolean;
  budget: number;
  index: number;
  upsideIndex: number;
  overtimePeriods: number;
  regulationAwayPts: number;
  regulationHomePts: number;
  missingShootingAthleteIds: string[];
  combinedTotals: number[];
  wins: WinCounts;
  away: SimulatedTeam;
  home: SimulatedTeam;
  upside: ScenarioView;
}

const COUNT_KEYS = ['min', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'pts', 'reb', 'ast'] as const;

interface SquadState {
  lines: DrawnPlayer[];
  volumeShock: number;
}

function byAthleteId(a: { athlete_id: string }, b: { athlete_id: string }): number {
  if (a.athlete_id < b.athlete_id) return -1;
  if (a.athlete_id > b.athlete_id) return 1;
  return 0;
}

export function isUnobservedProfile(player: {
  minutes_weight: number;
  shooting_games: number;
  games: number;
}): boolean {
  return player.minutes_weight !== 0 && player.shooting_games === 0 && player.games < UNOBSERVED_MAX_GAMES;
}

export function quantile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  const index = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sortedAsc[index];
}

export function percentileDrawIndex(combined: number[], percentile = 0.95): number {
  if (combined.length === 0) return 0;
  const sorted = combined.slice().sort((a, b) => a - b);
  const threshold = quantile(sorted, percentile);
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < combined.length; index += 1) {
    const distance = combined[index] - threshold;
    if (distance < 0 || distance >= bestDistance) continue;
    bestDistance = distance;
    best = index;
  }
  return best;
}

export function closestIndex(combined: number[]): number {
  const sorted = combined.slice().sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < combined.length; i += 1) {
    const distance = Math.abs(combined[i] - median);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

export function shownDrawIndex(baseSeed: number, iterations: number): number {
  return iterationSeed(baseSeed >>> 0, iterations) % iterations;
}

export function largestRemainder(rows: { athlete_id: string; raw: number }[], budget: number): number[] {
  const floors = rows.map((row) => Math.floor(Math.max(0, row.raw)));
  let leftover = budget - floors.reduce((sum, value) => sum + value, 0);
  const order = rows.map((row, index) => ({
    index,
    athlete_id: row.athlete_id,
    fraction: Math.max(0, row.raw) - Math.floor(Math.max(0, row.raw)),
  }));
  order.sort((a, b) => {
    if (a.fraction !== b.fraction) return b.fraction - a.fraction;
    return byAthleteId(a, b);
  });
  if (leftover < 0) throw new Error('largest remainder exceeded the minute budget');
  let cursor = 0;
  while (leftover > 0) {
    floors[order[cursor % order.length].index] += 1;
    leftover -= 1;
    cursor += 1;
  }
  return floors;
}

function restedLine(player: RatePlayer): DrawnPlayer {
  return {
    athlete_id: player.athlete_id,
    name: player.name,
    team_id: player.team_id,
    injury_status: player.injury_status,
    minutes_weight: player.minutes_weight,
    thin_sample: player.thin_sample,
    games: player.games,
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

function rawMinutes(players: RatePlayer[], budget: number, rng: Rng): number[] {
  if (players.length === 0 || !(budget > 0)) throw new Error('minute cap cannot fill the team budget');
  const meanSum = players.reduce((sum, player) => sum + Math.max(0, player.minutes_mean), 0);
  const scaled =
    meanSum > 0
      ? players.map((player) => (Math.max(0, player.minutes_mean) * budget) / meanSum)
      : players.map(() => budget / players.length);
  const shares = new Array<number>(players.length);
  let shareSum = 0;
  for (let i = 0; i < players.length; i += 1) {
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
  for (let i = 0; i < players.length; i += 1) {
    if (!players[i].questionable_widen) continue;
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
  const raw = shares.map((share) => share * budget);
  let rawSum = 0;
  for (const value of raw) rawSum += value;
  if (!(rawSum > 0)) return players.map(() => budget / players.length);
  return raw.map((value) => (value * budget) / rawSum);
}

function cappedMinutes(rows: { athlete_id: string; raw: number; cap: number }[], budget: number): number[] {
  const capSum = rows.reduce((sum, row) => sum + row.cap, 0);
  if (capSum < budget) throw new Error('minute cap cannot fill the team budget');
  const minutes = largestRemainder(
    rows.map((row) => ({ athlete_id: row.athlete_id, raw: row.raw })),
    budget,
  );
  let excess = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (minutes[i] > rows[i].cap) {
      excess += minutes[i] - rows[i].cap;
      minutes[i] = rows[i].cap;
    }
  }
  if (excess === 0) return minutes;
  const order = rows.map((row, index) => ({
    index,
    athlete_id: row.athlete_id,
    fraction: Math.max(0, row.raw) - Math.floor(Math.max(0, row.raw)),
  }));
  order.sort((a, b) => {
    if (a.fraction !== b.fraction) return b.fraction - a.fraction;
    return byAthleteId(a, b);
  });
  let cursor = 0;
  let guard = 0;
  const guardLimit = order.length * (excess + rows.length + 1);
  while (excess > 0) {
    if (guard > guardLimit) throw new Error('minute cap cannot fill the team budget');
    const target = order[cursor % order.length];
    if (minutes[target.index] < rows[target.index].cap) {
      minutes[target.index] += 1;
      excess -= 1;
    }
    cursor += 1;
    guard += 1;
  }
  return minutes;
}

interface CountingStats {
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  pts: number;
  reb: number;
  ast: number;
}

function drawStats(player: RatePlayer, min: number, shock: number, rng: Rng): CountingStats {
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
  return { fgm, fga, tpm, tpa, ftm, fta, pts, reb, ast };
}

function addStats(line: DrawnPlayer, stats: CountingStats, minutes: number): void {
  line.min += minutes;
  line.fgm += stats.fgm;
  line.fga += stats.fga;
  line.tpm += stats.tpm;
  line.tpa += stats.tpa;
  line.ftm += stats.ftm;
  line.fta += stats.fta;
  line.pts += stats.pts;
  line.reb += stats.reb;
  line.ast += stats.ast;
}

function teamPoints(players: DrawnPlayer[]): number {
  return players.reduce((sum, player) => sum + player.pts, 0);
}

function playingRoster(roster: RatePlayer[], playingIds: Set<string>): RatePlayer[] {
  return roster.filter((player) => playingIds.has(player.athlete_id)).sort(byAthleteId);
}

function allocate(players: RatePlayer[], caps: number[], budget: number, rng: Rng): number[] {
  const raw = rawMinutes(players, budget, rng);
  return cappedMinutes(
    players.map((player, index) => ({ athlete_id: player.athlete_id, raw: raw[index] ?? 0, cap: caps[index] ?? 0 })),
    budget,
  );
}

function drawSquad(roster: RatePlayer[], playingIds: Set<string>, rng: Rng): SquadState {
  const z = normal(rng);
  // Mean-1 lognormal shock shared by the team's volume rates.
  const shock = Math.exp(TEAM_SHOCK_SIGMA * z - (TEAM_SHOCK_SIGMA ** 2) / 2);
  const playing = playingRoster(roster, playingIds);
  const caps = playing.map((player) => (isUnobservedProfile(player) ? UNOBSERVED_MINUTE_CAP : PLAYER_CAP_REGULATION));
  const minutes = allocate(playing, caps, REGULATION_MINUTES, rng);
  const lines: DrawnPlayer[] = [];
  for (let i = 0; i < playing.length; i += 1) {
    const player = playing[i];
    const stats = drawStats(player, minutes[i] ?? 0, shock, rng);
    lines.push({
      ...restedLine(player),
      minutes_weight: 1,
      min: minutes[i] ?? 0,
      ...stats,
    });
  }
  const playingSet = new Set(playing.map((player) => player.athlete_id));
  const rested = roster.filter((player) => !playingSet.has(player.athlete_id)).sort(byAthleteId);
  for (const player of rested) lines.push(restedLine(player));
  return { lines, volumeShock: shock };
}

function extendSquad(state: SquadState, roster: RatePlayer[], playingIds: Set<string>, periods: number, rng: Rng): void {
  const playing = playingRoster(roster, playingIds);
  const byId = new Map(state.lines.map((line) => [line.athlete_id, line]));
  const caps = playing.map((player) => {
    const current = byId.get(player.athlete_id)?.min ?? 0;
    if (isUnobservedProfile(player)) return Math.max(0, UNOBSERVED_MINUTE_CAP - current);
    return Math.max(0, PLAYER_CAP_REGULATION + PLAYER_CAP_PER_OT * periods - current);
  });
  const extra = allocate(playing, caps, OT_PERIOD_MINUTES, rng);
  for (let i = 0; i < playing.length; i += 1) {
    const line = byId.get(playing[i].athlete_id);
    if (!line) throw new Error('minute cap cannot fill the team budget');
    const minutes = extra[i] ?? 0;
    addStats(line, drawStats(playing[i], minutes, state.volumeShock, rng), minutes);
  }
}

function playerCap(player: DrawnPlayer, overtimePeriods: number): number {
  if (isUnobservedProfile(player)) return UNOBSERVED_MINUTE_CAP;
  return PLAYER_CAP_REGULATION + PLAYER_CAP_PER_OT * overtimePeriods;
}

function validateTeam(players: DrawnPlayer[], budget: number, overtimePeriods: number): void {
  let minutes = 0;
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
    if (player.min > playerCap(player, overtimePeriods)) throw new Error('player minutes exceed the cap');
    if (player.minutes_weight === 0) {
      for (const key of COUNT_KEYS) {
        if (player[key] !== 0) throw new Error('an out player drew a counting stat');
      }
    }
    minutes += player.min;
  }
  if (minutes !== budget) throw new Error('minutes do not sum to the budget');
}

function validateDraw(draw: RevisedDraw, regulationMinutes: Map<string, number>): void {
  if (draw.overtime !== draw.overtimePeriods > 0) throw new Error('overtime flag does not match the period count');
  if (draw.budget !== REGULATION_MINUTES + OT_PERIOD_MINUTES * draw.overtimePeriods) {
    throw new Error('overtime budget does not match the draw');
  }
  if ((draw.regulationAwayPts === draw.regulationHomePts) !== draw.overtime) {
    throw new Error('overtime does not match the regulation tie');
  }
  if (teamPoints(draw.away) === teamPoints(draw.home)) throw new Error('overtime did not separate the teams');
  for (const line of [...draw.away, ...draw.home]) {
    const regulation = regulationMinutes.get(`${line.team_id}:${line.athlete_id}`) ?? 0;
    const cap = isUnobservedProfile(line) ? UNOBSERVED_MINUTE_CAP : PLAYER_CAP_REGULATION;
    if (regulation > cap) throw new Error('player minutes exceed the cap');
  }
  validateTeam(draw.away, draw.budget, draw.overtimePeriods);
  validateTeam(draw.home, draw.budget, draw.overtimePeriods);
}

function participation(away: RatePlayer[], home: RatePlayer[], rng: Rng): Set<string> {
  const playing = new Set<string>();
  const unobserved = [
    ...away.filter(isUnobservedProfile).sort(byAthleteId),
    ...home.filter(isUnobservedProfile).sort(byAthleteId),
  ];
  for (const player of unobserved) {
    if (rng() < UNOBSERVED_PLAY_PROBABILITY) playing.add(player.athlete_id);
  }
  for (const player of [...away, ...home]) {
    if (player.minutes_weight !== 0 && !isUnobservedProfile(player)) playing.add(player.athlete_id);
  }
  return playing;
}

export function drawGame(game: RateGame, rng: Rng): RevisedDraw {
  const awayRoster = game.players.filter((player) => player.team_id === game.away_team_id);
  const homeRoster = game.players.filter((player) => player.team_id === game.home_team_id);
  const playingIds = participation(awayRoster, homeRoster, rng);
  const away = drawSquad(awayRoster, playingIds, rng);
  const home = drawSquad(homeRoster, playingIds, rng);
  const regulationMinutes = new Map<string, number>();
  for (const line of [...away.lines, ...home.lines]) {
    regulationMinutes.set(`${line.team_id}:${line.athlete_id}`, line.min);
  }
  let awayPts = teamPoints(away.lines);
  let homePts = teamPoints(home.lines);
  const regulationAwayPts = awayPts;
  const regulationHomePts = homePts;
  let overtimePeriods = 0;
  while (awayPts === homePts) {
    if (overtimePeriods >= MAX_OT_PERIODS) throw new Error('overtime did not separate the teams');
    overtimePeriods += 1;
    extendSquad(away, awayRoster, playingIds, overtimePeriods, rng);
    extendSquad(home, homeRoster, playingIds, overtimePeriods, rng);
    awayPts = teamPoints(away.lines);
    homePts = teamPoints(home.lines);
  }
  const missingShootingAthleteIds = game.players
    .filter((player) => player.shooting_games === 0)
    .map((player) => player.athlete_id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const draw: RevisedDraw = {
    overtime: overtimePeriods > 0,
    overtimePeriods,
    budget: REGULATION_MINUTES + OT_PERIOD_MINUTES * overtimePeriods,
    regulationAwayPts,
    regulationHomePts,
    missingShootingAthleteIds,
    away: away.lines,
    home: home.lines,
    awayVolumeShock: away.volumeShock,
    homeVolumeShock: home.volumeShock,
  };
  validateDraw(draw, regulationMinutes);
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

function scenarioFrom(
  draw: RevisedDraw,
  game: RateGame,
  awayTotals: Float64Array,
  homeTotals: Float64Array,
  series: Map<string, ToneSeries>,
): ScenarioView {
  return {
    overtime: draw.overtime,
    budget: draw.budget,
    overtimePeriods: draw.overtimePeriods,
    regulationAwayPts: draw.regulationAwayPts,
    regulationHomePts: draw.regulationHomePts,
    away: shownTeam(game.away_team_id, draw.away, awayTotals, draw.awayVolumeShock, series),
    home: shownTeam(game.home_team_id, draw.home, homeTotals, draw.homeVolumeShock, series),
  };
}

export function simulate(game: RateGame, baseSeed: number, iterations = ITERATIONS): Simulation {
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('iterations must be a positive integer');
  const seed = baseSeed >>> 0;
  const awayTotals = new Float64Array(iterations);
  const homeTotals = new Float64Array(iterations);
  const series = new Map<string, ToneSeries>();
  for (const player of game.players) series.set(player.athlete_id, blankSeries(iterations));
  const combinedTotals = new Array<number>(iterations);

  for (let index = 0; index < iterations; index += 1) {
    const draw = drawGame(game, mulberry32(iterationSeed(seed, index)));
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

  const index = closestIndex(combinedTotals);
  const upsideIndex = percentileDrawIndex(combinedTotals, 0.95);
  const chosen = scenarioFrom(drawGame(game, mulberry32(iterationSeed(seed, index))), game, awayTotals, homeTotals, series);
  const upside = scenarioFrom(
    drawGame(game, mulberry32(iterationSeed(seed, upsideIndex))),
    game,
    awayTotals,
    homeTotals,
    series,
  );
  return {
    overtime: chosen.overtime,
    budget: chosen.budget,
    index,
    upsideIndex,
    overtimePeriods: chosen.overtimePeriods,
    regulationAwayPts: chosen.regulationAwayPts,
    regulationHomePts: chosen.regulationHomePts,
    missingShootingAthleteIds: game.players
      .filter((player) => player.shooting_games === 0)
      .map((player) => player.athlete_id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    combinedTotals,
    wins: winCounts(awayTotals, homeTotals),
    away: chosen.away,
    home: chosen.home,
    upside,
  };
}
