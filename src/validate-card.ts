import { chicagoDate } from './date.ts';
import type { RateCard, RateGame, Slate } from './types.ts';

export function validateGame(game: RateGame): void {
  if (!game.event_id || !game.away_team_id || !game.home_team_id || game.away_team_id === game.home_team_id) throw new Error('Invalid matchup');
  if (!Array.isArray(game.players)) throw new Error('Missing roster');
  const ids = new Set<string>();
  for (const p of game.players) {
    if (!p.athlete_id || ids.has(p.athlete_id)) throw new Error('Duplicate athlete membership');
    ids.add(p.athlete_id);
    if (![game.away_team_id, game.home_team_id].includes(p.team_id)) throw new Error('Player team mismatch');
    for (const key of ['minutes_mean', 'fga_per_min', 'fta_per_min', 'reb_per_min', 'ast_per_min', 'games', 'shooting_games'] as const) {
      if (!Number.isFinite(p[key]) || p[key] < 0) throw new Error(`Invalid ${key}`);
    }
    for (const key of ['tpa_given_fga', 'fg2_pct', 'tp_pct', 'ft_pct'] as const) {
      if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1) throw new Error(`Invalid ${key}`);
    }
    if(p.play_probability !== undefined && (!Number.isFinite(p.play_probability)||p.play_probability<0||p.play_probability>1))throw new Error('Invalid participation probability');
    if (p.minutes_weight !== 0 && p.minutes_weight !== 1) throw new Error('Unknown availability');
  }
  if(game.context){
    const c=game.context;
    if(!Number.isFinite(c.league_efficiency)||c.league_efficiency<=0||!Number.isFinite(c.pace_sd)||c.pace_sd<0||!Number.isFinite(c.home_log_advantage))throw new Error('Invalid matchup model');
    for(const p of [c.away,c.home]){
      for(const key of ['pace','offense','defense'] as const)if(!Number.isFinite(p[key])||p[key]<=0)throw new Error('Invalid team profile');
      for(const key of ['turnover_rate','offensive_rebound_rate','assist_rate'] as const)if(!Number.isFinite(p[key])||p[key]<0||p[key]>=1)throw new Error('Invalid team probability');
    }
  }
  for (const team of [game.away_team_id, game.home_team_id]) {
    const active = game.players.filter(p => p.team_id === team && p.minutes_weight === 1 && (p.play_probability ?? 1)>0);
    const capacity = active.reduce((n, p) => n + (p.shooting_games === 0 && (p.games < 3 || (p.games_2027 === 0 && p.games_2026 < 20)) ? 12 : 48), 0);
    if (active.filter(p => !(p.shooting_games === 0 && (p.games < 3 || (p.games_2027 === 0 && p.games_2026 < 20)))).length < 5 || capacity < 240) throw new Error(`Insufficient active roster: ${team}`);
    if (!active.some(p => p.shooting_games > 0 && p.fga_per_min > 0 && p.fta_per_min > 0)) throw new Error(`Missing shooting coverage: ${team}`);
  }
}

export function validateGeneration(slate: Slate, card: RateCard): void {
  if (slate?.schema_version !== 1 || card?.schema_version !== 1 || !Array.isArray(slate.games) || !Array.isArray(card.games)) throw new Error('Invalid data schema');
  if (!slate.generated_at || !Number.isFinite(Date.parse(slate.generated_at)) || slate.generated_at !== card.generated_at || slate.date !== card.date) throw new Error('Mismatched data generations');
  if (slate.timezone !== 'America/Chicago' || card.iterations !== 10000 || !Array.isArray(card.columns)) throw new Error('Invalid simulation contract');
  if (slate.games.length !== card.games.length || new Set(card.games.map(g => g.event_id)).size !== card.games.length || new Set(slate.games.map(g => g.event_id)).size !== slate.games.length) throw new Error('Incomplete slate coverage');
  const memberships = new Map<string, string>();
  for (const g of slate.games) {
    if (g.date !== slate.date || !Number.isFinite(Date.parse(g.start_time))) throw new Error('Invalid game date');
    const r = card.games.find(x => x.event_id === g.event_id);
    if (!r || r.away_team_id !== g.away.team_id || r.home_team_id !== g.home.team_id) throw new Error('Slate team mismatch');
    validateGame(r);
    for (const p of r.players) {
      if (memberships.has(p.athlete_id) && memberships.get(p.athlete_id) !== p.team_id) throw new Error('Cross-team athlete membership');
      memberships.set(p.athlete_id, p.team_id);
    }
  }
}

// Operational expiry policy, not an assertion that injury information remains valid until expiry.
export const MAX_CARD_AGE_MS = 6 * 60 * 60 * 1000;
export function freshnessIssue(slate: Slate, card: RateCard, now: Date): string | null {
  try { validateGeneration(slate, card); } catch (e) { return e instanceof Error ? e.message : 'Invalid data'; }
  const age = now.getTime() - Date.parse(card.generated_at!);
  if (card.date !== chicagoDate(now) || age > MAX_CARD_AGE_MS || age < -300_000) return 'Stale data: wait for a fresh rate card';
  return null;
}
