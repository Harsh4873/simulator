/** Score-only Elo. K is fixed. Home advantage is fit on earlier games. No market line is an input. */
export const ELO_K = 20;
export const ELO_START = 1500;
const HFA_GRID = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

export interface EloGame {
  id: string;
  start_time: string;
  home: string;
  away: string;
  home_score: number;
  away_score: number;
  neutral: boolean;
}

export interface EloFit {
  hfa: number;
  holdout_games: number;
  holdout_brier: number;
  pregame_home_win: Map<string, number>;
  ratings: Map<string, number>;
}

export function expectedHomeWin(home: number, away: number, hfa: number): number {
  const exponent = (away - (home + hfa)) / 400;
  return 1 / (1 + 10 ** exponent);
}

export function applyElo(home: number, away: number, hfa: number, homeScore: number, awayScore: number): { home: number; away: number; expected: number } {
  const expected = expectedHomeWin(home, away, hfa);
  const actual = homeScore > awayScore ? 1 : homeScore < awayScore ? 0 : 0.5;
  const delta = ELO_K * (actual - expected);
  return { home: home + delta, away: away - delta, expected };
}

function replay(games: readonly EloGame[], hfa: number): { expected: number[]; ratings: Map<string, number> } {
  const ratings = new Map<string, number>();
  const expected: number[] = [];
  for (const game of games) {
    const home = ratings.get(game.home) ?? ELO_START;
    const away = ratings.get(game.away) ?? ELO_START;
    const next = applyElo(home, away, game.neutral ? 0 : hfa, game.home_score, game.away_score);
    expected.push(next.expected);
    ratings.set(game.home, next.home);
    ratings.set(game.away, next.away);
  }
  return { expected, ratings };
}

function logLoss(games: readonly EloGame[], hfa: number): number {
  const { expected } = replay(games, hfa);
  let loss = 0;
  for (let i = 0; i < games.length; i += 1) {
    const game = games[i]!;
    const outcome = game.home_score > game.away_score ? 1 : game.home_score < game.away_score ? 0 : 0.5;
    const p = Math.min(0.999, Math.max(0.001, expected[i]!));
    loss += -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
  }
  return loss;
}

/**
 * Fits home advantage on the first 70% of completed games and scores Brier on the rest.
 * Returns null when the holdout is too small to test.
 */
export function fitElo(games: readonly EloGame[]): EloFit | null {
  const ordered = [...games].sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  const trainCount = Math.floor(ordered.length * 0.7);
  const holdoutGames = ordered.length - trainCount;
  if (trainCount < 40 || holdoutGames < 24) return null;
  const train = ordered.slice(0, trainCount);
  let hfa = HFA_GRID[0]!;
  let best = Infinity;
  for (const candidate of HFA_GRID) {
    const loss = logLoss(train, candidate);
    if (loss < best) {
      best = loss;
      hfa = candidate;
    }
  }
  const { expected, ratings } = replay(ordered, hfa);
  let brier = 0;
  for (let i = trainCount; i < ordered.length; i += 1) {
    const game = ordered[i]!;
    const outcome = game.home_score > game.away_score ? 1 : game.home_score < game.away_score ? 0 : 0.5;
    const gap = expected[i]! - outcome;
    brier += gap * gap;
  }
  const pregame = new Map<string, number>();
  ordered.forEach((game, index) => pregame.set(game.id, expected[index]!));
  return { hfa, holdout_games: holdoutGames, holdout_brier: brier / holdoutGames, pregame_home_win: pregame, ratings };
}

export function projectHomeWin(fit: EloFit, home: string, away: string, neutral: boolean): number {
  return expectedHomeWin(fit.ratings.get(home) ?? ELO_START, fit.ratings.get(away) ?? ELO_START, neutral ? 0 : fit.hfa);
}
