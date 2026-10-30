export interface ParsedPlayerGame {
  athlete_id: string;
  team_id: string;
  minutes: number;
  fgm: number;
  fga: number;
  tpm: number;
  tpa: number;
  ftm: number;
  fta: number;
  reb: number;
  ast: number;
  pts: number;
  stl?: number;
  blk?: number;
  tov?: number;
  orb?: number;
  drb?: number;
  starter?: boolean;
  fouls?: number;
}

const FG_KEY = 'fieldGoalsMade-fieldGoalsAttempted';
const TP_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
const FT_KEY = 'freeThrowsMade-freeThrowsAttempted';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitMadeAttempted(text: string): [number, number] | null {
  const raw = text.trim();
  const dash = raw.indexOf('-');
  if (dash <= 0) return null;
  const made = Number(raw.slice(0, dash));
  const attempts = Number(raw.slice(dash + 1));
  if (!Number.isInteger(made) || !Number.isInteger(attempts) || made < 0 || attempts < 0) return null;
  return [made, attempts];
}

function statNumber(text: string): number | null {
  const raw = text.trim();
  if (!raw || raw === '--') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function statMinutes(text: string): number | null {
  const raw = text.trim();
  if (!raw || raw === '--' || raw.toUpperCase() === 'DNP') return null;
  if (raw.includes(':')) {
    const [minutesText, secondsText] = raw.split(':');
    const minutes = Number(minutesText);
    const seconds = Number(secondsText);
    if (!Number.isInteger(minutes) || minutes < 0 || !Number.isInteger(seconds) || seconds < 0 || seconds >= 60) return null;
    const total = minutes + seconds / 60;
    return total > 0 ? total : null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function categoryWithKeys(team: Record<string, unknown>): { keys: string[]; athletes: unknown[] } | null {
  const statistics = Array.isArray(team.statistics) ? team.statistics : [];
  for (const category of statistics) {
    if (!isRecord(category) || !Array.isArray(category.keys)) continue;
    const keys = category.keys.map((key) => String(key));
    if (!keys.includes(FG_KEY) || !keys.includes(TP_KEY) || !keys.includes(FT_KEY)) continue;
    return {
      keys,
      athletes: Array.isArray(category.athletes) ? category.athletes : [],
    };
  }
  return null;
}

function parseAthlete(teamId: string, keys: string[], row: unknown): ParsedPlayerGame | null {
  if (!isRecord(row) || row.didNotPlay === true) return null;
  const athlete = isRecord(row.athlete) ? row.athlete : {};
  const athleteId = String(athlete.id ?? '').trim();
  const stats = Array.isArray(row.stats) ? row.stats.map((value) => String(value ?? '')) : [];
  if (!athleteId || stats.length < keys.length) return null;
  const at = (key: string) => {
    const index = keys.indexOf(key);
    return index >= 0 ? stats[index] ?? '' : '';
  };
  const minutes = statMinutes(at('minutes'));
  if (minutes === null) return null;
  const fieldGoals = splitMadeAttempted(at(FG_KEY));
  const threes = splitMadeAttempted(at(TP_KEY));
  const freeThrows = splitMadeAttempted(at(FT_KEY));
  const points = statNumber(at('points'));
  const rebounds = statNumber(at('rebounds'));
  const assists = statNumber(at('assists'));
  if (!fieldGoals || !threes || !freeThrows || points === null || rebounds === null || assists === null) return null;
  const [fgm, fga] = fieldGoals;
  const [tpm, tpa] = threes;
  const [ftm, fta] = freeThrows;
  if (!(tpm <= tpa && tpa <= fga && fgm <= fga && ftm <= fta && tpm <= fgm && fgm - tpm <= fga - tpa)) return null;
  const expected = 2 * (fgm - tpm) + 3 * tpm + ftm;
  if (Math.abs(expected - points) > 1e-6) return null;
  const extra: Partial<ParsedPlayerGame> = {};
  for (const [key, column] of [['stl','steals'],['blk','blocks'],['tov','turnovers'],['orb','offensiveRebounds'],['drb','defensiveRebounds'],['fouls','fouls']] as const) {
    if (keys.includes(column)) {
      const v = statNumber(at(column));
      if (v === null) return null;
      extra[key] = v;
    }
  }
  if (extra.orb !== undefined && extra.drb !== undefined && extra.orb + extra.drb !== rebounds) return null;
  return {
    ...extra,
    ...(typeof row.starter==='boolean'?{starter:row.starter}:{}),
    athlete_id: athleteId,
    team_id: teamId,
    minutes,
    fgm,
    fga,
    tpm,
    tpa,
    ftm,
    fta,
    reb: rebounds,
    ast: assists,
    pts: points,
  };
}

export function parseSummary(summary: unknown): ParsedPlayerGame[] {
  const root = isRecord(summary) ? summary : {};
  const boxscore = isRecord(root.boxscore) ? root.boxscore : {};
  const teams = Array.isArray(boxscore.players) ? boxscore.players : [];
  const rows: ParsedPlayerGame[] = [];
  for (const team of teams) {
    if (!isRecord(team)) return [];
    const category = categoryWithKeys(team);
    if (!category) return [];
    const teamRecord = isRecord(team.team) ? team.team : {};
    const teamId = String(teamRecord.id ?? '').trim();
    if (!teamId) continue;
    for (const athlete of category.athletes) {
      const parsed = parseAthlete(teamId, category.keys, athlete);
      if (parsed) rows.push(parsed);
    }
  }
  return rows;
}

export interface CompletedEvent {
  event_id: string;
  start_time: string;
  season: number;
  season_type: number;
  neutral: boolean;
  periods: number;
  home_team_id: string;
  away_team_id: string;
  home_pts: number;
  away_pts: number;
  players: ParsedPlayerGame[];
  participation?: {athlete_id:string;team_id:string;played:boolean;starter:boolean|null}[];
}

/** Only complete, reconciled final NBA boxes may enter the event cache. */
export function parseCompletedSummary(summary: unknown, expectedId: string): CompletedEvent {
  const root = isRecord(summary) ? summary : {};
  const header = isRecord(root.header) ? root.header : {};
  const season = isRecord(header.season) ? header.season : {};
  const comps = Array.isArray(header.competitions) ? header.competitions : [];
  const comp = isRecord(comps[0]) ? comps[0] : {};
  const status = isRecord(comp.status) ? comp.status : {};
  const type = isRecord(status.type) ? status.type : {};
  const firstCompetitor = Array.isArray(comp.competitors) && isRecord(comp.competitors[0]) ? comp.competitors[0] : {};
  const periods = Number(status.period ?? (Array.isArray(firstCompetitor.linescores) ? firstCompetitor.linescores.length : NaN));
  if (String(header.id) !== expectedId || type.completed !== true || type.state !== 'post' || !Number.isInteger(periods) || periods < 4) throw new Error('Summary is not a final regulation-format game');
  const start = String(comp.date ?? '');
  if (!Number.isFinite(Date.parse(start)) || ![2026, 2027].includes(Number(season.year)) || ![1, 2, 3, 5].includes(Number(season.type))) throw new Error('Unknown summary competition');
  const competitors = Array.isArray(comp.competitors) ? comp.competitors.filter(isRecord) : [];
  const home = competitors.find(c => c.homeAway === 'home');
  const away = competitors.find(c => c.homeAway === 'away');
  if (!home || !away || competitors.length !== 2 || home.id === away.id) throw new Error('Missing summary opponents');
  if(Number(home.score)===Number(away.score))throw new Error('A completed NBA game cannot be tied');
  if(competitors.some(c=>Array.isArray(c.linescores)&&c.linescores.length!==periods))throw new Error('Incomplete period scores');
  const box = isRecord(root.boxscore) ? root.boxscore : {};
  const teams = Array.isArray(box.players) ? box.players : [];
  if (teams.length !== 2) throw new Error('Incomplete summary teams');
  const players = parseSummary(summary);
  const seen = new Set<string>();
  for (const team of teams) {
    if (!isRecord(team)) throw new Error('Invalid summary team');
    const category = categoryWithKeys(team);
    if (!category) throw new Error('Missing stat columns');
    for (const item of category.athletes) {
      if (!isRecord(item) || item.didNotPlay === true) continue;
      const stats = Array.isArray(item.stats) ? item.stats : [];
      const mins = String(stats[category.keys.indexOf('minutes')] ?? '');
      if (mins === '0' || mins === '0:00') continue;
      const athlete = isRecord(item.athlete) ? item.athlete : {};
      if (!players.some(p => p.athlete_id === String(athlete.id))) throw new Error('Invalid played athlete row');
    }
  }
  for (const p of players) {
    if (seen.has(p.athlete_id) || ![String(home.id), String(away.id)].includes(p.team_id)) throw new Error('Duplicate or foreign athlete');
    seen.add(p.athlete_id);
  }
  for (const c of [home, away]) {
    const rows = players.filter(p => p.team_id === String(c.id));
    const score = Number(c.score);
    if (rows.length < 5 || !Number.isInteger(score) || score < 0 || rows.reduce((s,p) => s+p.pts,0) !== score) throw new Error('Incomplete player scoring');
    const duration = 48 + (periods - 4) * 5;
    if (Math.abs(rows.reduce((s,p) => s+p.minutes,0) - duration * 5) > rows.length / 2 + 1 || rows.some(p => p.minutes > duration)) throw new Error('Incomplete player minutes');
  }
  const participation:NonNullable<CompletedEvent['participation']>=[];
  for(const team of teams){
    if(!isRecord(team))continue;
    const teamId=String((isRecord(team.team)?team.team:{}).id??'');
    for(const row of categoryWithKeys(team)?.athletes??[]){
      if(!isRecord(row)||!isRecord(row.athlete))continue;
      const id=String(row.athlete.id??'');
      const played=players.some(p=>p.athlete_id===id&&p.team_id===teamId);
      // Only explicit DNPs or validated participants; omission is unknown, never a DNP.
      if(id&&(played||row.didNotPlay===true))participation.push({athlete_id:id,team_id:teamId,played,starter:typeof row.starter==='boolean'?row.starter:null});
    }
  }
  return { participation, event_id: expectedId, start_time: start, season: Number(season.year), season_type: Number(season.type), neutral: comp.neutralSite === true, periods, home_team_id: String(home.id), away_team_id: String(away.id), home_pts: Number(home.score), away_pts: Number(away.score), players };
}
