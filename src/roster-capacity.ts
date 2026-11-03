import type { RateGame, RatePlayer } from './types.ts';

export class InsufficientRosterError extends Error {
  readonly code = 'INSUFFICIENT_ELIGIBLE_ROSTER';
  readonly teamId: string;
  constructor(teamId: string) {
    super(`Simulation unavailable for team ${teamId}: fewer than five eligible players remain.`);
    this.name = 'InsufficientRosterError';
    this.teamId = teamId;
  }
}

export function availablePlayer(player: Pick<RatePlayer, 'minutes_weight' | 'injury_status'>): boolean {
  return player.minutes_weight === 1 && !/^(out\b|injured\b|inactive\b|suspended\b)/i.test(player.injury_status);
}

export function healthyReserve(player: Pick<RatePlayer, 'minutes_weight' | 'injury_status'>): boolean {
  return availablePlayer(player) && player.injury_status === 'healthy';
}

export function rosterIssue(game: RateGame): InsufficientRosterError | null {
  for (const team of [game.away_team_id, game.home_team_id]) {
    const eligible = game.players.filter(p => p.team_id === team && availablePlayer(p) && ((p.play_probability ?? 1) > 0 || healthyReserve(p)));
    if (eligible.length < 5) return new InsufficientRosterError(team);
  }
  return null;
}

/** Preserve ordinary caps exactly; spread a shortfall across remaining physical capacity. */
export function relaxMinuteCaps(caps: number[], maximums: number[], budget: number, teamId: string): number[] {
  const capacity = caps.reduce((sum, cap) => sum + cap, 0);
  if (capacity >= budget) return caps;
  const maximum = maximums.reduce((sum, cap) => sum + cap, 0);
  if (maximum < budget) throw new InsufficientRosterError(teamId);
  const fraction = (budget - capacity) / (maximum - capacity);
  return caps.map((cap, i) => Math.min(maximums[i], Math.ceil(cap + (maximums[i] - cap) * fraction)));
}
