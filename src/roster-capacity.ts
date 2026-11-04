import { leagueReplacementRates, replacementPlayer, REPLACEMENT_HEALTHY_BUFFER } from './personnel.ts';
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

function teamPlayers(game: RateGame, team: string): RatePlayer[] {
  return game.players.filter(p => p.team_id === team);
}

function eligibleCount(players: RatePlayer[]): number {
  return players.filter(p => availablePlayer(p) && ((p.play_probability ?? 1) > 0 || healthyReserve(p))).length;
}

function healthyCount(players: RatePlayer[]): number {
  return players.filter(healthyReserve).length;
}

/** Fill a thin rotation from remaining roster spots, then labelled replacement-level league rates. */
export function fillThinRoster(game: RateGame): RateGame {
  const listed = [game.away_team_id, game.home_team_id];
  if (listed.some(team => teamPlayers(game, team).length === 0)) return game;
  const template = leagueReplacementRates(game.players);
  if (!template) return game;
  let players = [...game.players];
  let added = false;
  for (const team of listed) {
    const next = () => players.filter(p => p.team_id === team);
    let replacements = next().filter(p => p.replacement_level).length;
    while (eligibleCount(next()) < 5 || healthyCount(next()) < REPLACEMENT_HEALTHY_BUFFER) {
      if (replacements >= REPLACEMENT_HEALTHY_BUFFER) break;
      const startersNeeded = Math.max(0, 5 - eligibleCount(next()));
      const play = startersNeeded > 0 ? 1 : 0;
      players.push(replacementPlayer(team, replacements, template, play, play ? 16 : 8));
      replacements++;
      added = true;
    }
  }
  if (!added) return game;
  return { ...game, players, thin_rotation: true };
}

export function rosterIssue(game: RateGame): InsufficientRosterError | null {
  const filled = fillThinRoster(game);
  for (const team of [filled.away_team_id, filled.home_team_id]) {
    if (teamPlayers(game, team).length === 0) return new InsufficientRosterError(team);
    const eligible = filled.players.filter(p => p.team_id === team && availablePlayer(p) && ((p.play_probability ?? 1) > 0 || healthyReserve(p)));
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
