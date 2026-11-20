/** Glickman's worked-example system constant. It is not fit on this slate. */
export const GLICKO_TAU = 0.5;

/**
 * Active Duty pool as of the July 8, 2026 Cache swap. Display order only.
 * A map result on any other map is still kept.
 */
export const MAP_POOL = {
  version: 'cs2-active-duty-2026-09-27',
  effective: '2026-07-08',
  maps: ['Ancient', 'Anubis', 'Cache', 'Dust II', 'Inferno', 'Mirage', 'Nuke'],
} as const;

/** A prior-only rating is not a projection. Both teams need this many tier-1 maps. */
export const MIN_TIER1_MAPS = 3;

export const LIQUIPEDIA_GAP_MS = 2500;
export const LIQUIPEDIA_USER_AGENT = 'harsh.bet-simulator/1.0 (github.com/Harsh4873/simulator; schedule reader)';
