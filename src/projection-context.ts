import { chicagoDate } from './date.ts';
import { positionGroup } from './fit.ts';
import type { CompletedEvent, ParsedPlayerGame } from './parse-summary.ts';
import type { HistoricalPlay } from './play-history.ts';
import type { PropMarket, PropSide } from './props.ts';
import type { PositionGroup, RateGame, Slate } from './types.ts';

export const NBA_TEAMS: Readonly<Record<string, { abbr: string; name: string }>> = {
  '1': { abbr: 'ATL', name: 'Atlanta Hawks' },
  '2': { abbr: 'BOS', name: 'Boston Celtics' },
  '3': { abbr: 'NO', name: 'New Orleans Pelicans' },
  '4': { abbr: 'CHI', name: 'Chicago Bulls' },
  '5': { abbr: 'CLE', name: 'Cleveland Cavaliers' },
  '6': { abbr: 'DAL', name: 'Dallas Mavericks' },
  '7': { abbr: 'DEN', name: 'Denver Nuggets' },
  '8': { abbr: 'DET', name: 'Detroit Pistons' },
  '9': { abbr: 'GS', name: 'Golden State Warriors' },
  '10': { abbr: 'HOU', name: 'Houston Rockets' },
  '11': { abbr: 'IND', name: 'Indiana Pacers' },
  '12': { abbr: 'LAC', name: 'LA Clippers' },
  '13': { abbr: 'LAL', name: 'Los Angeles Lakers' },
  '14': { abbr: 'MIA', name: 'Miami Heat' },
  '15': { abbr: 'MIL', name: 'Milwaukee Bucks' },
  '16': { abbr: 'MIN', name: 'Minnesota Timberwolves' },
  '17': { abbr: 'BKN', name: 'Brooklyn Nets' },
  '18': { abbr: 'NY', name: 'New York Knicks' },
  '19': { abbr: 'ORL', name: 'Orlando Magic' },
  '20': { abbr: 'PHI', name: 'Philadelphia 76ers' },
  '21': { abbr: 'PHX', name: 'Phoenix Suns' },
  '22': { abbr: 'POR', name: 'Portland Trail Blazers' },
  '23': { abbr: 'SAC', name: 'Sacramento Kings' },
  '24': { abbr: 'SA', name: 'San Antonio Spurs' },
  '25': { abbr: 'OKC', name: 'Oklahoma City Thunder' },
  '26': { abbr: 'UTAH', name: 'Utah Jazz' },
  '27': { abbr: 'WSH', name: 'Washington Wizards' },
  '28': { abbr: 'TOR', name: 'Toronto Raptors' },
  '29': { abbr: 'MEM', name: 'Memphis Grizzlies' },
  '30': { abbr: 'CHA', name: 'Charlotte Hornets' },
};

/**
 * Chronological game tuple (oldest -> newest):
 * [date, opp, home0or1, teamPts, oppPts, season, min, pts, reb, ast, tpm, fgm, fga, tpa, ftm, fta, stl, blk, tov, orb, drb, usg]
 */
export type CompactPlayerGame = [
  string,
  string,
  0 | 1,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

export interface PlayerGameRow {
  date: string;
  opp: string;
  home: boolean;
  teamPts: number;
  oppPts: number;
  season: number;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  tpm: number;
  fgm: number;
  fga: number;
  tpa: number;
  ftm: number;
  fta: number;
  stl: number | null;
  blk: number | null;
  tov: number | null;
  orb: number | null;
  drb: number | null;
  usg: number | null;
}

/** [min, usg, pts36, fga36, reb36, ast36, tov36] */
export type StintRateTuple = [number, number, number, number, number, number, number];

export interface TeammateSplit {
  mate_id: string;
  on: StintRateTuple;
  off: StintRateTuple;
}

export interface PlayerOnOffSummary {
  season_label: string;
  games: number;
  overall: StintRateTuple;
  splits: TeammateSplit[];
}

export interface PackedOnOffSummary {
  season_label: string;
  games: number;
  /** "min,usg,pts36,fga36,reb36,ast36,tov36" */
  overall: string;
  /** Semicolon-delimited "mateId|onMin,onUsg,onPts36,onFga36,onReb36,onAst36,onTov36|offMin,offUsg,..." */
  splits: string | string[];
}

export type DefenseStatKey = 'pts' | 'reb' | 'ast' | 'tpm' | 'pra' | 'pa' | 'pr' | 'ra' | 'stl' | 'blk' | 'tov';
export type DefenseSlot = 'all' | 'G' | 'F' | 'C';

/** [allowedPerGame, rank1to30] — rank 1 = fewest allowed, rank 30 = most allowed */
export type RankedStat = [number, number];

export interface TeamDefenseEntry {
  abbr: string;
  name: string;
  games: number;
  /** "possPer48,rank1to30" — rank 1 = fastest pace */
  pace: string;
  /** Keyed by stat, value "allVal,allRank|GVal,GRank|FVal,FRank|CVal,CRank" */
  allowed: Record<DefenseStatKey, string>;
}

export interface ProjectionPlayerEntry {
  /** Semicolon-delimited chronological games; each game is 22 comma-separated fields. */
  games: string;
  on_off: PackedOnOffSummary | null;
}

export interface ProjectionContext {
  active_season: number;
  season_label: string;
  defense_season_label: string;
  teams: Record<string, TeamDefenseEntry>;
  players: Record<string, ProjectionPlayerEntry>;
}

export const DEFENSE_STAT_KEYS: readonly DefenseStatKey[] = [
  'pts',
  'reb',
  'ast',
  'tpm',
  'pra',
  'pa',
  'pr',
  'ra',
  'stl',
  'blk',
  'tov',
];

export const DEFENSE_SLOTS: readonly DefenseSlot[] = ['all', 'G', 'F', 'C'];
export const MIN_SPLIT_MINUTES = 20;

const MIN_PRIMARY_ONOFF_MINUTES = 40;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function seasonLabel(season: number): string {
  return `${season - 1}-${String(season).slice(-2)}`;
}

function posSlot(group: PositionGroup | undefined): 'G' | 'F' | 'C' | null {
  if (group === 'Guard') return 'G';
  if (group === 'Forward') return 'F';
  if (group === 'Center') return 'C';
  return null;
}

export function positionToDefenseSlot(group: PositionGroup | string | undefined): DefenseSlot {
  if (group === 'Guard' || group === 'G' || group === 'PG' || group === 'SG') return 'G';
  if (group === 'Forward' || group === 'F' || group === 'SF' || group === 'PF') return 'F';
  if (group === 'Center' || group === 'C') return 'C';
  return 'all';
}

export interface RebuiltTeamStint {
  period: number;
  startSeconds: number;
  endSeconds: number;
  seconds: number;
  lineup: string[];
  plays: HistoricalPlay[];
}

/**
 * Reconstructs verified 5-man stints for a single team from play-by-play.
 * Period plays are ordered by clock within each period so official-scorer sequence edits
 * do not discard valid quarters, while still requiring reconciled game totals and exact 5-man lineups.
 */
export function reconstructTeamStints(event: CompletedEvent, teamId: string): RebuiltTeamStint[] {
  const stints: RebuiltTeamStint[] = [];
  const history = event.play_history;
  if (!history?.plays?.length || history.reason === 'Malformed/duplicate plays') return stints;
  let maxHome = 0;
  let maxAway = 0;
  for (const play of history.plays) {
    if (play.home > maxHome) maxHome = play.home;
    if (play.away > maxAway) maxAway = play.away;
  }
  if (maxHome !== event.home_pts || maxAway !== event.away_pts) return stints;
  const teamOf = new Map(event.players.map((player) => [player.athlete_id, player.team_id]));
  const plays = [...history.plays].sort(
    (a, b) => a.period - b.period || b.seconds - a.seconds || a.sequence - b.sequence,
  );
  for (let period = 1; period <= event.periods; period += 1) {
    const periodPlays = plays.filter((play) => play.period === period);
    const starters = new Set<string>(
      period === 1
        ? event.players.filter((player) => player.team_id === teamId && player.starter === true).map((player) => player.athlete_id)
        : [],
    );
    const entered = new Set<string>();
    const exited = new Set<string>();
    let valid = true;
    for (const play of periodPlays) {
      if (play.type === 'Substitution' && play.team === teamId) {
        const [inside, outside] = play.athletes;
        if (!inside || !outside || teamOf.get(inside) !== teamId || teamOf.get(outside) !== teamId) {
          valid = false;
          break;
        }
        if (!entered.has(outside)) starters.add(outside);
        entered.add(inside);
        exited.add(outside);
        exited.delete(inside);
      } else if (!/technical|timeout|challenge|jumpball|end |violation/i.test(play.type)) {
        for (const id of play.athletes) {
          if (teamOf.get(id) !== teamId) continue;
          if (!entered.has(id) && !exited.has(id)) starters.add(id);
        }
      }
    }
    if (!valid || starters.size !== 5) continue;
    const on = new Set(starters);
    let startSeconds = period <= 4 ? 720 : 300;
    let currentPlays: HistoricalPlay[] = [];
    const periodStints: RebuiltTeamStint[] = [];
    for (const play of periodPlays) {
      if (play.type === 'Substitution' && play.team === teamId) {
        if (startSeconds > play.seconds) {
          periodStints.push({
            period,
            startSeconds,
            endSeconds: play.seconds,
            seconds: startSeconds - play.seconds,
            lineup: [...on].sort(),
            plays: currentPlays,
          });
          currentPlays = [];
          startSeconds = play.seconds;
        }
        const [inside, outside] = play.athletes;
        if (!on.has(outside) || on.has(inside)) {
          valid = false;
          break;
        }
        on.delete(outside);
        on.add(inside);
        if (on.size !== 5) {
          valid = false;
          break;
        }
      } else {
        currentPlays.push(play);
      }
    }
    if (!valid) continue;
    if (startSeconds > 0) {
      periodStints.push({
        period,
        startSeconds,
        endSeconds: 0,
        seconds: startSeconds,
        lineup: [...on].sort(),
        plays: currentPlays,
      });
    } else if (currentPlays.length && periodStints.length) {
      periodStints[periodStints.length - 1].plays.push(...currentPlays);
    }
    stints.push(...periodStints);
  }
  return stints;
}

interface StintBucket {
  sec: number;
  pts: number;
  fga: number;
  fta: number;
  tov: number;
  reb: number;
  ast: number;
  teamFga: number;
  teamFta: number;
  teamTov: number;
}

function emptyBucket(): StintBucket {
  return { sec: 0, pts: 0, fga: 0, fta: 0, tov: 0, reb: 0, ast: 0, teamFga: 0, teamFta: 0, teamTov: 0 };
}

function addStintToBucket(bucket: StintBucket, stint: RebuiltTeamStint, athleteId: string, teamId: string): void {
  let pts = 0;
  let fga = 0;
  let fta = 0;
  let tov = 0;
  let reb = 0;
  let ast = 0;
  let teamFga = 0;
  let teamFta = 0;
  let teamTov = 0;
  for (const play of stint.plays) {
    const primary = play.athletes[0];
    const free = /free throw/i.test(play.type);
    const technical = /technical/i.test(play.type);
    const isTeam = play.team === teamId;
    if (isTeam && !free && (play.attempt === 2 || play.attempt === 3)) {
      teamFga += 1;
      if (primary === athleteId) {
        fga += 1;
        if (play.made) pts += play.attempt;
      }
      if (play.made && play.athletes[1] === athleteId) ast += 1;
    }
    if (isTeam && free && !technical) {
      teamFta += 1;
      if (primary === athleteId) {
        fta += 1;
        if (play.made) pts += 1;
      }
    }
    if (free && technical && primary === athleteId && play.made) pts += 1;
    if (isTeam && /turnover/i.test(play.type)) {
      teamTov += 1;
      if (primary === athleteId) tov += 1;
    }
    if (/rebound/i.test(play.type) && primary === athleteId) reb += 1;
  }
  bucket.sec += stint.seconds;
  bucket.pts += pts;
  bucket.fga += fga;
  bucket.fta += fta;
  bucket.tov += tov;
  bucket.reb += reb;
  bucket.ast += ast;
  bucket.teamFga += teamFga;
  bucket.teamFta += teamFta;
  bucket.teamTov += teamTov;
}

function bucketToTuple(bucket: StintBucket): StintRateTuple {
  const min = bucket.sec / 60;
  if (!(min > 0)) return [0, 0, 0, 0, 0, 0, 0];
  const playerPlays = bucket.fga + 0.44 * bucket.fta + bucket.tov;
  const teamPlays = bucket.teamFga + 0.44 * bucket.teamFta + bucket.teamTov;
  const usg = teamPlays > 0 ? round1((playerPlays / teamPlays) * 100) : 0;
  const per36 = (count: number) => round1((count / min) * 36);
  return [
    Math.round(min),
    usg,
    per36(bucket.pts),
    per36(bucket.fga),
    per36(bucket.reb),
    per36(bucket.ast),
    per36(bucket.tov),
  ];
}

function buildPlayerOnOffForEvents(
  stintsByEvent: readonly { event: CompletedEvent; stints: RebuiltTeamStint[] }[],
  athleteId: string,
  teamId: string,
  teammateIds: readonly string[],
  label: string,
): PlayerOnOffSummary | null {
  const overall = emptyBucket();
  const byMate = new Map<string, { on: StintBucket; off: StintBucket }>();
  for (const mateId of teammateIds) {
    if (mateId !== athleteId) byMate.set(mateId, { on: emptyBucket(), off: emptyBucket() });
  }
  let games = 0;
  for (const { stints } of stintsByEvent) {
    let appeared = false;
    for (const stint of stints) {
      if (!stint.lineup.includes(athleteId)) continue;
      appeared = true;
      addStintToBucket(overall, stint, athleteId, teamId);
      for (const [mateId, pair] of byMate) {
        addStintToBucket(stint.lineup.includes(mateId) ? pair.on : pair.off, stint, athleteId, teamId);
      }
    }
    if (appeared) games += 1;
  }
  if (games === 0 || overall.sec < MIN_SPLIT_MINUTES * 60) return null;
  const minSec = MIN_SPLIT_MINUTES * 60;
  const splits: TeammateSplit[] = [];
  for (const [mateId, pair] of byMate) {
    if (pair.on.sec < minSec || pair.off.sec < minSec) continue;
    const onTuple = bucketToTuple(pair.on);
    const offTuple = bucketToTuple(pair.off);
    if (onTuple[0] < MIN_SPLIT_MINUTES || offTuple[0] < MIN_SPLIT_MINUTES) continue;
    splits.push({ mate_id: mateId, on: onTuple, off: offTuple });
  }
  splits.sort((a, b) => b.on[0] - a.on[0] || a.mate_id.localeCompare(b.mate_id));
  return {
    season_label: label,
    games,
    overall: bucketToTuple(overall),
    splits,
  };
}

function boxUsagePct(player: ParsedPlayerGame, teamPlayers: readonly ParsedPlayerGame[]): number | null {
  if (!(player.minutes > 0) || player.tov === undefined) return null;
  let teamMin = 0;
  let teamFga = 0;
  let teamFta = 0;
  let teamTov = 0;
  for (const mate of teamPlayers) {
    if (mate.tov === undefined) return null;
    teamMin += mate.minutes;
    teamFga += mate.fga;
    teamFta += mate.fta;
    teamTov += mate.tov;
  }
  const teamPlays = teamFga + 0.44 * teamFta + teamTov;
  if (!(teamPlays > 0) || !(teamMin > 0)) return null;
  const playerPlays = player.fga + 0.44 * player.fta + player.tov;
  const pct = ((playerPlays * (teamMin / 5)) / (player.minutes * teamPlays)) * 100;
  return Number.isFinite(pct) && pct >= 0 ? round1(Math.min(100, pct)) : null;
}

function compactGameFromEvent(event: CompletedEvent, player: ParsedPlayerGame): CompactPlayerGame {
  const home: 0 | 1 = player.team_id === event.home_team_id ? 1 : 0;
  const opp = home === 1 ? event.away_team_id : event.home_team_id;
  const teamPts = home === 1 ? event.home_pts : event.away_pts;
  const oppPts = home === 1 ? event.away_pts : event.home_pts;
  const teamPlayers = event.players.filter((row) => row.team_id === player.team_id);
  return [
    chicagoDate(new Date(event.start_time)),
    opp,
    home,
    teamPts,
    oppPts,
    event.season,
    round1(player.minutes),
    player.pts,
    player.reb,
    player.ast,
    player.tpm,
    player.fgm,
    player.fga,
    player.tpa,
    player.ftm,
    player.fta,
    player.stl ?? null,
    player.blk ?? null,
    player.tov ?? null,
    player.orb ?? null,
    player.drb ?? null,
    boxUsagePct(player, teamPlayers),
  ];
}

function selectPlayerGames(
  allGames: readonly CompactPlayerGame[],
  activeSeason: number,
  opponentIds: ReadonlySet<string>,
): CompactPlayerGame[] {
  if (allGames.length <= 25) return [...allGames];
  const keep = new Set<number>();
  // Keep every game from the active season, last 20 home, last 20 away, last 20 overall, and all H2H vs slate opponents.
  let allCount = 0;
  let homeCount = 0;
  let awayCount = 0;
  for (let i = allGames.length - 1; i >= 0; i -= 1) {
    const row = allGames[i];
    if (row[5] === activeSeason || opponentIds.has(row[1])) keep.add(i);
    if (allCount < 20) {
      keep.add(i);
      allCount += 1;
    }
    if (row[2] === 1 && homeCount < 20) {
      keep.add(i);
      homeCount += 1;
    }
    if (row[2] === 0 && awayCount < 20) {
      keep.add(i);
      awayCount += 1;
    }
  }
  return allGames.filter((_, idx) => keep.has(idx));
}

function statForDefense(player: ParsedPlayerGame, key: DefenseStatKey): number {
  if (key === 'pts') return player.pts;
  if (key === 'reb') return player.reb;
  if (key === 'ast') return player.ast;
  if (key === 'tpm') return player.tpm;
  if (key === 'pra') return player.pts + player.reb + player.ast;
  if (key === 'pa') return player.pts + player.ast;
  if (key === 'pr') return player.pts + player.reb;
  if (key === 'ra') return player.reb + player.ast;
  if (key === 'stl') return player.stl ?? 0;
  if (key === 'blk') return player.blk ?? 0;
  return player.tov ?? 0;
}

function teamPossessions(players: readonly ParsedPlayerGame[]): number {
  let fga = 0;
  let orb = 0;
  let tov = 0;
  let fta = 0;
  for (const player of players) {
    fga += player.fga;
    orb += player.orb ?? 0;
    tov += player.tov ?? 0;
    fta += player.fta;
  }
  return Math.max(1, fga - orb + tov + 0.44 * fta);
}

function buildTeamDefense(
  regularEvents: readonly CompletedEvent[],
  slate: Slate,
  positionByAthlete: ReadonlyMap<string, PositionGroup>,
  activeSeason: number,
): { seasonLabelText: string; teams: Record<string, TeamDefenseEntry> } {
  const teamMeta = new Map<string, { abbr: string; name: string }>();
  for (const [id, info] of Object.entries(NBA_TEAMS)) teamMeta.set(id, { ...info });
  for (const game of slate.games) {
    for (const side of [game.away, game.home]) {
      const abbr = side.abbreviation.trim() || teamMeta.get(side.team_id)?.abbr || side.team_id;
      const name = side.name.trim() || teamMeta.get(side.team_id)?.name || abbr;
      teamMeta.set(side.team_id, { abbr, name });
    }
  }

  const activeEvents = regularEvents.filter((event) => event.season === activeSeason);
  const useActive = activeEvents.length >= 15;
  const sourceEvents = useActive ? activeEvents : regularEvents;
  const labelText = useActive
    ? seasonLabel(activeSeason)
    : `${seasonLabel(activeSeason - 1)} & ${seasonLabel(activeSeason)}`;

  interface TeamAccum {
    games: number;
    paceSum: number;
    sums: Record<DefenseStatKey, Record<DefenseSlot, number>>;
  }
  const makeAccum = (): TeamAccum => {
    const sums = {} as Record<DefenseStatKey, Record<DefenseSlot, number>>;
    for (const key of DEFENSE_STAT_KEYS) sums[key] = { all: 0, G: 0, F: 0, C: 0 };
    return { games: 0, paceSum: 0, sums };
  };

  const accumByTeam = new Map<string, TeamAccum>();
  const accumulateFrom = (events: readonly CompletedEvent[], onlyMissingTeams: boolean) => {
    for (const event of events) {
      const duration = 48 + 5 * (event.periods - 4);
      const homePlayers = event.players.filter((player) => player.team_id === event.home_team_id);
      const awayPlayers = event.players.filter((player) => player.team_id === event.away_team_id);
      const pace48 = ((teamPossessions(homePlayers) + teamPossessions(awayPlayers)) / 2) * (48 / duration);
      const pairs: [string, readonly ParsedPlayerGame[]][] = [
        [event.home_team_id, awayPlayers],
        [event.away_team_id, homePlayers],
      ];
      for (const [defId, oppPlayers] of pairs) {
        if (onlyMissingTeams && (accumByTeam.get(defId)?.games ?? 0) > 0) continue;
        if (!teamMeta.has(defId)) teamMeta.set(defId, { abbr: defId, name: `Team ${defId}` });
        const acc = accumByTeam.get(defId) ?? makeAccum();
        acc.games += 1;
        acc.paceSum += pace48;
        for (const opp of oppPlayers) {
          const slot = posSlot(positionByAthlete.get(opp.athlete_id));
          for (const key of DEFENSE_STAT_KEYS) {
            const val = statForDefense(opp, key);
            acc.sums[key].all += val;
            if (slot) acc.sums[key][slot] += val;
          }
        }
        accumByTeam.set(defId, acc);
      }
    }
  };

  accumulateFrom(sourceEvents, false);
  if (useActive) accumulateFrom(regularEvents, true);

  const teamIds = [...accumByTeam.keys()].filter((id) => (accumByTeam.get(id)?.games ?? 0) > 0).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const avgPace = new Map<string, number>();
  const avgAllowed = new Map<string, Record<DefenseStatKey, Record<DefenseSlot, number>>>();
  for (const id of teamIds) {
    const acc = accumByTeam.get(id)!;
    avgPace.set(id, acc.paceSum / acc.games);
    const allowed = {} as Record<DefenseStatKey, Record<DefenseSlot, number>>;
    for (const key of DEFENSE_STAT_KEYS) {
      allowed[key] = {
        all: acc.sums[key].all / acc.games,
        G: acc.sums[key].G / acc.games,
        F: acc.sums[key].F / acc.games,
        C: acc.sums[key].C / acc.games,
      };
    }
    avgAllowed.set(id, allowed);
  }

  // Pace rank: 1 = fastest (highest possessions/48), N = slowest.
  const paceOrder = [...teamIds].sort((a, b) => (avgPace.get(b)! - avgPace.get(a)!) || Number(a) - Number(b));
  const paceRank = new Map(paceOrder.map((id, idx) => [id, idx + 1]));

  // Defense rank: 1 = fewest allowed (toughest defense), N = most allowed (softest defense / favorable for overs).
  const defRanks: Record<DefenseStatKey, Record<DefenseSlot, Map<string, number>>> = {} as Record<
    DefenseStatKey,
    Record<DefenseSlot, Map<string, number>>
  >;
  for (const key of DEFENSE_STAT_KEYS) {
    defRanks[key] = {} as Record<DefenseSlot, Map<string, number>>;
    for (const slot of DEFENSE_SLOTS) {
      const ordered = [...teamIds].sort(
        (a, b) => (avgAllowed.get(a)![key][slot] - avgAllowed.get(b)![key][slot]) || Number(a) - Number(b),
      );
      defRanks[key][slot] = new Map(ordered.map((id, idx) => [id, idx + 1]));
    }
  }

  const teams: Record<string, TeamDefenseEntry> = {};
  for (const id of teamIds) {
    const meta = teamMeta.get(id) ?? { abbr: id, name: `Team ${id}` };
    const acc = accumByTeam.get(id)!;
    const allowedOut = {} as Record<DefenseStatKey, string>;
    for (const key of DEFENSE_STAT_KEYS) {
      allowedOut[key] = DEFENSE_SLOTS.map(
        (slot) => `${round1(avgAllowed.get(id)![key][slot])},${defRanks[key][slot].get(id) ?? 1}`,
      ).join('|');
    }
    teams[id] = {
      abbr: meta.abbr,
      name: meta.name,
      games: acc.games,
      pace: `${round1(avgPace.get(id)!)},${paceRank.get(id) ?? 1}`,
      allowed: allowedOut,
    };
  }
  return { seasonLabelText: labelText, teams };
}

export function buildProjectionContext(input: {
  events: readonly CompletedEvent[];
  slate: Slate;
  games: readonly RateGame[];
  roster?: readonly { athlete_id: string; position?: string; position_group?: PositionGroup }[];
  archivedPositions?: ReadonlyMap<string, PositionGroup>;
  activeSeason: number;
}): ProjectionContext {
  const regularEvents = [...input.events]
    .filter((event) => event.season_type === 2)
    .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.event_id.localeCompare(b.event_id));

  const positionByAthlete = new Map<string, PositionGroup>();
  if (input.archivedPositions) {
    for (const [id, group] of input.archivedPositions) {
      if (group) positionByAthlete.set(id, group);
    }
  }
  for (const game of input.games) {
    for (const player of game.players) {
      if (player.position_group) positionByAthlete.set(player.athlete_id, player.position_group);
    }
  }
  for (const row of input.roster ?? []) {
    const resolved = row.position_group || (row.position ? positionGroup(row.position) : '');
    if (resolved) positionByAthlete.set(row.athlete_id, resolved);
  }

  const { seasonLabelText, teams } = buildTeamDefense(regularEvents, input.slate, positionByAthlete, input.activeSeason);

  // Gather unique slate athletes, their current team, their roster teammates, and their slate opponents.
  const athleteInfo = new Map<
    string,
    { teamId: string; teammates: Set<string>; opponents: Set<string> }
  >();
  const slateTeams = new Set<string>();
  for (const game of input.games) {
    slateTeams.add(game.away_team_id);
    slateTeams.add(game.home_team_id);
    const awayIds = game.players.filter((p) => p.team_id === game.away_team_id && !p.replacement_level).map((p) => p.athlete_id);
    const homeIds = game.players.filter((p) => p.team_id === game.home_team_id && !p.replacement_level).map((p) => p.athlete_id);
    for (const player of game.players) {
      if (player.replacement_level) continue;
      const entry = athleteInfo.get(player.athlete_id) ?? {
        teamId: player.team_id,
        teammates: new Set<string>(),
        opponents: new Set<string>(),
      };
      entry.teamId = player.team_id;
      const mates = player.team_id === game.away_team_id ? awayIds : homeIds;
      for (const mateId of mates) if (mateId !== player.athlete_id) entry.teammates.add(mateId);
      entry.opponents.add(player.team_id === game.away_team_id ? game.home_team_id : game.away_team_id);
      athleteInfo.set(player.athlete_id, entry);
    }
  }

  // Index player box-score games across regularEvents.
  const allGamesByAthlete = new Map<string, CompactPlayerGame[]>();
  for (const event of regularEvents) {
    for (const player of event.players) {
      if (!athleteInfo.has(player.athlete_id) || !(player.minutes > 0)) continue;
      const list = allGamesByAthlete.get(player.athlete_id) ?? [];
      list.push(compactGameFromEvent(event, player));
      allGamesByAthlete.set(player.athlete_id, list);
    }
  }

  // Reconstruct team stints once per (slateTeam, event) so on/off builds cleanly in milliseconds.
  const stintsByTeamActive = new Map<string, { event: CompletedEvent; stints: RebuiltTeamStint[] }[]>();
  const stintsByTeamAll = new Map<string, { event: CompletedEvent; stints: RebuiltTeamStint[] }[]>();
  for (const teamId of slateTeams) {
    stintsByTeamActive.set(teamId, []);
    stintsByTeamAll.set(teamId, []);
  }
  for (const event of regularEvents) {
    for (const teamId of [event.away_team_id, event.home_team_id]) {
      if (!slateTeams.has(teamId)) continue;
      const stints = reconstructTeamStints(event, teamId);
      if (!stints.length) continue;
      stintsByTeamAll.get(teamId)!.push({ event, stints });
      if (event.season === input.activeSeason) {
        stintsByTeamActive.get(teamId)!.push({ event, stints });
      }
    }
  }

  const activeLabel = seasonLabel(input.activeSeason);
  const multiLabel = `${seasonLabel(input.activeSeason - 1)} & ${activeLabel}`;
  const players: Record<string, ProjectionPlayerEntry> = {};
  for (const athleteId of [...athleteInfo.keys()].sort((a, b) => a.localeCompare(b))) {
    const info = athleteInfo.get(athleteId)!;
    const rawGames = allGamesByAthlete.get(athleteId) ?? [];
    const games = selectPlayerGames(rawGames, input.activeSeason, info.opponents);
    const mateList = [...info.teammates].sort((a, b) => a.localeCompare(b));
    const activeOnOff = buildPlayerOnOffForEvents(
      stintsByTeamActive.get(info.teamId) ?? [],
      athleteId,
      info.teamId,
      mateList,
      activeLabel,
    );
    const onOff =
      activeOnOff && activeOnOff.overall[0] >= MIN_PRIMARY_ONOFF_MINUTES
        ? activeOnOff
        : buildPlayerOnOffForEvents(
            stintsByTeamAll.get(info.teamId) ?? [],
            athleteId,
            info.teamId,
            mateList,
            multiLabel,
          ) ?? activeOnOff;
    players[athleteId] = {
      games: games.map((row) => row.map((v) => (v === null ? '' : String(v))).join(',')).join(';'),
      on_off: onOff
        ? {
            season_label: onOff.season_label,
            games: onOff.games,
            overall: onOff.overall.join(','),
            splits: onOff.splits.map((s) => `${s.mate_id}|${s.on.join(',')}|${s.off.join(',')}`).join(';'),
          }
        : null,
    };
  }

  return {
    active_season: input.activeSeason,
    season_label: activeLabel,
    defense_season_label: seasonLabelText,
    teams,
    players,
  };
}

function optNum(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function unpackPlayerGames(packed: string | readonly CompactPlayerGame[] | undefined): PlayerGameRow[] {
  if (!packed) return [];
  if (typeof packed !== 'string') {
    return packed.map((row) => ({
      date: row[0],
      opp: row[1],
      home: row[2] === 1,
      teamPts: row[3],
      oppPts: row[4],
      season: row[5],
      min: row[6],
      pts: row[7],
      reb: row[8],
      ast: row[9],
      tpm: row[10],
      fgm: row[11],
      fga: row[12],
      tpa: row[13],
      ftm: row[14],
      fta: row[15],
      stl: row[16],
      blk: row[17],
      tov: row[18],
      orb: row[19],
      drb: row[20],
      usg: row[21],
    }));
  }
  const trimmed = packed.trim();
  if (!trimmed) return [];
  return trimmed.split(';').map((chunk) => {
    const f = chunk.split(',');
    return {
      date: f[0] ?? '',
      opp: f[1] ?? '',
      home: f[2] === '1',
      teamPts: Number(f[3]),
      oppPts: Number(f[4]),
      season: Number(f[5]),
      min: Number(f[6]),
      pts: Number(f[7]),
      reb: Number(f[8]),
      ast: Number(f[9]),
      tpm: Number(f[10]),
      fgm: Number(f[11]),
      fga: Number(f[12]),
      tpa: Number(f[13]),
      ftm: Number(f[14]),
      fta: Number(f[15]),
      stl: optNum(f[16]),
      blk: optNum(f[17]),
      tov: optNum(f[18]),
      orb: optNum(f[19]),
      drb: optNum(f[20]),
      usg: optNum(f[21]),
    };
  });
}

function parseStintTuple(raw: string): StintRateTuple {
  const nums = raw.split(',').map(Number);
  return [
    nums[0] ?? 0,
    nums[1] ?? 0,
    nums[2] ?? 0,
    nums[3] ?? 0,
    nums[4] ?? 0,
    nums[5] ?? 0,
    nums[6] ?? 0,
  ];
}

export function unpackOnOff(packed: PackedOnOffSummary | PlayerOnOffSummary | null | undefined): PlayerOnOffSummary | null {
  if (!packed) return null;
  if (Array.isArray(packed.overall)) return packed as PlayerOnOffSummary;
  const p = packed as PackedOnOffSummary;
  const rawSplits = Array.isArray(p.splits) ? p.splits : p.splits ? p.splits.split(';') : [];
  return {
    season_label: p.season_label,
    games: p.games,
    overall: parseStintTuple(p.overall),
    splits: rawSplits.map((entry) => {
      const [mateId = '', onRaw = '', offRaw = ''] = entry.split('|');
      return { mate_id: mateId, on: parseStintTuple(onRaw), off: parseStintTuple(offRaw) };
    }),
  };
}

export function unpackRankedPair(raw: string | RankedStat): RankedStat {
  if (Array.isArray(raw)) return raw;
  const [val = '0', rank = '1'] = raw.split(',');
  return [Number(val), Number(rank)];
}

export function unpackTeamAllowed(team: TeamDefenseEntry, key: DefenseStatKey, slot: DefenseSlot): RankedStat {
  const raw = team.allowed[key];
  const idx = DEFENSE_SLOTS.indexOf(slot);
  const part = raw.split('|')[idx >= 0 ? idx : 0] ?? '0,1';
  return unpackRankedPair(part);
}

export function historicalStatValue(row: PlayerGameRow, market: PropMarket): number | null {
  if (market === 'pts') return row.pts;
  if (market === 'reb') return row.reb;
  if (market === 'ast') return row.ast;
  if (market === 'tpm') return row.tpm;
  if (market === 'pra') return row.pts + row.reb + row.ast;
  if (market === 'pa') return row.pts + row.ast;
  if (market === 'pr') return row.pts + row.reb;
  if (market === 'ra') return row.reb + row.ast;
  if (market === 'stl') return row.stl;
  if (market === 'blk') return row.blk;
  if (market === 'tov') return row.tov;
  if (row.stl === null || row.blk === null) return null;
  const doubles = [row.pts, row.reb, row.ast, row.stl, row.blk].filter((val) => val >= 10).length;
  return doubles >= (market === 'dd' ? 2 : 3) ? 1 : 0;
}

export interface HistoricalGrade {
  wins: number;
  losses: number;
  pushes: number;
  decided: number;
  total: number;
  rate: number | null;
}

export function gradeHistoricalSeries(
  rows: readonly PlayerGameRow[],
  market: PropMarket,
  side: PropSide,
  line: number | null,
): HistoricalGrade {
  if (line === null || !Number.isFinite(line) || line < 0 || !Number.isInteger(line * 2)) {
    return { wins: 0, losses: 0, pushes: 0, decided: 0, total: 0, rate: null };
  }
  if ((market === 'dd' || market === 'td') && line !== 0.5) {
    return { wins: 0, losses: 0, pushes: 0, decided: 0, total: 0, rate: null };
  }
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  for (const row of rows) {
    const val = historicalStatValue(row, market);
    if (val === null) continue;
    if (val === line) {
      pushes += 1;
      continue;
    }
    const hit = side === 'over' ? val > line : val < line;
    if (hit) wins += 1;
    else losses += 1;
  }
  const decided = wins + losses;
  return {
    wins,
    losses,
    pushes,
    decided,
    total: decided + pushes,
    rate: decided > 0 ? wins / decided : null,
  };
}

export interface HitWindowSummary {
  key: 'L5' | 'L10' | 'HOME' | 'AWAY' | 'SEASON' | 'H2H';
  label: string;
  grade: HistoricalGrade;
}

export function computeHitWindows(
  rows: readonly PlayerGameRow[],
  market: PropMarket,
  side: PropSide,
  line: number | null,
  activeSeason: number,
  opponentTeamId: string,
  courtRows: readonly PlayerGameRow[] = rows,
): HitWindowSummary[] {
  const valid = rows.filter((row) => historicalStatValue(row, market) !== null);
  const seasonRows = valid.filter((row) => row.season === activeSeason);
  const h2hRows = valid.filter((row) => row.opp === opponentTeamId);
  const court = courtRows.filter((row) => historicalStatValue(row, market) !== null);
  return [
    { key: 'L5', label: 'L5', grade: gradeHistoricalSeries(valid.slice(-5), market, side, line) },
    { key: 'L10', label: 'L10', grade: gradeHistoricalSeries(valid.slice(-10), market, side, line) },
    { key: 'HOME', label: 'Home', grade: gradeHistoricalSeries(court.filter((row) => row.home), market, side, line) },
    { key: 'AWAY', label: 'Away', grade: gradeHistoricalSeries(court.filter((row) => !row.home), market, side, line) },
    { key: 'SEASON', label: 'SEASON', grade: gradeHistoricalSeries(seasonRows, market, side, line) },
    { key: 'H2H', label: 'H2H', grade: gradeHistoricalSeries(h2hRows, market, side, line) },
  ];
}

export function computeStreak(
  rows: readonly PlayerGameRow[],
  market: PropMarket,
  line: number | null,
): { count: number; kind: 'over' | 'under' | 'push' } | null {
  if (line === null || !Number.isFinite(line)) return null;
  let kind: 'over' | 'under' | 'push' | null = null;
  let count = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const val = historicalStatValue(rows[i], market);
    if (val === null) continue;
    const step: 'over' | 'under' | 'push' = val === line ? 'push' : val > line ? 'over' : 'under';
    if (kind === null) {
      kind = step;
      count = 1;
    } else if (step === kind) {
      count += 1;
    } else {
      break;
    }
  }
  return kind ? { count, kind } : null;
}

function meanOf(nums: readonly number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((sum, x) => sum + x, 0) / nums.length;
}

export function medianOf(nums: readonly number[]): number | null {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SupportingStatItem {
  label: string;
  value: string;
  sub?: string;
}

export function computeSupportingStats(
  rows: readonly PlayerGameRow[],
  market: PropMarket,
  mode: 'avg' | 'med',
): SupportingStatItem[] {
  const recent = rows.slice(-20);
  if (!recent.length) return [];
  const agg = mode === 'med' ? medianOf : meanOf;
  const fmt = (nums: readonly (number | null)[], suffix = '') => {
    const clean = nums.filter((v): v is number => v !== null && Number.isFinite(v));
    const res = agg(clean);
    return res === null ? '—' : `${res.toFixed(1)}${suffix}`;
  };
  if (market === 'reb' || market === 'ra' || market === 'pr') {
    const oreb = recent.map((r) => r.orb);
    const dreb = recent.map((r) => r.drb);
    const reb = recent.map((r) => r.reb);
    const orebShare =
      recent.every((r) => r.orb !== null) && recent.reduce((s, r) => s + r.reb, 0) > 0
        ? `${Math.round((recent.reduce((s, r) => s + (r.orb ?? 0), 0) / recent.reduce((s, r) => s + r.reb, 0)) * 100)}% offensive`
        : undefined;
    return [
      { label: 'REB', value: fmt(reb), sub: orebShare },
      { label: 'OREB', value: fmt(oreb) },
      { label: 'DREB', value: fmt(dreb) },
      { label: 'MINUTES', value: fmt(recent.map((r) => r.min)) },
      { label: 'USAGE %', value: fmt(recent.map((r) => r.usg), '%') },
    ];
  }
  if (market === 'ast' || market === 'stl' || market === 'blk' || market === 'tov' || market === 'dd' || market === 'td') {
    return [
      { label: 'AST', value: fmt(recent.map((r) => r.ast)) },
      { label: 'TOV', value: fmt(recent.map((r) => r.tov)) },
      { label: 'STL', value: fmt(recent.map((r) => r.stl)) },
      { label: 'BLK', value: fmt(recent.map((r) => r.blk)) },
      { label: 'MINUTES', value: fmt(recent.map((r) => r.min)) },
      { label: 'USAGE %', value: fmt(recent.map((r) => r.usg), '%') },
    ];
  }
  const fgaSum = recent.reduce((s, r) => s + r.fga, 0);
  const fgmSum = recent.reduce((s, r) => s + r.fgm, 0);
  const fgSub = fgaSum > 0 ? `${((fgmSum / fgaSum) * 100).toFixed(0)}% FG` : undefined;
  return [
    { label: 'FGA', value: fmt(recent.map((r) => r.fga)), sub: fgSub },
    { label: '3PM / 3PA', value: `${fmt(recent.map((r) => r.tpm))} / ${fmt(recent.map((r) => r.tpa))}` },
    { label: 'FTM / FTA', value: `${fmt(recent.map((r) => r.ftm))} / ${fmt(recent.map((r) => r.fta))}` },
    { label: 'MINUTES', value: fmt(recent.map((r) => r.min)) },
    { label: 'USAGE %', value: fmt(recent.map((r) => r.usg), '%') },
  ];
}

export interface PerMinuteSummary {
  sampleGames: number;
  sampleLabel: string;
  usgAvg: number | null;
  usgMed: number | null;
  rate36Avg: number | null;
  rate36Med: number | null;
  minAvg: number | null;
  minMed: number | null;
}

export function computePerMinuteSummary(
  rows: readonly PlayerGameRow[],
  market: PropMarket,
  activeSeason: number,
): PerMinuteSummary | null {
  if (!rows.length) return null;
  const seasonRows = rows.filter((r) => r.season === activeSeason);
  const useSeason = seasonRows.length >= 3;
  const pool = useSeason ? seasonRows : rows.slice(-20);
  const usgs = pool.map((r) => r.usg).filter((v): v is number => v !== null && Number.isFinite(v));
  const rates36 = pool
    .map((r) => {
      const val = historicalStatValue(r, market);
      return val !== null && r.min >= 4 ? (val / r.min) * 36 : null;
    })
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const mins = pool.map((r) => r.min).filter((v) => Number.isFinite(v));
  return {
    sampleGames: pool.length,
    sampleLabel: useSeason ? seasonLabel(activeSeason) : `last ${pool.length}`,
    usgAvg: meanOf(usgs),
    usgMed: medianOf(usgs),
    rate36Avg: meanOf(rates36),
    rate36Med: medianOf(rates36),
    minAvg: meanOf(mins),
    minMed: medianOf(mins),
  };
}

export function marketToDefenseKey(market: PropMarket): DefenseStatKey {
  if (market === 'dd' || market === 'td') return 'pra';
  return market;
}
