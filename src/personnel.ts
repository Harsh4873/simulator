import type { FreeThrowModel } from './free-throw-model.ts';
import type { RatePlayer, TeamProfile } from './types.ts';

export const PERSONNEL_FACTOR_MIN = 0.7;
export const PERSONNEL_FACTOR_MAX = 1.25;
export const REPLACEMENT_HEALTHY_BUFFER = 8;

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const bound = (v: number) => Math.max(0, Math.min(1, v));
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export function impliedPointsPerPossession(
  players: RatePlayer[],
  minutes: number[],
  profile: Pick<TeamProfile, 'turnover_rate' | 'offensive_rebound_rate'>,
  freeThrows: FreeThrowModel | undefined,
  possessions: number,
): number {
  const shots = players.map((x, i) => minutes[i] * x.fga_per_min);
  const fts = players.map((x, i) => minutes[i] * x.fta_per_min);
  const fga = sum(shots);
  const fta = sum(fts);
  const ftModel = freeThrows?.status === 'fitted' ? freeThrows : null;
  const tripMean = ftModel ? 2 * ftModel.trip_weights[0] + 3 * ftModel.trip_weights[1] : 2;
  const andOne = ftModel?.and_one_per_make ?? 0;
  const technical = ftModel?.technical_per_possession ?? 0;
  const retained = ftModel?.retained_per_possession ?? 0;
  const retainedWeights = ftModel?.retained_trip_weights ?? [0, 0, 0];
  const retainedAttempts = retainedWeights.reduce((s, w, i) => s + w * (i + 1), 0) * retained;
  const expectedMakes = sum(
    players.map((x, i) => shots[i] * ((1 - x.tpa_given_fga) * x.fg2_pct + x.tpa_given_fga * x.tp_pct)),
  );
  const ordinaryAttempts = Math.max(0, fta - expectedMakes * andOne - possessions * (technical + retainedAttempts));
  const ftShare = ordinaryAttempts / tripMean / Math.max(1, fga + ordinaryAttempts / tripMean);
  const fgValue =
    sum(
      players.map(
        (x, i) => shots[i] * (2 * (1 - x.tpa_given_fga) * x.fg2_pct + 3 * x.tpa_given_fga * x.tp_pct),
      ),
    ) / Math.max(1, fga);
  const fgPct =
    sum(players.map((x, i) => shots[i] * ((1 - x.tpa_given_fga) * x.fg2_pct + x.tpa_given_fga * x.tp_pct))) /
    Math.max(1, fga);
  const ftPct = sum(players.map((x, i) => fts[i] * x.ft_pct)) / Math.max(1, fta);
  const orb = bound(profile.offensive_rebound_rate);
  const tov = bound(profile.turnover_rate);
  return (
    ((1 - tov) * ((1 - ftShare) * (fgValue + fgPct * andOne * ftPct) + ftShare * tripMean * ftPct) +
      (technical + retainedAttempts) * ftPct) /
    Math.max(0.1, 1 - (1 - tov) * ((1 - ftShare) * (1 - fgPct + fgPct * andOne * (1 - ftPct)) + ftShare * (1 - ftPct)) * orb)
  );
}

export function fullStrengthMinutes(players: RatePlayer[], tonightMinutes: number[]): number[] {
  // The fitted team rating came from the minutes teams actually played, so compare tonight with that lineup.
  // Older cards without typical minutes fall back to role minutes.
  const observed = players.some(p => p.typical_minutes != null && p.typical_minutes > 0);
  const typical = players.map(p => Math.max(0, observed ? p.typical_minutes ?? 0 : p.minutes_mean));
  const budget = sum(tonightMinutes);
  const total = sum(typical);
  if (!(total > 0) || !(budget > 0)) return tonightMinutes.slice();
  return typical.map(m => (m * budget) / total);
}

export function personnelFactor(
  players: RatePlayer[],
  tonightMinutes: number[],
  profile: Pick<TeamProfile, 'turnover_rate' | 'offensive_rebound_rate'>,
  freeThrows: FreeThrowModel | undefined,
  possessions: number,
): number {
  const typicalMinutes = fullStrengthMinutes(players, tonightMinutes);
  const raw = impliedPointsPerPossession(players, tonightMinutes, profile, freeThrows, possessions);
  const typical = impliedPointsPerPossession(players, typicalMinutes, profile, freeThrows, possessions);
  if (!(typical > 0.01) || !(raw > 0)) return 1;
  return Math.min(PERSONNEL_FACTOR_MAX, Math.max(PERSONNEL_FACTOR_MIN, raw / typical));
}

function averageRate(players: RatePlayer[], key: keyof RatePlayer): number | undefined {
  const xs = players.map(p => p[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return xs.length ? mean(xs) : undefined;
}

export function leagueReplacementRates(players: RatePlayer[]): RatePlayer | null {
  const xs = players.filter(
    p => p.replacement_level !== true && p.shooting_games > 0 && p.fga_per_min > 0 && p.fta_per_min > 0,
  );
  if (!xs.length) return null;
  const rate = (key: keyof RatePlayer, fallback = 0) => averageRate(xs, key) ?? fallback;
  return {
    athlete_id: '',
    name: 'Replacement-level',
    team_id: '',
    position: '',
    position_group: '',
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
    games_2026: 0,
    games_2027: 0,
    games: 0,
    shooting_games: 0,
    missing_shooting: false,
    thin_sample: true,
    minutes_mean: 12,
    fga_per_min: rate('fga_per_min'),
    fta_per_min: rate('fta_per_min'),
    tpa_given_fga: rate('tpa_given_fga'),
    fg2_pct: rate('fg2_pct'),
    tp_pct: rate('tp_pct'),
    ft_pct: rate('ft_pct'),
    reb_per_min: rate('reb_per_min'),
    orb_share: averageRate(xs, 'orb_share'),
    ast_per_min: rate('ast_per_min'),
    stl_per_min: averageRate(xs, 'stl_per_min'),
    blk_per_min: averageRate(xs, 'blk_per_min'),
    tov_per_min: averageRate(xs, 'tov_per_min'),
    play_probability: 0,
    starter_rate: 0,
    closing_rate: 0,
    minutes_restriction: null,
    replacement_level: true,
  };
}

export function replacementPlayer(
  teamId: string,
  index: number,
  template: RatePlayer,
  playProbability: number,
  minutesMean: number,
): RatePlayer {
  return {
    ...template,
    athlete_id: `replacement:${teamId}:${index}`,
    name: 'Replacement-level',
    team_id: teamId,
    position: '',
    position_group: '',
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
    games_2026: 0,
    games_2027: 0,
    games: 0,
    shooting_games: 0,
    missing_shooting: false,
    thin_sample: true,
    minutes_mean: minutesMean,
    play_probability: playProbability,
    starter_rate: 0,
    closing_rate: 0,
    minutes_restriction: null,
    replacement_level: true,
    headshot_url: undefined,
    evidence: undefined,
    shooting_posterior: undefined,
    skill_prior: undefined,
    participation_model: undefined,
    role_context: undefined,
    participation_coverage: undefined,
  };
}
