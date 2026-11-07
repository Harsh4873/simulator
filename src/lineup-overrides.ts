import { validateGame } from './validate-card.ts';
import type { RateGame, RatePlayer } from './types.ts';

/** The viewer's own availability calls for one game. Missing athletes follow the model. */
export type LineupOverrides = Record<string, 'in' | 'out'>;
export type LineupChoice = 'auto' | 'in' | 'out';

export const LINEUP_STORAGE_KEY = 'simulator.lineups';

export function isLineupChoice(value: string | undefined): value is LineupChoice {
  return value === 'auto' || value === 'in' || value === 'out';
}

function forced(player: RatePlayer, choice: 'in' | 'out'): RatePlayer {
  if (choice === 'out') {
    return { ...player, minutes_weight: 0, injury_status: 'out (your call)', questionable_widen: false, play_probability: 0, manual_status: 'out' };
  }
  // A player ruled in plays every simulation at his role minutes; any reported minute restriction still applies.
  return {
    ...player,
    minutes_weight: 1,
    injury_status: 'healthy',
    questionable_widen: false,
    play_probability: 1,
    minutes_mean: player.minutes_mean > 0 ? player.minutes_mean : 12,
    manual_status: 'in',
  };
}

/** Returns a copy of the game with the viewer's calls applied. Replacement-level fill-ins are never edited. */
export function applyLineupOverrides(game: RateGame, overrides: LineupOverrides | undefined): RateGame {
  if (!overrides || !Object.keys(overrides).length) return game;
  // A stored roster error described the published lineup; validation recomputes it for the edited one.
  const { simulation_error: _published, ...rest } = game;
  return {
    ...rest,
    players: game.players.map((player) => {
      const choice = overrides[player.athlete_id];
      return choice && !player.replacement_level ? forced(player, choice) : player;
    }),
  };
}

/** Drops calls for athletes no longer on this game's card. */
export function cleanOverrides(game: RateGame, overrides: LineupOverrides | undefined): LineupOverrides {
  const ids = new Set(game.players.filter((p) => !p.replacement_level).map((p) => p.athlete_id));
  const out: LineupOverrides = {};
  for (const [id, choice] of Object.entries(overrides ?? {})) if (ids.has(id) && (choice === 'in' || choice === 'out')) out[id] = choice;
  return out;
}

/** Stable text for cache keys: the same calls in any order give the same key. */
export function overridesKey(overrides: LineupOverrides | undefined): string {
  return Object.entries(overrides ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, choice]) => `${id}=${choice}`)
    .join(',');
}

export function lineupIssue(game: RateGame, overrides: LineupOverrides | undefined): string | null {
  try {
    validateGame(applyLineupOverrides(game, overrides));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'These lineups cannot be simulated.';
  }
}

export interface LineupSummary {
  ruledOut: string[];
  ruledIn: string[];
}

export function summarizeOverrides(game: RateGame, overrides: LineupOverrides | undefined): LineupSummary {
  const name = (id: string) => game.players.find((p) => p.athlete_id === id)?.name ?? id;
  const entries = Object.entries(cleanOverrides(game, overrides));
  return {
    ruledOut: entries.filter(([, c]) => c === 'out').map(([id]) => name(id)),
    ruledIn: entries.filter(([, c]) => c === 'in').map(([id]) => name(id)),
  };
}

/** Per-viewer convenience only: unreadable or blocked storage simply starts empty. */
export function readStoredLineups(raw: string | null, eventIds: readonly string[]): Record<string, LineupOverrides> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const keep = new Set(eventIds);
    const out: Record<string, LineupOverrides> = {};
    for (const [eventId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!keep.has(eventId) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const calls: LineupOverrides = {};
      for (const [id, choice] of Object.entries(value as Record<string, unknown>)) if (choice === 'in' || choice === 'out') calls[id] = choice;
      if (Object.keys(calls).length) out[eventId] = calls;
    }
    return out;
  } catch {
    return {};
  }
}
