import { binomial, gamma, mulberry32, normal, poisson, type Rng } from '../rng.ts';
import type { NflBoxGame, NflLine, NflTeamBox } from './boxscore.ts';

/**
 * NFL game and player projections from completed box scores. Team points come from ridge-fitted offense and defense
 * ratings; each draw plays out drives, then splits the team's pass and rush volume, yards and touchdowns among its
 * players by their recent shares. No market line is an input. Every setting the page shows a range for is checked
 * walk-forward on earlier weeks of the season and widened or narrowed to match what happened.
 */

export type NflPosition = 'QB' | 'RB' | 'WR' | 'TE';
export const NFL_STATS = ['pass_yds', 'pass_td', 'int', 'pass_cmp', 'rush_yds', 'car', 'rec', 'rec_yds', 'tgt'] as const;
export type NflStat = (typeof NFL_STATS)[number];

export interface Band {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface PlayerProjection {
  id: string;
  name: string;
  side: 'away' | 'home';
  position: NflPosition;
  status: string | null;
  /** Share of draws the player was active. */
  play: number;
  stats: Partial<Record<NflStat, Band>>;
  /** Chance of a rushing or receiving touchdown, in draws where he played. */
  td: number;
}

export interface GameProjection {
  draws: number;
  away_points: Band;
  home_points: Band;
  /** Home minus away. */
  margin: Band;
  /** Both teams' points. */
  combined: Band;
  home_win: number;
  players: PlayerProjection[];
}

export interface RosterEntry {
  id: string;
  name: string;
  position: string;
  /** Injury-report status for this game, or null when not listed. */
  status: string | null;
}

/** Calibration fitted walk-forward. Identity values leave a projection unchanged. */
export interface NflCalibration {
  /** Lognormal SD of a team's scoring rate in one game. */
  sigma: number;
  /** Win-chance temperature on the logit scale. */
  temperature: number;
  /** Platt map for the anytime-touchdown chance. */
  td: { a: number; b: number };
  /** Range scale around the median, per stat, so 80% of outcomes land inside on earlier weeks. */
  spread: Partial<Record<NflStat | 'margin' | 'combined', number>>;
  /** Mean-bias scale per `position:stat`: what players went on to record over what was projected, shrunk toward 1. */
  bias: Record<string, number>;
}

export const IDENTITY_CALIBRATION: NflCalibration = { sigma: 0.05, temperature: 1, td: { a: 0, b: 1 }, spread: {}, bias: {} };

/** A tight end's scale falls back to a receiver's: the check infers positions from usage and cannot tell them apart. */
export function biasFor(calibration: NflCalibration, position: NflPosition, stat: NflStat): number {
  return calibration.bias[`${position}:${stat}`] ?? (position === 'TE' ? calibration.bias[`WR:${stat}`] : undefined) ?? 1;
}

const LEAGUE = {
  points: 22,
  drives: 10.8,
  passAtt: 33,
  rushAtt: 26,
  tdPointShare: 0.74,
  passTdShare: 0.62,
  intRate: 0.022,
};
const POSITION_PRIOR: Record<NflPosition, { catch: number; ypr: number; tdPerTarget: number; ypc: number; tdPerCarry: number }> = {
  QB: { catch: 0.6, ypr: 8, tdPerTarget: 0.02, ypc: 5.2, tdPerCarry: 0.035 },
  RB: { catch: 0.78, ypr: 7.8, tdPerTarget: 0.03, ypc: 4.3, tdPerCarry: 0.03 },
  WR: { catch: 0.64, ypr: 12.8, tdPerTarget: 0.045, ypc: 6.5, tdPerCarry: 0.02 },
  TE: { catch: 0.72, ypr: 10.8, tdPerTarget: 0.05, ypc: 4, tdPerCarry: 0.02 },
};
/** The share of pass attempts that reach a target; the rest are throwaways, spikes and drops of the snap. */
const TARGETED = 0.93;
const RECENT_GAMES = 8;
const GAME_HALF_LIFE = 4;
const RIDGE = 2;
const RATING_HALF_LIFE_DAYS = 112;
const QUESTIONABLE_PLAYS = 0.75;
const OFFENSIVE_TD_POINTS = 6.95;
const DEFENSIVE_TD_RATE = 0.13;
const SAFETY_RATE = 0.03;
const XP_RATE = 0.95;
const PASS_SCRIPT = -0.33;
const RUSH_SCRIPT = 0.27;

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export interface TeamRatings {
  mu: number;
  home: number;
  off: Map<string, number>;
  def: Map<string, number>;
}

function sideRows(games: readonly NflBoxGame[], asOf: number, halfLifeDays: number): { team: string; opp: string; venue: number; points: number; weight: number }[] {
  const rows: { team: string; opp: string; venue: number; points: number; weight: number }[] = [];
  for (const game of games) {
    const at = Date.parse(game.start_time);
    if (!(at < asOf)) continue;
    const weight = 0.5 ** ((asOf - at) / 86_400_000 / halfLifeDays);
    const venue = game.neutral ? 0 : 0.5;
    rows.push({ team: game.home.abbr, opp: game.away.abbr, venue, points: game.home.points, weight });
    rows.push({ team: game.away.abbr, opp: game.home.abbr, venue: -venue, points: game.away.points, weight });
  }
  return rows;
}

/** Points scored = league level + offense + opponent defense + home edge, by weighted ridge on games before `asOf`. */
export function fitTeamRatings(games: readonly NflBoxGame[], asOf: number, options: { ridge?: number; halfLifeDays?: number } = {}): TeamRatings {
  const ridge = options.ridge ?? RIDGE;
  const rows = sideRows(games, asOf, options.halfLifeDays ?? RATING_HALF_LIFE_DAYS);
  const off = new Map<string, number>();
  const def = new Map<string, number>();
  for (const row of rows) {
    off.set(row.team, 0);
    def.set(row.opp, 0);
  }
  let mu = rows.length ? rows.reduce((sum, row) => sum + row.weight * row.points, 0) / rows.reduce((sum, row) => sum + row.weight, 0) : LEAGUE.points;
  let home = 0;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    let num = 0;
    let den = 0;
    for (const row of rows) {
      num += row.weight * (row.points - off.get(row.team)! - def.get(row.opp)! - home * row.venue);
      den += row.weight;
    }
    mu = den ? num / den : LEAGUE.points;
    num = 0;
    den = 0;
    for (const row of rows) {
      num += row.weight * row.venue * (row.points - mu - off.get(row.team)! - def.get(row.opp)!);
      den += row.weight * row.venue * row.venue;
    }
    home = den ? num / (den + ridge) : 0;
    const offNum = new Map<string, number>();
    const offDen = new Map<string, number>();
    for (const row of rows) {
      offNum.set(row.team, (offNum.get(row.team) ?? 0) + row.weight * (row.points - mu - def.get(row.opp)! - home * row.venue));
      offDen.set(row.team, (offDen.get(row.team) ?? 0) + row.weight);
    }
    for (const team of off.keys()) off.set(team, (offNum.get(team) ?? 0) / ((offDen.get(team) ?? 0) + ridge));
    const defNum = new Map<string, number>();
    const defDen = new Map<string, number>();
    for (const row of rows) {
      defNum.set(row.opp, (defNum.get(row.opp) ?? 0) + row.weight * (row.points - mu - off.get(row.team)! - home * row.venue));
      defDen.set(row.opp, (defDen.get(row.opp) ?? 0) + row.weight);
    }
    for (const team of def.keys()) def.set(team, (defNum.get(team) ?? 0) / ((defDen.get(team) ?? 0) + ridge));
  }
  return { mu, home, off, def };
}

export function expectedPoints(ratings: TeamRatings, team: string, opp: string, venue: number): number {
  return clamp(ratings.mu + (ratings.off.get(team) ?? 0) + (ratings.def.get(opp) ?? 0) + ratings.home * venue, 6, 45);
}

interface Usage {
  id: string;
  name: string;
  games: number;
  lastPlayed: number;
  /** Recency-weighted sums over games he played, with the team's volume in those games. */
  tgt: number;
  rec: number;
  recYds: number;
  recTd: number;
  car: number;
  rushYds: number;
  rushTd: number;
  passAtt: number;
  passInt: number;
  teamPass: number;
  teamRush: number;
  /** Pass attempts in the team's most recent game before the cutoff. */
  lastPassAtt: number;
}

interface TeamUsage {
  passAtt: number;
  rushAtt: number;
  drives: number;
  tdPointShare: number;
  passTdShare: number;
  players: Map<string, Usage>;
  lastGame: number;
}

function teamSide(game: NflBoxGame, abbr: string): NflTeamBox | null {
  return game.home.abbr === abbr ? game.home : game.away.abbr === abbr ? game.away : null;
}

/** A team's recent volume, scoring mix and each player's weighted usage, from its last eight games before `asOf`. */
export function teamUsage(games: readonly NflBoxGame[], abbr: string, asOf: number): TeamUsage {
  const recent = games
    .filter((game) => Date.parse(game.start_time) < asOf && teamSide(game, abbr))
    .sort((a, b) => b.start_time.localeCompare(a.start_time))
    .slice(0, RECENT_GAMES);
  let weightSum = 0;
  let pass = 0;
  let rush = 0;
  let drives = 0;
  let driveWeight = 0;
  let tdPoints = 0;
  let allPoints = 0;
  let passTd = 0;
  let offTd = 0;
  const players = new Map<string, Usage>();
  recent.forEach((game, index) => {
    const side = teamSide(game, abbr)!;
    const weight = 0.5 ** (index / GAME_HALF_LIFE);
    weightSum += weight;
    pass += weight * side.pass_att;
    rush += weight * side.rush_att;
    if (side.drives !== null) {
      drives += weight * side.drives;
      driveWeight += weight;
    }
    const tds = side.players.reduce((sum, line) => sum + line.rush_td + line.rec_td, 0);
    tdPoints += weight * tds * OFFENSIVE_TD_POINTS;
    allPoints += weight * (tds * OFFENSIVE_TD_POINTS + side.fg * 3);
    passTd += weight * side.players.reduce((sum, line) => sum + line.rec_td, 0);
    offTd += weight * tds;
    for (const line of side.players) {
      const usage = players.get(line.id) ?? {
        id: line.id,
        name: line.name,
        games: 0,
        lastPlayed: 0,
        tgt: 0,
        rec: 0,
        recYds: 0,
        recTd: 0,
        car: 0,
        rushYds: 0,
        rushTd: 0,
        passAtt: 0,
        passInt: 0,
        teamPass: 0,
        teamRush: 0,
        lastPassAtt: 0,
      };
      usage.games += 1;
      usage.lastPlayed = Math.max(usage.lastPlayed, Date.parse(game.start_time));
      usage.tgt += weight * line.tgt;
      usage.rec += weight * line.rec;
      usage.recYds += weight * line.rec_yds;
      usage.recTd += weight * line.rec_td;
      usage.car += weight * line.car;
      usage.rushYds += weight * line.rush_yds;
      usage.rushTd += weight * line.rush_td;
      usage.passAtt += weight * line.pass_att;
      usage.passInt += weight * line.int;
      usage.teamPass += weight * side.pass_att;
      usage.teamRush += weight * side.rush_att;
      if (index === 0) usage.lastPassAtt = line.pass_att;
      players.set(line.id, usage);
    }
  });
  const shrink = (value: number, weight: number, prior: number, priorWeight: number) => (value + prior * priorWeight) / (weight + priorWeight);
  return {
    passAtt: shrink(pass, weightSum, LEAGUE.passAtt, 1),
    rushAtt: shrink(rush, weightSum, LEAGUE.rushAtt, 1),
    drives: shrink(drives, driveWeight, LEAGUE.drives, 1),
    tdPointShare: shrink(tdPoints, allPoints / 22, LEAGUE.tdPointShare * 22, 2) / 22,
    passTdShare: shrink(passTd, offTd, LEAGUE.passTdShare, 4),
    players,
    lastGame: recent.length ? Date.parse(recent[0]!.start_time) : 0,
  };
}

/** Position from usage when no roster says otherwise: a passer, a runner, or a receiver. */
export function inferPosition(usage: Usage): NflPosition {
  if (usage.passAtt >= 8 * Math.max(1, usage.games * 0.4)) return 'QB';
  if (usage.car > usage.tgt * 1.2 && usage.car >= 2) return 'RB';
  return 'WR';
}

function normalizePosition(value: string | null | undefined): NflPosition | null {
  const text = (value ?? '').toUpperCase();
  if (text === 'QB') return 'QB';
  if (text === 'RB' || text === 'FB' || text === 'HB') return 'RB';
  if (text === 'WR') return 'WR';
  if (text === 'TE') return 'TE';
  return null;
}

/** Out, doubtful, injured reserve and suspensions sit; questionable plays three draws in four. */
export function playChance(status: string | null): number {
  const text = (status ?? '').toLowerCase();
  if (!text || text === 'active' || text === 'probable') return 1;
  if (text.includes('questionable')) return QUESTIONABLE_PLAYS;
  return 0;
}

interface PlanPlayer {
  id: string;
  name: string;
  position: NflPosition;
  status: string | null;
  play: number;
  targetShare: number;
  catchRate: number;
  ypr: number;
  tdPerRec: number;
  carryShare: number;
  ypc: number;
  tdPerCarry: number;
  intRate: number;
  /** Pass attempts in the team's latest game, and recency-weighted over its last eight. */
  lastPassAtt: number;
  weightedPassAtt: number;
}

interface TeamPlan {
  abbr: string;
  points: number;
  passAtt: number;
  rushAtt: number;
  drives: number;
  tdPointShare: number;
  passTdShare: number;
  players: PlanPlayer[];
}

/**
 * The starter first. Whoever threw most in the team's latest game starts if he has at least half the leader's weighted
 * attempts over the last eight games; otherwise the weighted leader does. A starter back from one missed game is not
 * replaced by his stand-in, and a change that has lasted two games takes over. Anyone listed out is already gone.
 */
export function orderQuarterbacks<T extends { lastPassAtt: number; weightedPassAtt: number; name: string }>(qbs: readonly T[]): T[] {
  const byWeight = [...qbs].sort((a, b) => b.weightedPassAtt - a.weightedPassAtt || a.name.localeCompare(b.name));
  const leader = byWeight[0];
  const latest = [...qbs].sort((a, b) => b.lastPassAtt - a.lastPassAtt || b.weightedPassAtt - a.weightedPassAtt)[0];
  if (!leader || !latest) return byWeight;
  const starter = latest.lastPassAtt > 0 && latest.weightedPassAtt >= 0.5 * leader.weightedPassAtt ? latest : leader;
  return [starter, ...byWeight.filter((qb) => qb !== starter)];
}

/**
 * Who plays and with what share. With a roster, only its listed offensive players are considered; without one (the
 * walk-forward check), anyone who played in the team's last two games is. A share is the player's weighted targets or
 * carries over the team's attempts in games he played, pulled toward a small prior, so a one-game cameo stays small.
 */
export function teamPlan(usage: TeamUsage, abbr: string, points: number, roster: readonly RosterEntry[] | null): TeamPlan {
  const candidates: { usage: Usage | null; entry: RosterEntry | null }[] = [];
  if (roster) {
    for (const entry of roster) {
      if (!normalizePosition(entry.position)) continue;
      candidates.push({ usage: usage.players.get(entry.id) ?? null, entry });
    }
  } else {
    const recentCut = usage.lastGame - 10 * 86_400_000;
    for (const item of usage.players.values()) if (item.lastPlayed >= recentCut) candidates.push({ usage: item, entry: null });
  }
  const players: PlanPlayer[] = [];
  for (const { usage: used, entry } of candidates) {
    const position = normalizePosition(entry?.position) ?? (used ? inferPosition(used) : 'WR');
    const prior = POSITION_PRIOR[position];
    const status = entry?.status ?? null;
    const play = playChance(status);
    if (play <= 0) continue;
    const tgt = used?.tgt ?? 0;
    const rec = used?.rec ?? 0;
    const car = used?.car ?? 0;
    const targetShare = position === 'QB' ? 0 : (tgt + 0.03 * 30) / ((used?.teamPass ?? 0) + 30);
    const carryShare = (car + (position === 'RB' ? 0.06 : position === 'QB' ? 0.05 : 0.005) * 25) / ((used?.teamRush ?? 0) + 25);
    players.push({
      id: used?.id ?? entry!.id,
      name: entry?.name ?? used!.name,
      position,
      status,
      play,
      targetShare,
      catchRate: clamp((rec + prior.catch * 20) / (tgt + 20), 0.3, 0.95),
      ypr: clamp(((used?.recYds ?? 0) + prior.ypr * 15) / (rec + 15), 3, 25),
      tdPerRec: clamp(((used?.recTd ?? 0) + (prior.tdPerTarget / prior.catch) * 40) / (rec + 40), 0, 0.3),
      carryShare,
      ypc: clamp(((used?.rushYds ?? 0) + prior.ypc * 40) / (car + 40), 1, 9),
      tdPerCarry: clamp(((used?.rushTd ?? 0) + prior.tdPerCarry * 50) / (car + 50), 0, 0.2),
      intRate: clamp(((used?.passInt ?? 0) + LEAGUE.intRate * 150) / ((used?.passAtt ?? 0) + 150), 0.005, 0.06),
      lastPassAtt: used?.lastPassAtt ?? 0,
      weightedPassAtt: used?.passAtt ?? 0,
    });
  }
  // Roster depth that has never touched the ball would soak up share it has not earned: keep the top of each group.
  const qbs = orderQuarterbacks(players.filter((player) => player.position === 'QB')).slice(0, 2);
  const rest = players.filter((player) => player.position !== 'QB');
  const runners = [...rest].sort((a, b) => b.carryShare - a.carryShare).slice(0, 4).map((player) => player.id);
  const catchers = [...rest].sort((a, b) => b.targetShare - a.targetShare).slice(0, 9).map((player) => player.id);
  const kept = new Set([...runners, ...catchers]);
  return {
    abbr,
    points,
    passAtt: usage.passAtt,
    rushAtt: usage.rushAtt,
    drives: usage.drives,
    tdPointShare: usage.tdPointShare,
    passTdShare: usage.passTdShare,
    players: [...qbs, ...rest.filter((player) => kept.has(player.id))],
  };
}

interface Tally {
  [stat: string]: Float64Array;
}

function weightedPick(weights: readonly number[], rng: Rng): number {
  let sum = 0;
  for (const weight of weights) sum += weight;
  if (!(sum > 0)) return -1;
  let target = rng() * sum;
  for (let index = 0; index < weights.length; index += 1) {
    target -= weights[index]!;
    if (target < 0) return index;
  }
  return weights.length - 1;
}

/** Splits `n` among weighted slots. */
function multinomial(n: number, weights: readonly number[], rng: Rng): number[] {
  const counts = weights.map(() => 0);
  let remaining = n;
  let mass = weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < weights.length && remaining > 0; index += 1) {
    if (!(mass > 0)) break;
    const share = index === weights.length - 1 ? 1 : Math.min(1, weights[index]! / mass);
    const draw = binomial(remaining, share, rng);
    counts[index] = draw;
    remaining -= draw;
    mass -= weights[index]!;
  }
  return counts;
}

function scoreTeam(plan: TeamPlan, drives: number, rate: number, rng: Rng): { points: number; offTd: number } {
  const expectedTd = (plan.points * plan.tdPointShare) / OFFENSIVE_TD_POINTS;
  const expectedFg = (plan.points * (1 - plan.tdPointShare)) / 3;
  const pTd = clamp((expectedTd / drives) * rate, 0, 0.7);
  const pFg = clamp((expectedFg / Math.max(1, drives - expectedTd)) * rate, 0, 0.6);
  const offTd = binomial(drives, pTd, rng);
  const fg = binomial(drives - offTd, pFg, rng);
  const otherTd = poisson(DEFENSIVE_TD_RATE, rng);
  const tds = offTd + otherTd;
  const points = 6 * tds + binomial(tds, XP_RATE, rng) + 3 * fg + 2 * poisson(SAFETY_RATE, rng);
  return { points, offTd };
}

const PLAYER_STATS = ['pass_att', 'pass_cmp', 'pass_yds', 'pass_td', 'int', 'car', 'rush_yds', 'rush_td', 'tgt', 'rec', 'rec_yds', 'rec_td', 'active'] as const;

function playTeam(plan: TeamPlan, margin: number, expectedMargin: number, rate: number, offTd: number, rng: Rng, tally: Map<string, Tally>, draw: number): void {
  const active = plan.players.map((player) => rng() < player.play);
  const qbs = plan.players.map((player, index) => ({ player, index })).filter((item) => item.player.position === 'QB' && active[item.index]);
  const qb = qbs[0] ?? null;
  const script = margin - expectedMargin;
  const passAtt = Math.max(12, Math.round(plan.passAtt + PASS_SCRIPT * script + normal(rng) * 4.5));
  const rushAtt = Math.max(8, Math.round(plan.rushAtt + RUSH_SCRIPT * script + normal(rng) * 4));
  const efficiency = rate ** 0.35;
  const n = plan.players.length;
  const tgt = new Array<number>(n).fill(0);
  const rec = new Array<number>(n).fill(0);
  const recYds = new Array<number>(n).fill(0);
  const recTd = new Array<number>(n).fill(0);
  const car = new Array<number>(n).fill(0);
  const rushYds = new Array<number>(n).fill(0);
  const rushTd = new Array<number>(n).fill(0);
  const targetWeights = plan.players.map((player, index) => (active[index] && player.position !== 'QB' ? player.targetShare : 0));
  const targets = multinomial(Math.round(passAtt * TARGETED), targetWeights, rng);
  for (let index = 0; index < n; index += 1) {
    const player = plan.players[index]!;
    tgt[index] = targets[index]!;
    rec[index] = binomial(tgt[index]!, player.catchRate, rng);
    if (rec[index]! > 0) recYds[index] = Math.round(gamma(rec[index]! * 1.3, rng) * ((player.ypr * efficiency) / 1.3));
  }
  // Only the starting quarterback carries his share; a backup who is active but not starting does not.
  const carryWeights = plan.players.map((player, index) => (active[index] && (player.position !== 'QB' || plan.players[index] === qb?.player) ? player.carryShare : 0));
  const carries = multinomial(rushAtt, carryWeights, rng);
  for (let index = 0; index < n; index += 1) {
    const player = plan.players[index]!;
    car[index] = carries[index]!;
    if (car[index]! > 0) rushYds[index] = Math.round(car[index]! * player.ypc * efficiency + normal(rng) * Math.sqrt(car[index]!) * 5.5);
  }
  const passTd = binomial(offTd, plan.passTdShare, rng);
  for (let td = 0; td < passTd; td += 1) {
    const pick = weightedPick(plan.players.map((player, index) => Math.max(0, rec[index]! - recTd[index]!) * player.tdPerRec), rng);
    if (pick >= 0) recTd[pick]! += 1;
  }
  for (let td = 0; td < offTd - passTd; td += 1) {
    const pick = weightedPick(plan.players.map((player, index) => Math.max(0, car[index]! - rushTd[index]!) * player.tdPerCarry), rng);
    if (pick >= 0) rushTd[pick]! += 1;
  }
  const completions = rec.reduce((sum, value) => sum + value, 0);
  const passYds = recYds.reduce((sum, value) => sum + value, 0);
  const passTdTotal = recTd.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < n; index += 1) {
    const player = plan.players[index]!;
    const row = tally.get(player.id)!;
    row.active![draw] = active[index] ? 1 : 0;
    if (!active[index]) continue;
    const starter = qb?.player === player;
    row.pass_att![draw] = starter ? passAtt : 0;
    row.pass_cmp![draw] = starter ? completions : 0;
    row.pass_yds![draw] = starter ? passYds : 0;
    row.pass_td![draw] = starter ? passTdTotal : 0;
    row.int![draw] = starter ? poisson(passAtt * player.intRate, rng) : 0;
    row.car![draw] = car[index]!;
    row.rush_yds![draw] = rushYds[index]!;
    row.rush_td![draw] = rushTd[index]!;
    row.tgt![draw] = tgt[index]!;
    row.rec![draw] = rec[index]!;
    row.rec_yds![draw] = recYds[index]!;
    row.rec_td![draw] = recTd[index]!;
  }
}

function quantile(sorted: Float64Array | number[], q: number): number {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
}

export function band(values: ArrayLike<number>, spread = 1): Band {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const value of sorted) sum += value;
  const p50 = quantile(sorted, 0.5);
  const p10 = quantile(sorted, 0.1);
  const p90 = quantile(sorted, 0.9);
  return {
    mean: sorted.length ? sum / sorted.length : 0,
    p10: p50 - (p50 - p10) * spread,
    p50,
    p90: p50 + (p90 - p50) * spread,
  };
}

const logit = (p: number) => Math.log(clamp(p, 1e-6, 1 - 1e-6) / (1 - clamp(p, 1e-6, 1 - 1e-6)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function calibrateWin(p: number, calibration: NflCalibration): number {
  return sigmoid(logit(p) / calibration.temperature);
}

export function calibrateTd(p: number, calibration: NflCalibration): number {
  return sigmoid(calibration.td.a + calibration.td.b * logit(p));
}

const RELEVANT: Record<NflPosition, NflStat[]> = {
  QB: ['pass_yds', 'pass_td', 'int', 'pass_cmp', 'rush_yds'],
  RB: ['rush_yds', 'car', 'rec', 'rec_yds'],
  WR: ['rec', 'rec_yds', 'tgt'],
  TE: ['rec', 'rec_yds', 'tgt'],
};

export interface SimulatedGame {
  projection: GameProjection;
  /** Raw per-draw values for checking against a box score. */
  raw: { homeWin: number; margins: Float64Array; combined: Float64Array; tally: Map<string, Tally> };
}

/** Plays one game `draws` times from two team plans. */
export function simulateGame(home: TeamPlan, away: TeamPlan, neutral: boolean, draws: number, seed: number, calibration: NflCalibration = IDENTITY_CALIBRATION): SimulatedGame {
  const rng = mulberry32(seed);
  const tally = new Map<string, Tally>();
  for (const plan of [home, away]) {
    for (const player of plan.players) {
      const row: Tally = {};
      for (const stat of PLAYER_STATS) row[stat] = new Float64Array(draws);
      tally.set(player.id, row);
    }
  }
  const homePoints = new Float64Array(draws);
  const awayPoints = new Float64Array(draws);
  const pace = (home.drives + away.drives) / 2;
  const expectedMargin = home.points - away.points;
  let homeWins = 0;
  for (let draw = 0; draw < draws; draw += 1) {
    const drives = clamp(Math.round(pace + normal(rng) * 1.1), 7, 15);
    const sigma = calibration.sigma;
    const homeRate = Math.exp(sigma * normal(rng) - (sigma * sigma) / 2);
    const awayRate = Math.exp(sigma * normal(rng) - (sigma * sigma) / 2);
    const h = scoreTeam(home, drives, homeRate, rng);
    const a = scoreTeam(away, drives, awayRate, rng);
    homePoints[draw] = h.points;
    awayPoints[draw] = a.points;
    if (h.points > a.points) homeWins += 1;
    else if (h.points === a.points) {
      // Overtime: a little better than a coin for the stronger side, and a tie one time in twenty.
      const u = rng();
      if (u < 0.95) homeWins += rng() < clamp(0.5 + expectedMargin / 40 + (neutral ? 0 : 0.02), 0.2, 0.8) ? 1 : 0;
      else homeWins += 0.5;
    }
    playTeam(home, h.points - a.points, expectedMargin, homeRate, h.offTd, rng, tally, draw);
    playTeam(away, a.points - h.points, -expectedMargin, awayRate, a.offTd, rng, tally, draw);
  }
  const margins = homePoints.map((value, index) => value - awayPoints[index]!);
  const combined = homePoints.map((value, index) => value + awayPoints[index]!);
  const players: PlayerProjection[] = [];
  for (const [plan, side] of [[away, 'away'], [home, 'home']] as const) {
    for (const player of plan.players) {
      const row = tally.get(player.id)!;
      const played: number[] = [];
      for (let draw = 0; draw < draws; draw += 1) if (row.active![draw]) played.push(draw);
      if (!played.length) continue;
      const pick = (stat: string) => played.map((draw) => row[stat]![draw]!);
      const stats: Partial<Record<NflStat, Band>> = {};
      for (const stat of RELEVANT[player.position]) {
        if (player.position === 'QB' && stat !== 'rush_yds' && pick('pass_att').every((value) => value === 0)) continue;
        const scale = biasFor(calibration, player.position, stat);
        stats[stat] = band(pick(stat).map((value) => value * scale), calibration.spread[stat] ?? 1);
      }
      let scored = 0;
      for (const draw of played) if (row.rush_td![draw]! + row.rec_td![draw]! > 0) scored += 1;
      players.push({
        id: player.id,
        name: player.name,
        side,
        position: player.position,
        status: player.status,
        play: played.length / draws,
        stats,
        td: calibrateTd(scored / played.length, calibration),
      });
    }
  }
  return {
    projection: {
      draws,
      away_points: band(awayPoints),
      home_points: band(homePoints),
      margin: band(margins, calibration.spread.margin ?? 1),
      combined: band(combined, calibration.spread.combined ?? 1),
      home_win: calibrateWin(homeWins / draws, calibration),
      players,
    },
    raw: { homeWin: homeWins / draws, margins, combined, tally },
  };
}

/** Both team plans for one game as of `asOf`, from games that started before it. */
export function planGame(
  games: readonly NflBoxGame[],
  homeAbbr: string,
  awayAbbr: string,
  neutral: boolean,
  asOf: number,
  rosters: { home: readonly RosterEntry[] | null; away: readonly RosterEntry[] | null } = { home: null, away: null },
): { home: TeamPlan; away: TeamPlan } {
  const ratings = fitTeamRatings(games, asOf);
  const venue = neutral ? 0 : 0.5;
  return {
    home: teamPlan(teamUsage(games, homeAbbr, asOf), homeAbbr, expectedPoints(ratings, homeAbbr, awayAbbr, venue), rosters.home),
    away: teamPlan(teamUsage(games, awayAbbr, asOf), awayAbbr, expectedPoints(ratings, awayAbbr, homeAbbr, -venue), rosters.away),
  };
}

export interface WalkForwardResult {
  games: number;
  fromWeek: number | null;
  throughWeek: number | null;
  winBrier: number;
  winLogLoss: number;
  marginMae: number;
  coverage: Partial<Record<NflStat | 'margin' | 'combined', number>>;
  playerRows: number;
  tdBrier: number;
  /** Mean absolute error per stat after the bias scale, players who played. */
  mae: Partial<Record<NflStat, number>>;
  calibration: NflCalibration;
}

interface CheckRow {
  stat: NflStat | 'margin' | 'combined';
  p10: number;
  p50: number;
  p90: number;
  actual: number;
}

function coverageAt(rows: readonly CheckRow[], spread: number): number {
  if (!rows.length) return 0;
  let inside = 0;
  for (const row of rows) {
    const lo = row.p50 - (row.p50 - row.p10) * spread;
    const hi = row.p50 + (row.p90 - row.p50) * spread;
    if (row.actual >= lo && row.actual <= hi) inside += 1;
  }
  return inside / rows.length;
}

/** The scale around the median that puts 80% of outcomes inside the 10th-90th range, between 0.6 and 2.5. */
export function fitSpread(rows: readonly CheckRow[]): number {
  if (rows.length < 40) return 1;
  let lo = 0.6;
  let hi = 2.5;
  if (coverageAt(rows, hi) < 0.8) return hi;
  if (coverageAt(rows, lo) >= 0.8) return lo;
  for (let step = 0; step < 30; step += 1) {
    const mid = (lo + hi) / 2;
    if (coverageAt(rows, mid) >= 0.8) hi = mid;
    else lo = mid;
  }
  return Number(hi.toFixed(3));
}

/** Two-parameter logistic map on the logit, by Newton steps with a light ridge toward the identity. */
export function fitPlattMap(rows: readonly { p: number; y: number }[]): { a: number; b: number } {
  if (rows.length < 100) return { a: 0, b: 1 };
  let a = 0;
  let b = 1;
  for (let iteration = 0; iteration < 50; iteration += 1) {
    let ga = 0;
    let gb = -(b - 1) * 2;
    let haa = 2;
    let hab = 0;
    let hbb = 2;
    for (const row of rows) {
      const x = logit(row.p);
      const q = sigmoid(a + b * x);
      const r = row.y - q;
      ga += r;
      gb += r * x;
      const w = q * (1 - q);
      haa += w;
      hab += w * x;
      hbb += w * x * x;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da;
    b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-8) break;
  }
  return { a: Number(a.toFixed(4)), b: Number(clamp(b, 0.2, 3).toFixed(4)) };
}

function meanLogLoss(rows: readonly { p: number; y: number }[], map: (p: number) => number): number {
  let loss = 0;
  for (const row of rows) {
    const q = clamp(map(row.p), 1e-6, 1 - 1e-6);
    loss += -(row.y * Math.log(q) + (1 - row.y) * Math.log(1 - q));
  }
  return rows.length ? loss / rows.length : Number.NaN;
}

/** The players who recorded a passing, rushing or receiving line, as the active list a past game had. */
function participants(side: NflTeamBox, usage: TeamUsage): RosterEntry[] {
  return side.players.map((line) => {
    const known = usage.players.get(line.id);
    return { id: line.id, name: line.name, position: known ? inferPosition(known) : line.pass_att >= 5 ? 'QB' : line.car > line.tgt ? 'RB' : 'WR', status: null };
  });
}

interface PlayerCheck {
  key: string;
  stat: NflStat;
  band: Band;
  actual: number;
}

function actualOf(line: NflLine, stat: NflStat): number {
  return line[stat];
}

/** Mean-bias scale for one `position:stat`: recorded over projected, pulled toward 1 with 200 rows of prior. */
export function fitBias(rows: readonly { projected: number; actual: number }[]): number {
  const projected = rows.reduce((sum, row) => sum + row.projected, 0);
  const actual = rows.reduce((sum, row) => sum + row.actual, 0);
  if (!(projected > 0) || rows.length < 30) return 1;
  const ratio = actual / projected;
  return Number((1 + (ratio - 1) * (rows.length / (rows.length + 200))).toFixed(4));
}

function scaled(band: Band, scale: number): Band {
  return { mean: band.mean * scale, p10: band.p10 * scale, p50: band.p50 * scale, p90: band.p90 * scale };
}

/**
 * Projects each week from the weeks before it and fits what the page uses: the scoring noise whose margins and totals
 * cover 80% of results, a win-chance temperature, a mean-bias scale per position and stat, a range scale per stat and
 * an anytime-touchdown map. A past game's injury report is not stored, so its active list is the players who
 * recorded a line, which is what the report gives a live projection. Positions are inferred from usage.
 */
export function walkForward(games: readonly NflBoxGame[], draws = 1500, firstWeek = 4, sigmas: readonly number[] = [0, 0.05, 0.1, 0.2]): WalkForwardResult {
  const scored = games.filter((game) => game.week !== null && game.season_type === 2);
  const weeks = [...new Set(scored.map((game) => game.week!))].sort((a, b) => a - b).filter((week) => week >= firstWeek);
  let best: { sigma: number; gameRows: CheckRow[]; players: PlayerCheck[]; wins: { p: number; y: number }[]; tds: { p: number; y: number }[]; marginErrors: number[] } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const sigma of sigmas) {
    const calibration: NflCalibration = { ...IDENTITY_CALIBRATION, sigma };
    const gameRows: CheckRow[] = [];
    const players: PlayerCheck[] = [];
    const wins: { p: number; y: number }[] = [];
    const tds: { p: number; y: number }[] = [];
    const marginErrors: number[] = [];
    for (const week of weeks) {
      for (const game of scored.filter((item) => item.week === week)) {
        const asOf = Date.parse(game.start_time);
        const ratings = fitTeamRatings(games, asOf);
        const venue = game.neutral ? 0 : 0.5;
        const homeUsage = teamUsage(games, game.home.abbr, asOf);
        const awayUsage = teamUsage(games, game.away.abbr, asOf);
        const home = teamPlan(homeUsage, game.home.abbr, expectedPoints(ratings, game.home.abbr, game.away.abbr, venue), participants(game.home, homeUsage));
        const away = teamPlan(awayUsage, game.away.abbr, expectedPoints(ratings, game.away.abbr, game.home.abbr, -venue), participants(game.away, awayUsage));
        const sim = simulateGame(home, away, game.neutral, draws, Number.parseInt(game.id, 10) || 1, calibration);
        const actualMargin = game.home.points - game.away.points;
        wins.push({ p: sim.raw.homeWin, y: actualMargin > 0 ? 1 : actualMargin < 0 ? 0 : 0.5 });
        marginErrors.push(Math.abs(sim.projection.margin.mean - actualMargin));
        gameRows.push({ stat: 'margin', ...sim.projection.margin, actual: actualMargin });
        gameRows.push({ stat: 'combined', ...sim.projection.combined, actual: game.home.points + game.away.points });
        for (const side of [game.home, game.away]) {
          const lines = new Map<string, NflLine>(side.players.map((line) => [line.id, line]));
          for (const player of sim.projection.players) {
            const line = lines.get(player.id);
            if (!line) continue;
            for (const [stat, value] of Object.entries(player.stats) as [NflStat, Band][]) {
              players.push({ key: `${player.position}:${stat}`, stat, band: value, actual: actualOf(line, stat) });
            }
            tds.push({ p: player.td, y: line.rush_td + line.rec_td > 0 ? 1 : 0 });
          }
        }
      }
    }
    // The noise level is chosen on how well simulated margins and totals spread, then on win log loss.
    const score = Math.abs(coverageAt(gameRows, 1) - 0.8) + meanLogLoss(wins.filter((row) => row.y !== 0.5), (p) => p) * 0.1;
    if (score < bestScore) {
      bestScore = score;
      best = { sigma, gameRows, players, wins, tds, marginErrors };
    }
  }
  if (!best || !best.wins.length) {
    return { games: 0, fromWeek: null, throughWeek: null, winBrier: Number.NaN, winLogLoss: Number.NaN, marginMae: Number.NaN, coverage: {}, playerRows: 0, tdBrier: Number.NaN, mae: {}, calibration: IDENTITY_CALIBRATION };
  }
  const decided = best.wins.filter((row) => row.y !== 0.5);
  let temperature = 1;
  let bestLoss = meanLogLoss(decided, (p) => p);
  for (let t = 0.5; t <= 2.01; t += 0.05) {
    const loss = meanLogLoss(decided, (p) => sigmoid(logit(p) / t));
    if (loss < bestLoss - 1e-9) {
      bestLoss = loss;
      temperature = Number(t.toFixed(2));
    }
  }
  const bias: Record<string, number> = {};
  for (const key of new Set(best.players.map((row) => row.key))) {
    const rows = best.players.filter((row) => row.key === key);
    const scale = fitBias(rows.map((row) => ({ projected: row.band.mean, actual: row.actual })));
    if (scale !== 1) bias[key] = scale;
  }
  const corrected = best.players.map((row) => ({ ...row, band: scaled(row.band, bias[row.key] ?? 1) }));
  const spread: NflCalibration['spread'] = {};
  const coverage: WalkForwardResult['coverage'] = {};
  const mae: WalkForwardResult['mae'] = {};
  for (const stat of NFL_STATS) {
    const rows = corrected.filter((row) => row.stat === stat).map((row) => ({ stat, ...row.band, actual: row.actual }));
    if (!rows.length) continue;
    spread[stat] = fitSpread(rows);
    coverage[stat] = Number(coverageAt(rows, spread[stat]!).toFixed(3));
    mae[stat] = Number((rows.reduce((sum, row) => sum + Math.abs(row.mean - row.actual), 0) / rows.length).toFixed(2));
  }
  for (const stat of ['margin', 'combined'] as const) {
    const rows = best.gameRows.filter((row) => row.stat === stat);
    spread[stat] = fitSpread(rows);
    coverage[stat] = Number(coverageAt(rows, spread[stat]!).toFixed(3));
  }
  const td = fitPlattMap(best.tds);
  const calibration: NflCalibration = { sigma: best.sigma, temperature, td, spread, bias };
  const winBrier = decided.reduce((sum, row) => sum + (calibrateWin(row.p, calibration) - row.y) ** 2, 0) / decided.length;
  const tdBrier = best.tds.reduce((sum, row) => sum + (calibrateTd(row.p, calibration) - row.y) ** 2, 0) / Math.max(1, best.tds.length);
  return {
    games: best.wins.length,
    fromWeek: weeks[0] ?? null,
    throughWeek: weeks[weeks.length - 1] ?? null,
    winBrier: Number(winBrier.toFixed(4)),
    winLogLoss: Number(meanLogLoss(decided, (p) => calibrateWin(p, calibration)).toFixed(4)),
    marginMae: Number((best.marginErrors.reduce((sum, value) => sum + value, 0) / best.marginErrors.length).toFixed(2)),
    coverage,
    playerRows: best.tds.length,
    tdBrier: Number(tdBrier.toFixed(4)),
    mae,
    calibration,
  };
}

/**
 * A finished game's active list: the players who recorded a line, with roster positions where the roster has them.
 * Today's roster can be missing someone hurt in that game, so a played game is projected from who took part.
 */
export function playedRoster(side: NflTeamBox, positions: ReadonlyMap<string, string>): RosterEntry[] {
  return side.players.map((line) => ({
    id: line.id,
    name: line.name,
    position: positions.get(line.id) ?? (line.pass_att >= 5 ? 'QB' : line.car > line.tgt ? 'RB' : 'WR'),
    status: null,
  }));
}
