import type { PlayerEvidence, CalibrationArtifact, UnavailableFeature } from './model-evidence.ts';
import type { CompletedEvent } from './parse-summary.ts';

export type SeasonType = 'preseason' | 'regular' | 'postseason' | 'offseason' | 'play-in';

export type PositionGroup = '' | 'Guard' | 'Forward' | 'Center';

export type ColumnKey =
  | 'min'
  | 'fgm'
  | 'fga'
  | 'tpm'
  | 'tpa'
  | 'ftm'
  | 'fta'
  | 'pts'
  | 'reb'
  | 'ast';

export interface TeamSide {
  team_id: string;
  name: string;
  abbreviation: string;
  logo_url?: string;
}

export interface SlateGame {
  event_id: string;
  date: string;
  start_time: string;
  season: number;
  season_type: SeasonType | null;
  status_state: string;
  completed: boolean | null;
  away: TeamSide;
  home: TeamSide;
  spread_caption: string | null;
  neutral_site?: boolean;
  venue?:import('./schedule-context.ts').Venue;
}

export interface Slate {
  schema_version: 1;
  generated_at: string | null;
  date: string | null;
  timezone: 'America/Chicago';
  games: SlateGame[];
}

export interface RatePlayer {
  athlete_id: string;
  name: string;
  team_id: string;
  position: string;
  position_group: PositionGroup;
  injury_status: string;
  minutes_weight: 0 | 1;
  questionable_widen: boolean;
  games_2026: number;
  games_2027: number;
  games: number;
  shooting_games: number;
  missing_shooting?: boolean;
  thin_sample: boolean;
  minutes_mean: number;
  fga_per_min: number;
  fta_per_min: number;
  tpa_given_fga: number;
  fg2_pct: number;
  tp_pct: number;
  ft_pct: number;
  reb_per_min: number;
  ast_per_min: number;
  headshot_url?: string;
  team_games?: number;
  current_team_games?: number;
  play_probability?: number;
  stl_per_min?: number;
  blk_per_min?: number;
  tov_per_min?: number;
  orb_share?: number;
  minutes_source?: string;
  model_version?: string;
  as_of?: string;
  calibration?: CalibrationArtifact | null;
  active_season?: number;
  role_prior_games?: number;
  points_scale?: number;
  shooting_posterior?:Partial<Record<'share'|'fg2'|'tp'|'ft',[number,number]>>;
  skill_prior?:{source:string;role:string;strengths:Record<string,number>;older_history:string};
  evidence?: PlayerEvidence;
  injury_reported_at?: string | null;
  minutes_restriction?: number | null;
  starter_rate?: number | null;
  closing_rate?: number | null;
  minutes_residual_sd?:number|null;
  participation_model?: import('./participation-model.ts').ParticipationFit & {applied:boolean};
  role_context?:{window:number;half_life:number|null;team_changed:boolean;return_from_injury:'unknown'|'observed'};
  participation_coverage?: {known:number;unknown:number;source:"explicit-DNP"|"scenario-prior"};
  availability_calibration_n?:number;
}

export interface RateGame {
  event_id: string;
  away_team_id: string;
  home_team_id: string;
  players: RatePlayer[];
  context?: MatchupContext;
}

export interface RateCard {
  schema_version: 1;
  generated_at: string | null;
  date: string | null;
  iterations: number;
  model_version?: string;
  source_cutoff?: string;
  input_hash?: string;
  generator_sha?: string;
  model_hash?: string;
  calibration?: CalibrationArtifact | null;
  unavailable_features?: UnavailableFeature[];
  coverage?:{team_id:string;regular_games:number;current_season_games:number;play_history_games:number;latest_completed_start:string|null;players_without_shooting:number}[];
  columns: ColumnKey[];
  games: RateGame[];
}

export interface ShootingRow {
  athlete_id: string;
  team_id: string;
  season: number;
  games: number;
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

export interface ShootingCache {
  schema_version: 1;
  fetched_event_ids: string[];
  rows: ShootingRow[];
  events?: CompletedEvent[];
  retries?: Record<string, import("./event-cache.ts").RetryRecord>;
}

export interface OutcomeRow {
  event_date?: string;
  season: number;
  athlete_id: string;
  team_id: string;
  event_id: string;
  stat_key: string;
  actual: number;
  minutes: number;
}

export interface TeamProfile {
  pace: number;
  offense: number;
  defense: number;
  turnover_rate: number;
  offensive_rebound_rate: number;
  assist_rate: number;
  ft_trip_rate: number;
  games: number;
  rest_days: number | null;
  schedule?:import('./schedule-context.ts').ScheduleContext;
}
export interface MatchupContext {
  away: TeamProfile;
  home: TeamProfile;
  league_efficiency: number;
  pace_sd: number;
  home_log_advantage: number;
  neutral: boolean;
  training_games: number;
  rest_coefficient?: number;
  workload_coefficient?:number;
  travel_coefficient?:number|null;
  timezone_coefficient?:number|null;
  usage_effects?:import('./usage-effects.ts').UsageEffects;
  lineup_effects?:import('./lineup-effects.ts').LineupEffects;
  free_throws?:import('./free-throw-model.ts').FreeThrowModel;
}
