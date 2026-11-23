/** Most-points / most-rebounds / most-assists in a game, from the same joint draws as the box score. */

export const LEADER_STATS = ['pts', 'reb', 'ast'] as const;
export type LeaderStat = (typeof LEADER_STATS)[number];

export interface LeaderLine {
  athlete_id: string;
  name: string;
  team_id: string;
  min: number;
  pts: number;
  reb: number;
  ast: number;
  replacement_level?: true;
}

export interface LeaderTally {
  athlete_id: string;
  name: string;
  team_id: string;
  /** All-draw mean of the counting stat, DNPs as zero. Display only; ranking does not use it. */
  mean: number;
  sole: number;
  tied: number;
}

export interface GameLeaders {
  draws: number;
  pts: LeaderTally[];
  reb: LeaderTally[];
  ast: LeaderTally[];
}

interface LeaderRow {
  name: string;
  team_id: string;
  pts: number;
  reb: number;
  ast: number;
  sole: Record<LeaderStat, number>;
  tied: Record<LeaderStat, number>;
}

export type LeaderAccumulator = Map<string, LeaderRow>;

function blankCounts(): Record<LeaderStat, number> {
  return { pts: 0, reb: 0, ast: 0 };
}

export function createLeaderAccumulator(players: readonly Pick<LeaderLine, 'athlete_id' | 'name' | 'team_id' | 'replacement_level'>[]): LeaderAccumulator {
  const acc: LeaderAccumulator = new Map();
  for (const player of players) {
    if (player.replacement_level || acc.has(player.athlete_id)) continue;
    acc.set(player.athlete_id, {
      name: player.name,
      team_id: player.team_id,
      pts: 0,
      reb: 0,
      ast: 0,
      sole: blankCounts(),
      tied: blankCounts(),
    });
  }
  return acc;
}

/**
 * One simulated game: every player who played on either team is a candidate. Ties are dead heats, not wins.
 * Labelled replacement-level fill-ins are not candidates.
 */
export function recordGameLeaders(lines: readonly LeaderLine[], acc: LeaderAccumulator): void {
  for (const player of lines) {
    const row = acc.get(player.athlete_id);
    if (!row || player.replacement_level) continue;
    row.pts += player.pts;
    row.reb += player.reb;
    row.ast += player.ast;
  }
  const played = lines.filter(player => player.min > 0 && !player.replacement_level && acc.has(player.athlete_id));
  if (!played.length) return;
  for (const stat of LEADER_STATS) {
    let best = -Infinity;
    for (const player of played) if (player[stat] > best) best = player[stat];
    const winners = played.filter(player => player[stat] === best);
    const tied = winners.length > 1;
    for (const player of winners) {
      const row = acc.get(player.athlete_id);
      if (!row) continue;
      if (tied) row.tied[stat] += 1;
      else row.sole[stat] += 1;
    }
  }
}

export function leaderScore(row: Pick<LeaderTally, 'sole' | 'tied'>, draws: number): number {
  if (!(draws > 0)) return 0;
  return (row.sole + 0.5 * row.tied) / draws;
}

function rankStat(acc: LeaderAccumulator, stat: LeaderStat, draws: number): LeaderTally[] {
  const rows: LeaderTally[] = [];
  for (const [athlete_id, row] of acc) {
    rows.push({
      athlete_id,
      name: row.name,
      team_id: row.team_id,
      mean: draws > 0 ? row[stat] / draws : 0,
      sole: row.sole[stat],
      tied: row.tied[stat],
    });
  }
  rows.sort(
    (a, b) =>
      leaderScore(b, draws) - leaderScore(a, draws) ||
      b.sole - a.sole ||
      a.name.localeCompare(b.name) ||
      a.athlete_id.localeCompare(b.athlete_id),
  );
  return rows;
}

export function finalizeGameLeaders(acc: LeaderAccumulator, draws: number): GameLeaders {
  return {
    draws,
    pts: rankStat(acc, 'pts', draws),
    reb: rankStat(acc, 'reb', draws),
    ast: rankStat(acc, 'ast', draws),
  };
}

/** Top two dead-heat-aware lead chances sit inside `gap` (probability points). */
export function leaderRaceIsClose(rows: readonly LeaderTally[], draws: number, gap = 0.05): boolean {
  if (rows.length < 2 || !(draws > 0)) return false;
  return leaderScore(rows[0], draws) - leaderScore(rows[1], draws) < gap;
}
