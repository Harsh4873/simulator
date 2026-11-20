/**
 * Score-based Elo. K, home advantage and whether the margin scales an update are chosen on earlier games; the latest
 * 30% of games are left out of that choice and only scored. No market line is an input.
 */
export const ELO_K = 20;
export const ELO_START = 1500;
export const ELO_MODEL_NAME = 'nfl-elo-v2';
const HFA_GRID = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
const K_GRID = [10, 15, 20, 25, 30, 35, 40, 50, 60];
/** Every team starts the season at 1500, so the first 35% of games only warm the ratings up and are not scored. */
const WARMUP_FRACTION = 0.35;
const SELECT_THROUGH_FRACTION = 0.7;
const MIN_SELECT_GAMES = 24;
const MIN_HOLDOUT_GAMES = 24;

export interface EloGame {
  id: string;
  start_time: string;
  home: string;
  away: string;
  home_score: number;
  away_score: number;
  neutral: boolean;
}

export interface EloSettings {
  k: number;
  hfa: number;
  /** Scale each update by the winning margin, damped when the favourite won. */
  margin: boolean;
}

export interface EloFit extends EloSettings {
  holdout_games: number;
  holdout_brier: number;
  pregame_home_win: Map<string, number>;
  ratings: Map<string, number>;
}

export function expectedHomeWin(home: number, away: number, hfa: number): number {
  const exponent = (away - (home + hfa)) / 400;
  return 1 / (1 + 10 ** exponent);
}

/**
 * ln(margin + 1) × 2.2 / (winner's rating edge × 0.001 + 2.2). A blowout moves ratings more than a field goal, and a
 * favourite's win counts for less, so ratings do not run away. A tie is 1.
 */
export function marginMultiplier(margin: number, winnerEdge: number): number {
  if (margin === 0) return 1;
  return Math.log(Math.abs(margin) + 1) * (2.2 / Math.max(0.5, winnerEdge * 0.001 + 2.2));
}

export function applyElo(
  home: number,
  away: number,
  hfa: number,
  homeScore: number,
  awayScore: number,
  k = ELO_K,
  margin = false,
): { home: number; away: number; expected: number } {
  const expected = expectedHomeWin(home, away, hfa);
  const actual = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
  const edge = actual === 1 ? home + hfa - away : actual === 0 ? away - home - hfa : 0;
  const delta = k * (margin ? marginMultiplier(homeScore - awayScore, edge) : 1) * (actual - expected);
  return { home: home + delta, away: away - delta, expected };
}

function replay(games: readonly EloGame[], settings: EloSettings): { expected: number[]; ratings: Map<string, number> } {
  const ratings = new Map<string, number>();
  const expected: number[] = [];
  for (const game of games) {
    const home = ratings.get(game.home) ?? ELO_START;
    const away = ratings.get(game.away) ?? ELO_START;
    const next = applyElo(home, away, game.neutral ? 0 : settings.hfa, game.home_score, game.away_score, settings.k, settings.margin);
    expected.push(next.expected);
    ratings.set(game.home, next.home);
    ratings.set(game.away, next.away);
  }
  return { expected, ratings };
}

function outcome(game: EloGame): number {
  return game.home_score > game.away_score ? 1 : game.home_score < game.away_score ? 0 : 0.5;
}

function meanLogLoss(games: readonly EloGame[], expected: readonly number[], from: number, to: number): number {
  let loss = 0;
  for (let i = from; i < to; i += 1) {
    const result = outcome(games[i]!);
    const p = Math.min(0.999, Math.max(0.001, expected[i]!));
    loss += -(result * Math.log(p) + (1 - result) * Math.log(1 - p));
  }
  return loss / Math.max(1, to - from);
}

/**
 * Ratings run from the first game. K, home advantage and the margin rule are chosen by log loss on games between the
 * 35% and 70% marks, after the warm-up. The last 30% is scored with Brier and played no part in the choice.
 * Returns null while either block is too small to test.
 */
export function fitElo(games: readonly EloGame[]): EloFit | null {
  const ordered = [...games].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  const warmCount = Math.floor(ordered.length * WARMUP_FRACTION);
  const trainCount = Math.floor(ordered.length * SELECT_THROUGH_FRACTION);
  const holdoutGames = ordered.length - trainCount;
  if (trainCount - warmCount < MIN_SELECT_GAMES || holdoutGames < MIN_HOLDOUT_GAMES) return null;
  const train = ordered.slice(0, trainCount);
  let best: EloSettings = { k: ELO_K, hfa: HFA_GRID[0]!, margin: false };
  let bestLoss = Infinity;
  for (const margin of [false, true]) {
    for (const k of K_GRID) {
      for (const hfa of HFA_GRID) {
        const loss = meanLogLoss(train, replay(train, { k, hfa, margin }).expected, warmCount, trainCount);
        if (loss < bestLoss) {
          bestLoss = loss;
          best = { k, hfa, margin };
        }
      }
    }
  }
  const { expected, ratings } = replay(ordered, best);
  let brier = 0;
  for (let i = trainCount; i < ordered.length; i += 1) {
    const gap = expected[i]! - outcome(ordered[i]!);
    brier += gap * gap;
  }
  const pregame = new Map<string, number>();
  ordered.forEach((game, index) => pregame.set(game.id, expected[index]!));
  return { ...best, holdout_games: holdoutGames, holdout_brier: brier / holdoutGames, pregame_home_win: pregame, ratings };
}

export function projectHomeWin(fit: EloFit, home: string, away: string, neutral: boolean): number {
  return expectedHomeWin(fit.ratings.get(home) ?? ELO_START, fit.ratings.get(away) ?? ELO_START, neutral ? 0 : fit.hfa);
}
