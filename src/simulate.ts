import { shownPercent, typicalityBucket, winCounts, type TypicalityBucket, type WinCounts } from './display.ts';
import type { RateGame, RatePlayer } from './types.ts';
import { binomial, gamma, gammaMean1, iterationSeed, mulberry32, normal, poisson, type Rng } from './rng.ts';

export const ITERATIONS = 10000;
export const OT_PROBABILITY = 4 / 104;
export const REGULATION_MINUTES = 240;
export const OT_MINUTES = 265;
export const DIRICHLET_KAPPA = 80;
export const QUESTIONABLE_SIGMA = 0.35;
export const TEAM_SHOCK_SIGMA = 0.06;
export const PHI_FGA = 10;
export const PHI_FTA = 8;
export const PHI_REB = 8;
export const PHI_AST = 8;

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

export interface Simulation {
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

function zeroLine(player: RatePlayer): DrawnPlayer {
  return {
    athlete_id: player.athlete_id,
    name: player.name,
    team_id: player.team_id,
    injury_status: player.injury_status,
    minutes_weight: 0,
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

function sumKey(players: DrawnPlayer[], key: (typeof COUNT_KEYS)[number]): number {
  return players.reduce((sum, player) => sum + player[key], 0);
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
  if (activeCount === 0 && sumKey(players, 'pts') !== 0) throw new Error('empty rotation drew points');
}

function validateDraw(draw: Draw): void {
  if (draw.budget !== (draw.overtime ? OT_MINUTES : REGULATION_MINUTES)) {
    throw new Error('overtime budget does not match the draw');
  }
  validateTeam(draw.away, draw.budget);
  validateTeam(draw.home, draw.budget);
}

export function drawGame(game: RateGame, rng: Rng): Draw {
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

  const index = percentileDrawIndex(combinedTotals, 0.95);
  const chosen = drawGame(game, mulberry32(iterationSeed(seed, index)));
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
