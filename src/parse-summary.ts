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
  if (!Number.isFinite(made) || !Number.isFinite(attempts)) return null;
  return [made, attempts];
}

function statNumber(text: string): number | null {
  const raw = text.trim();
  if (!raw || raw === '--') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function statMinutes(text: string): number | null {
  const raw = text.trim();
  if (!raw || raw === '--' || raw.toUpperCase() === 'DNP') return null;
  if (raw.includes(':')) {
    const [minutesText, secondsText] = raw.split(':');
    const minutes = Number(minutesText);
    const seconds = Number(secondsText);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
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
  if (!(tpm <= tpa && tpa <= fga && fgm <= fga && ftm <= fta && tpm <= fgm)) return null;
  const expected = 2 * (fgm - tpm) + 3 * tpm + ftm;
  if (Math.abs(expected - points) > 1e-6) return null;
  return {
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
