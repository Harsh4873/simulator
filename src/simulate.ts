import { shownPercent, typicalityBucket, winCounts, type TypicalityBucket, type WinCounts } from './display.ts';
import type { RateGame, RatePlayer } from './types.ts';
import { binomial, gammaMean1, iterationSeed, mulberry32, normal, poisson, type Rng } from './rng.ts';

export const ITERATIONS = 10000;
export const REGULATION_MINUTES = 240;
export const OT_PERIOD_MINUTES = 25;
export const DIRICHLET_KAPPA = 80;
export const MINUTES_CONCENTRATION = 320;
export const STARTER_MINUTE_SD = 2;
export const ROTATION_MINUTE_SD = 4;
export const BENCH_MINUTE_SD = 6;
export const PLAY_PRIOR_STRENGTH = 6;
export const CAMEO_MINUTE_CAP = 12;
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
  games_2026: number;
  games_2027: number;
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

export interface PlayerExpectation {
  playRate: number;
  minMean: number;
  ptsMean: number;
  rebMean: number;
  astMean: number;
  praMean: number;
  minP10: number;
  minP90: number;
  ptsP10: number;
  ptsP90: number;
  ptsP95: number;
}

export interface SimulatedPlayer extends DrawnPlayer {
  band: PointsBand;
  expectation?: PlayerExpectation;
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
  awayTotals: number[];
  homeTotals: number[];
  wins: WinCounts;
  forecast?: MarginForecast;
  away: SimulatedTeam;
  home: SimulatedTeam;
  upside: ScenarioView;
  playerDraws: Map<string, ToneSeries>;
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

type AppearancePlayer = Pick<
  RatePlayer,
  'minutes_weight' | 'games_2026' | 'games_2027' | 'minutes_mean' | 'questionable_widen'
>;

export function teamGamesPlayed(roster: readonly Pick<RatePlayer, 'minutes_weight' | 'games_2027'>[]): number {
  let max = 0;
  for (const player of roster) {
    if (player.minutes_weight === 0) continue;
    if (player.games_2027 > max) max = player.games_2027;
  }
  return max;
}

export function isConfirmedStarter(player: AppearancePlayer, teamGames: number): boolean {
  if (player.minutes_weight === 0 || player.questionable_widen) return false;
  if (player.minutes_mean < 24) return false;
  return teamGames >= 1 && player.games_2027 >= teamGames;
}

export function playProbability(player: AppearancePlayer, teamGames: number): number {
  if (player.minutes_weight === 0) return 0;
  if (isConfirmedStarter(player, teamGames)) return 1;
  const games = Math.max(teamGames, player.games_2027);
  let priorMean = 0.12;
  if (player.games_2026 >= 40 || (player.games_2026 >= 20 && player.minutes_mean >= 24)) priorMean = 0.85;
  else if (player.games_2026 >= 10 && player.minutes_mean >= 20) priorMean = 0.35;
  let probability = (player.games_2027 + priorMean * PLAY_PRIOR_STRENGTH) / (games + PLAY_PRIOR_STRENGTH);
  if (!player.questionable_widen && games >= 2 && player.games_2027 >= games) return 1;
  if (player.questionable_widen) probability *= 0.5;
  return Math.min(1, Math.max(0, probability));
}

export function conditionalMinutes(player: AppearancePlayer): number {
  if (player.minutes_weight === 0) return 0;
  if (player.games_2027 === 0 && player.games_2026 < 20) return Math.min(player.minutes_mean, CAMEO_MINUTE_CAP);
  return Math.max(0, player.minutes_mean);
}

function cameo(player: Pick<RatePlayer, 'games_2026' | 'games_2027' | 'minutes_weight' | 'shooting_games'>): boolean {
  return (
    player.minutes_weight !== 0 &&
    player.games_2027 === 0 &&
    player.games_2026 < 20 &&
    player.shooting_games === 0
  );
}

export function quantile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
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

export interface MarginForecast {
  awayMean: number;
  homeMean: number;
  marginMean: number;
  marginMedian: number;
  totalMedian: number;
  awayBy10: number;
  awayBy20: number;
  homeBy10: number;
  homeBy20: number;
}

export function representativeIndex(away: ArrayLike<number>, home: ArrayLike<number>): number {
  const count = away.length;
  if (count === 0) return 0;
  let awaySum = 0;
  let homeSum = 0;
  for (let index = 0; index < count; index += 1) {
    awaySum += away[index];
    homeSum += home[index];
  }
  const awayMean = awaySum / count;
  const homeMean = homeSum / count;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < count; index += 1) {
    const distance = (away[index] - awayMean) ** 2 + (home[index] - homeMean) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

export function marginForecast(away: ArrayLike<number>, home: ArrayLike<number>): MarginForecast {
  const count = away.length;
  const margins: number[] = [];
  const totals: number[] = [];
  let awaySum = 0;
  let homeSum = 0;
  let away10 = 0;
  let away20 = 0;
  let home10 = 0;
  let home20 = 0;
  for (let index = 0; index < count; index += 1) {
    const margin = home[index] - away[index];
    margins.push(margin);
    totals.push(away[index] + home[index]);
    awaySum += away[index];
    homeSum += home[index];
    if (margin <= -10) away10 += 1;
    if (margin <= -20) away20 += 1;
    if (margin >= 10) home10 += 1;
    if (margin >= 20) home20 += 1;
  }
  const sortedMargins = margins.slice().sort((a, b) => a - b);
  const sortedTotals = totals.slice().sort((a, b) => a - b);
  return {
    awayMean: count === 0 ? 0 : awaySum / count,
    homeMean: count === 0 ? 0 : homeSum / count,
    marginMean: count === 0 ? 0 : (homeSum - awaySum) / count,
    marginMedian: count === 0 ? 0 : quantile(sortedMargins, 0.5),
    totalMedian: count === 0 ? 0 : quantile(sortedTotals, 0.5),
    awayBy10: count === 0 ? 0 : away10 / count,
    awayBy20: count === 0 ? 0 : away20 / count,
    homeBy10: count === 0 ? 0 : home10 / count,
    homeBy20: count === 0 ? 0 : home20 / count,
  };
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

function minuteNoise(baseline: number): number {
  if (baseline >= 24) return STARTER_MINUTE_SD;
  if (baseline >= 12) return ROTATION_MINUTE_SD;
  return BENCH_MINUTE_SD;
}

function roleBaselines(baselines: number[], budget: number): number[] {
  const anchor = baselines.map((value) => value >= 24);
  let anchorSum = 0;
  for (let index = 0; index < baselines.length; index += 1) {
    if (anchor[index]) anchorSum += baselines[index];
  }
  if (anchorSum >= budget) {
    return baselines.map((value, index) => (anchor[index] ? (value * budget) / anchorSum : 0));
  }
  let restSum = 0;
  for (let index = 0; index < baselines.length; index += 1) {
    if (!anchor[index]) restSum += baselines[index];
  }
  const restBudget = budget - anchorSum;
  return baselines.map((value, index) => {
    if (anchor[index]) return value;
    if (!(restSum > 0)) return 0;
    return (value * restBudget) / restSum;
  });
}

function rawMinutes(players: RatePlayer[], budget: number, rng: Rng): number[] {
  if (players.length === 0 || !(budget > 0)) throw new Error('minute cap cannot fill the team budget');
  const targets = players.map((player) => conditionalMinutes(player));
  const baseline = roleBaselines(targets, budget);
  const noisy = baseline.map((value, index) => {
    let next = Math.max(0, value + normal(rng) * minuteNoise(value));
    if (players[index].questionable_widen) {
      next *= Math.exp(normal(rng) * QUESTIONABLE_SIGMA - (QUESTIONABLE_SIGMA ** 2) / 2);
    }
    return next;
  });
  let gap = budget - noisy.reduce((sum, value) => sum + value, 0);
  const order = noisy
    .map((_value, index) => ({ index, value: baseline[index] }))
    .sort((a, b) => a.value - b.value || (players[a.index].athlete_id < players[b.index].athlete_id ? -1 : 1));
  for (const item of order) {
    if (Math.abs(gap) < 1e-6) break;
    if (baseline[item.index] >= 24) continue;
    if (gap > 0) {
      noisy[item.index] += gap;
      gap = 0;
    } else {
      const cut = Math.min(noisy[item.index], -gap);
      noisy[item.index] -= cut;
      gap += cut;
    }
  }
  if (Math.abs(gap) > 1e-6) {
    const total = noisy.reduce((sum, value) => sum + value, 0);
    if (total > 0) {
      for (let index = 0; index < noisy.length; index += 1) noisy[index] = (noisy[index] * budget) / total;
    }
  }
  return noisy;
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
  const caps = playing.map((player) => minuteCap(player));
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
    if (minuteCap(player) === UNOBSERVED_MINUTE_CAP) return Math.max(0, UNOBSERVED_MINUTE_CAP - current);
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
  if (cameo(player) || isUnobservedProfile(player)) return UNOBSERVED_MINUTE_CAP;
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
    const cap = minuteCap(line);
    if (regulation > cap) throw new Error('player minutes exceed the cap');
  }
  validateTeam(draw.away, draw.budget, draw.overtimePeriods);
  validateTeam(draw.home, draw.budget, draw.overtimePeriods);
}

function minuteCap(player: Pick<RatePlayer, 'games_2026' | 'games_2027' | 'minutes_weight' | 'shooting_games' | 'games'>): number {
  if (cameo(player) || isUnobservedProfile(player)) return UNOBSERVED_MINUTE_CAP;
  return PLAYER_CAP_REGULATION;
}

function ensureBudget(roster: RatePlayer[], playing: Set<string>, budget: number): void {
  const capSum = () =>
    roster.filter((player) => playing.has(player.athlete_id)).reduce((sum, player) => sum + minuteCap(player), 0);
  if (capSum() >= budget) return;
  const extras = roster
    .filter((player) => player.minutes_weight !== 0 && !playing.has(player.athlete_id))
    .sort((a, b) => conditionalMinutes(b) - conditionalMinutes(a) || (a.athlete_id < b.athlete_id ? -1 : 1));
  for (const player of extras) {
    playing.add(player.athlete_id);
    if (capSum() >= budget) return;
  }
}

function participation(away: RatePlayer[], home: RatePlayer[], rng: Rng): Set<string> {
  const playing = new Set<string>();
  const awayIds = new Set(away.map((player) => player.athlete_id));
  const awayGames = teamGamesPlayed(away);
  const homeGames = teamGamesPlayed(home);
  const ordered = [...away, ...home].sort(byAthleteId);
  for (const player of ordered) {
    const probability = playProbability(player, awayIds.has(player.athlete_id) ? awayGames : homeGames);
    if (probability > 0 && rng() < probability) playing.add(player.athlete_id);
  }
  ensureBudget(away, playing, REGULATION_MINUTES);
  ensureBudget(home, playing, REGULATION_MINUTES);
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

function expectationFrom(series: ToneSeries | undefined): PlayerExpectation {
  const minutes = series ? Array.from(series.min) : [];
  const points = series ? Array.from(series.pts) : [];
  const rebounds = series ? Array.from(series.reb) : [];
  const assists = series ? Array.from(series.ast) : [];
  const count = Math.max(minutes.length, 1);
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
  const played = minutes.filter((value) => value > 0).length;
  const minMean = mean(minutes);
  const ptsMean = mean(points);
  const rebMean = mean(rebounds);
  const astMean = mean(assists);
  const minuteBand = bandFrom(minutes);
  const pointBand = bandFrom(points);
  return {
    playRate: played / count,
    minMean,
    ptsMean,
    rebMean,
    astMean,
    praMean: ptsMean + rebMean + astMean,
    minP10: minuteBand.p10,
    minP90: minuteBand.p90,
    ptsP10: pointBand.p10,
    ptsP90: pointBand.p90,
    ptsP95: pointBand.p95,
  };
}

function withReads(players: DrawnPlayer[], series: Map<string, ToneSeries>): SimulatedPlayer[] {
  return players.map((player) => {
    const stats = series.get(player.athlete_id);
    return {
      ...player,
      band: bandFrom(stats?.pts ?? new Uint16Array()),
      expectation: expectationFrom(stats),
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

  const index = representativeIndex(awayTotals, homeTotals);
  const forecast = marginForecast(awayTotals, homeTotals);
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
    awayTotals: Array.from(awayTotals),
    homeTotals: Array.from(homeTotals),
    wins: winCounts(awayTotals, homeTotals),
    forecast,
    away: chosen.away,
    home: chosen.home,
    upside,
    playerDraws: series,
  };
}
