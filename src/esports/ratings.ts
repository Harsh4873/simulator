import { MAP_POOL, MIN_TIER1_MAPS } from './config.ts';
import { GLICKO_INITIAL, type GlickoRating, decayDeviation, expectedScore, updateGlicko } from './glicko2.ts';
import type { MapResult } from './liquipedia.ts';
import { seriesFormat, seriesWinProbability } from './series.ts';
import type { FeedProjection } from '../feed.ts';

export interface TeamState {
  global: GlickoRating;
  maps: Map<string, GlickoRating>;
  mapCounts: Map<string, number>;
  mapCount: number;
}

function freshState(): TeamState {
  return { global: { ...GLICKO_INITIAL }, maps: new Map(), mapCounts: new Map(), mapCount: 0 };
}

function cloneState(team: TeamState): TeamState {
  return {
    global: { ...team.global },
    maps: new Map([...team.maps].map(([map, rating]) => [map, { ...rating }])),
    mapCounts: new Map(team.mapCounts),
    mapCount: team.mapCount,
  };
}

function decayTeam(team: TeamState): TeamState {
  const maps = new Map<string, GlickoRating>();
  for (const [map, rating] of team.maps) maps.set(map, decayDeviation(rating));
  return { global: decayDeviation(team.global), maps, mapCounts: new Map(team.mapCounts), mapCount: team.mapCount };
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function applyDay(state: Map<string, TeamState>, games: readonly MapResult[]): Map<string, TeamState> {
  const pre = new Map<string, TeamState>();
  for (const [name, team] of state) pre.set(name, cloneState(team));
  const playing = new Set<string>();
  for (const game of games) {
    playing.add(game.winner);
    playing.add(game.loser);
    if (!pre.has(game.winner)) pre.set(game.winner, freshState());
    if (!pre.has(game.loser)) pre.set(game.loser, freshState());
  }
  const next = new Map<string, TeamState>();
  for (const [name, team] of pre) {
    if (!playing.has(name)) {
      next.set(name, decayTeam(team));
      continue;
    }
    const mine = games.filter((game) => game.winner === name || game.loser === name);
    const globalGames = mine.map((game) => {
      const opponentName = game.winner === name ? game.loser : game.winner;
      const opponent = pre.get(opponentName) ?? freshState();
      return { opponent: opponent.global, score: game.winner === name ? 1 : 0 };
    });
    const maps = new Map(team.maps);
    const mapCounts = new Map(team.mapCounts);
    const byMap = new Map<string, { opponent: GlickoRating; score: number }[]>();
    for (const game of mine) {
      const opponentName = game.winner === name ? game.loser : game.winner;
      const opponent = pre.get(opponentName) ?? freshState();
      const list = byMap.get(game.map) ?? [];
      list.push({ opponent: opponent.maps.get(game.map) ?? { ...GLICKO_INITIAL }, score: game.winner === name ? 1 : 0 });
      byMap.set(game.map, list);
    }
    for (const [map, list] of byMap) {
      maps.set(map, updateGlicko(maps.get(map) ?? { ...GLICKO_INITIAL }, list));
      mapCounts.set(map, (mapCounts.get(map) ?? 0) + list.length);
    }
    next.set(name, { global: updateGlicko(team.global, globalGames), maps, mapCounts, mapCount: team.mapCount + mine.length });
  }
  return next;
}

/** Ratings at the start of `day`, after every earlier tier-1 map and idle-day widening. */
export function ratingsBefore(results: readonly MapResult[], day: string): Map<string, TeamState> {
  const earlier = results.filter((result) => result.day < day).sort((a, b) => a.day.localeCompare(b.day));
  if (earlier.length === 0) return new Map();
  const first = earlier[0]!.day;
  const last = earlier[earlier.length - 1]!.day;
  let state = new Map<string, TeamState>();
  for (let cursor = first; cursor <= last; cursor = nextDay(cursor)) {
    state = applyDay(state, earlier.filter((result) => result.day === cursor));
    if (cursor === last) break;
  }
  if (last >= day) return state;
  for (let cursor = nextDay(last); cursor < day; cursor = nextDay(cursor)) state = applyDay(state, []);
  return state;
}

function percent(chance: number): string {
  return `${(chance * 100).toFixed(1)}%`;
}

export function projectionFor(leftName: string, left: TeamState | undefined, rightName: string, right: TeamState | undefined, formatLabel: string | null): FeedProjection | null {
  if (!left || !right || left.mapCount < MIN_TIER1_MAPS || right.mapCount < MIN_TIER1_MAPS) return null;
  const mapChance = expectedScore(left.global, right.global);
  const format = seriesFormat(formatLabel);
  const away = format ? seriesWinProbability(Array.from({ length: format.maps }, () => mapChance), format.wins) : mapChance;
  const home = 1 - away;
  if (!format) {
    return { kind: 'map', away_win: away, home_win: home, summary: `Map chance · ${leftName} ${percent(away)} · ${rightName} ${percent(home)}` };
  }
  return { kind: 'series', away_win: away, home_win: home, summary: `${leftName} ${percent(away)} · ${rightName} ${percent(home)}` };
}

/** Walk-forward Brier of the global map chance on maps where both teams already had a fit. */
export function mapBrier(results: readonly MapResult[]): { games: number; brier: number } {
  const days = [...new Set(results.map((result) => result.day))].sort();
  let games = 0;
  let total = 0;
  for (const day of days) {
    const ratings = ratingsBefore(results, day);
    for (const result of results) {
      if (result.day !== day) continue;
      const winner = ratings.get(result.winner);
      const loser = ratings.get(result.loser);
      if (!winner || !loser || winner.mapCount < MIN_TIER1_MAPS || loser.mapCount < MIN_TIER1_MAPS) continue;
      const chance = expectedScore(winner.global, loser.global);
      total += (chance - 1) ** 2;
      games += 1;
    }
  }
  return { games, brier: games === 0 ? 1 : total / games };
}

export function projectionNote(projection: FeedProjection, leftName: string, left: TeamState, rightName: string, right: TeamState): string {
  const maps: string[] = [];
  for (const map of MAP_POOL.maps) {
    const leftRating = left.maps.get(map);
    const rightRating = right.maps.get(map);
    if ((left.mapCounts.get(map) ?? 0) < MIN_TIER1_MAPS || (right.mapCounts.get(map) ?? 0) < MIN_TIER1_MAPS || !leftRating || !rightRating) continue;
    const chance = expectedScore(leftRating, rightRating);
    maps.push(`${map} ${percent(chance)}–${percent(1 - chance)}`);
  }
  const mapLine = maps.length ? ` If that map is played: ${maps.join(', ')}. Those map chances are not combined.` : '';
  const uncertainty = `${leftName} RD ${Math.round(left.global.rd)}, ${rightName} RD ${Math.round(right.global.rd)}.`;
  if (projection.kind === 'map') {
    return `Series chance is not fitted because the format was not in the feed. This is the global Glicko-2 map chance. Veto is not simulated. Not calibrated. ${uncertainty}${mapLine}`;
  }
  return `Series chance if every map is an independent draw at the global Glicko-2 map chance. Veto is not simulated. Not calibrated. ${uncertainty}${mapLine}`;
}
