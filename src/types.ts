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
}

export interface RateGame {
  event_id: string;
  away_team_id: string;
  home_team_id: string;
  players: RatePlayer[];
}

export interface RateCard {
  schema_version: 1;
  generated_at: string | null;
  date: string | null;
  iterations: number;
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
}

export interface OutcomeRow {
  season: number;
  athlete_id: string;
  team_id: string;
  event_id: string;
  stat_key: string;
  actual: number;
  minutes: number;
}
