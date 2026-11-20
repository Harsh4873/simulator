/**
 * Completed NFL games from ESPN game summaries: final score, team volume, and every player's passing, rushing and
 * receiving line. Odds objects on the summary are never read.
 */

export interface NflLine {
  id: string;
  name: string;
  pass_cmp: number;
  pass_att: number;
  pass_yds: number;
  pass_td: number;
  int: number;
  car: number;
  rush_yds: number;
  rush_td: number;
  tgt: number;
  rec: number;
  rec_yds: number;
  rec_td: number;
}

export interface NflTeamBox {
  id: string;
  abbr: string;
  points: number;
  drives: number | null;
  pass_att: number;
  rush_att: number;
  pass_yds: number;
  rush_yds: number;
  fg: number;
  players: NflLine[];
}

export interface NflBoxGame {
  id: string;
  start_time: string;
  season: number;
  season_type: number;
  week: number | null;
  neutral: boolean;
  home: NflTeamBox;
  away: NflTeamBox;
}

/** Cached games stay off the site. Rows are arrays to keep the file small. */
export interface NflCache {
  schema_version: 1;
  season: number;
  games: NflCachedGame[];
}

type CachedLine = [string, string, number, number, number, number, number, number, number, number, number, number, number, number];
type CachedTeam = [string, string, number, number | null, number, number, number, number, number, CachedLine[]];

export interface NflCachedGame {
  id: string;
  start_time: string;
  season: number;
  season_type: number;
  week: number | null;
  neutral: boolean;
  home: CachedTeam;
  away: CachedTeam;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** "12/27" or "2-15": the part before the separator, or after it. */
function pair(value: unknown, separator: '/' | '-', side: 0 | 1): number | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(separator);
  return parts.length === 2 ? num(parts[side]) : null;
}

function teamStat(stats: unknown, name: string): unknown {
  if (!Array.isArray(stats)) return null;
  for (const item of stats) {
    const row = record(item);
    if (row?.name === name) return row.displayValue ?? row.value ?? null;
  }
  return null;
}

function emptyLine(id: string, name: string): NflLine {
  return { id, name, pass_cmp: 0, pass_att: 0, pass_yds: 0, pass_td: 0, int: 0, car: 0, rush_yds: 0, rush_td: 0, tgt: 0, rec: 0, rec_yds: 0, rec_td: 0 };
}

/** Reads one team's player categories by key name, so a reordered column cannot shift a value. */
function teamLines(categories: unknown): { lines: NflLine[]; fg: number } {
  const lines = new Map<string, NflLine>();
  let fg = 0;
  if (!Array.isArray(categories)) return { lines: [], fg };
  for (const item of categories) {
    const category = record(item);
    const keys = Array.isArray(category?.keys) ? category.keys.map(String) : [];
    const athletes = Array.isArray(category?.athletes) ? category.athletes : [];
    const name = category?.name;
    for (const entry of athletes) {
      const row = record(entry);
      const athlete = record(row?.athlete);
      const stats = Array.isArray(row?.stats) ? row.stats : [];
      const id = typeof athlete?.id === 'string' ? athlete.id : typeof athlete?.id === 'number' ? String(athlete.id) : null;
      const display = typeof athlete?.displayName === 'string' ? athlete.displayName.trim() : '';
      if (!id || !display) continue;
      const at = (key: string) => {
        const index = keys.indexOf(key);
        return index >= 0 ? stats[index] : null;
      };
      if (name === 'kicking') {
        fg += pair(at('fieldGoalsMade/fieldGoalAttempts'), '/', 0) ?? 0;
        continue;
      }
      if (name !== 'passing' && name !== 'rushing' && name !== 'receiving') continue;
      const line = lines.get(id) ?? emptyLine(id, display);
      if (name === 'passing') {
        line.pass_cmp = pair(at('completions/passingAttempts'), '/', 0) ?? 0;
        line.pass_att = pair(at('completions/passingAttempts'), '/', 1) ?? 0;
        line.pass_yds = num(at('passingYards')) ?? 0;
        line.pass_td = num(at('passingTouchdowns')) ?? 0;
        line.int = num(at('interceptions')) ?? 0;
      } else if (name === 'rushing') {
        line.car = num(at('rushingAttempts')) ?? 0;
        line.rush_yds = num(at('rushingYards')) ?? 0;
        line.rush_td = num(at('rushingTouchdowns')) ?? 0;
      } else {
        line.rec = num(at('receptions')) ?? 0;
        line.rec_yds = num(at('receivingYards')) ?? 0;
        line.rec_td = num(at('receivingTouchdowns')) ?? 0;
        line.tgt = num(at('receivingTargets')) ?? line.rec;
      }
      lines.set(id, line);
    }
  }
  return { lines: [...lines.values()], fg };
}

/** A completed game from an ESPN summary, or null when the game is not final or a side is missing. */
export function parseNflSummary(payload: unknown): NflBoxGame | null {
  const root = record(payload);
  const header = record(root?.header);
  const competition = record(Array.isArray(header?.competitions) ? header.competitions[0] : null);
  const status = record(record(competition?.status)?.type);
  if (!competition || !(status?.completed === true || status?.state === 'post')) return null;
  const id = typeof competition.id === 'string' ? competition.id : typeof header?.id === 'string' ? header.id : null;
  const date = typeof competition.date === 'string' ? competition.date : null;
  if (!id || !date || Number.isNaN(Date.parse(date))) return null;
  const season = record(header?.season);
  const competitors = Array.isArray(competition.competitors) ? competition.competitors.map(record) : [];
  const box = record(root?.boxscore);
  const teamStats = Array.isArray(box?.teams) ? box.teams.map(record) : [];
  const playerGroups = Array.isArray(box?.players) ? box.players.map(record) : [];
  const side = (homeAway: 'home' | 'away'): NflTeamBox | null => {
    const competitor = competitors.find((item) => item?.homeAway === homeAway);
    const team = record(competitor?.team);
    const teamId = team?.id === undefined ? null : String(team.id);
    const abbr = typeof team?.abbreviation === 'string' ? team.abbreviation : null;
    const points = num(competitor?.score);
    if (!teamId || !abbr || points === null) return null;
    const stats = teamStats.find((item) => String(record(item?.team)?.id ?? '') === teamId)?.statistics;
    const players = playerGroups.find((item) => String(record(item?.team)?.id ?? '') === teamId)?.statistics;
    const { lines, fg } = teamLines(players);
    return {
      id: teamId,
      abbr,
      points,
      drives: num(teamStat(stats, 'totalDrives')),
      pass_att: pair(teamStat(stats, 'completionAttempts'), '/', 1) ?? lines.reduce((sum, line) => sum + line.pass_att, 0),
      rush_att: num(teamStat(stats, 'rushingAttempts')) ?? lines.reduce((sum, line) => sum + line.car, 0),
      pass_yds: num(teamStat(stats, 'netPassingYards')) ?? 0,
      rush_yds: num(teamStat(stats, 'rushingYards')) ?? 0,
      fg,
      players: lines,
    };
  };
  const home = side('home');
  const away = side('away');
  if (!home || !away) return null;
  return {
    id,
    start_time: new Date(date).toISOString(),
    season: num(season?.year) ?? new Date(date).getUTCFullYear(),
    season_type: num(season?.type) ?? 2,
    week: num(record(header?.week)?.number) ?? num(header?.week),
    neutral: competition.neutralSite === true,
    home,
    away,
  };
}

function packTeam(team: NflTeamBox): CachedTeam {
  return [
    team.id,
    team.abbr,
    team.points,
    team.drives,
    team.pass_att,
    team.rush_att,
    team.pass_yds,
    team.rush_yds,
    team.fg,
    team.players.map((line) => [line.id, line.name, line.pass_cmp, line.pass_att, line.pass_yds, line.pass_td, line.int, line.car, line.rush_yds, line.rush_td, line.tgt, line.rec, line.rec_yds, line.rec_td]),
  ];
}

function unpackTeam(team: CachedTeam): NflTeamBox {
  const [id, abbr, points, drives, pass_att, rush_att, pass_yds, rush_yds, fg, lines] = team;
  return {
    id,
    abbr,
    points,
    drives,
    pass_att,
    rush_att,
    pass_yds,
    rush_yds,
    fg,
    players: lines.map(([lineId, name, pass_cmp, att, pyds, ptd, int, car, ryds, rtd, tgt, rec, recYds, recTd]) => ({
      id: lineId,
      name,
      pass_cmp,
      pass_att: att,
      pass_yds: pyds,
      pass_td: ptd,
      int,
      car,
      rush_yds: ryds,
      rush_td: rtd,
      tgt,
      rec,
      rec_yds: recYds,
      rec_td: recTd,
    })),
  };
}

export function packGame(game: NflBoxGame): NflCachedGame {
  return { id: game.id, start_time: game.start_time, season: game.season, season_type: game.season_type, week: game.week, neutral: game.neutral, home: packTeam(game.home), away: packTeam(game.away) };
}

export function unpackGame(game: NflCachedGame): NflBoxGame {
  return { id: game.id, start_time: game.start_time, season: game.season, season_type: game.season_type, week: game.week, neutral: game.neutral, home: unpackTeam(game.home), away: unpackTeam(game.away) };
}

/** A cache file that does not parse is treated as empty, so the next run rebuilds it. */
export function parseNflCache(text: string): NflCache | null {
  try {
    const value = JSON.parse(text) as NflCache;
    if (value?.schema_version !== 1 || !Number.isInteger(value.season) || !Array.isArray(value.games)) return null;
    for (const game of value.games) {
      if (typeof game?.id !== 'string' || !Array.isArray(game.home) || !Array.isArray(game.away) || Number.isNaN(Date.parse(game.start_time))) return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function serializeNflCache(cache: NflCache): string {
  const games = [...cache.games].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  return `{"schema_version":1,"season":${cache.season},"games":[\n${games.map((game) => JSON.stringify(game)).join(',\n')}\n]}\n`;
}
