import { GLICKO_TAU } from './config.ts';

const SCALE = 173.7178;
const RD_CAP = 350;

export interface GlickoRating {
  r: number;
  rd: number;
  sigma: number;
}

export const GLICKO_INITIAL: GlickoRating = { r: 1500, rd: 350, sigma: 0.06 };

export interface GlickoGame {
  opponent: GlickoRating;
  score: number;
}

function gOf(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / Math.PI ** 2);
}

function expect(mu: number, oppMu: number, oppPhi: number): number {
  return 1 / (1 + Math.exp(-gOf(oppPhi) * (mu - oppMu)));
}

export function expectedScore(player: GlickoRating, opponent: GlickoRating): number {
  const mu = (player.r - 1500) / SCALE;
  const oppMu = (opponent.r - 1500) / SCALE;
  return expect(mu, oppMu, opponent.rd / SCALE);
}

export function decayDeviation(rating: GlickoRating): GlickoRating {
  const phi = rating.rd / SCALE;
  const next = Math.sqrt(phi * phi + rating.sigma * rating.sigma);
  return { r: rating.r, rd: Math.min(RD_CAP, SCALE * next), sigma: rating.sigma };
}

/** One rating period. An empty period only widens the deviation. */
export function updateGlicko(player: GlickoRating, games: readonly GlickoGame[], tau = GLICKO_TAU): GlickoRating {
  if (games.length === 0) return decayDeviation(player);
  const mu = (player.r - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const rows = games.map((game) => {
    const oppMu = (game.opponent.r - 1500) / SCALE;
    const oppPhi = game.opponent.rd / SCALE;
    const weight = gOf(oppPhi);
    const chance = expect(mu, oppMu, oppPhi);
    return { weight, chance, score: game.score };
  });
  let varianceSum = 0;
  let deltaSum = 0;
  for (const row of rows) {
    varianceSum += row.weight * row.weight * row.chance * (1 - row.chance);
    deltaSum += row.weight * (row.score - row.chance);
  }
  const v = 1 / varianceSum;
  const delta = v * deltaSum;
  const a = Math.log(player.sigma ** 2);
  const f = (x: number) => {
    const raised = Math.exp(x);
    const numerator = raised * (delta ** 2 - phi ** 2 - v - raised);
    const denominator = 2 * (phi ** 2 + v + raised) ** 2;
    return numerator / denominator - (x - a) / tau ** 2;
  };
  let upper = a;
  let lower: number;
  if (delta ** 2 > phi ** 2 + v) lower = Math.log(delta ** 2 - phi ** 2 - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k += 1;
    lower = a - k * tau;
  }
  let fUpper = f(upper);
  let fLower = f(lower);
  for (let i = 0; i < 80 && Math.abs(lower - upper) > 1e-6; i += 1) {
    const mid = upper + ((upper - lower) * fUpper) / (fLower - fUpper);
    const fMid = f(mid);
    if (fMid * fLower <= 0) {
      upper = lower;
      fUpper = fLower;
    } else fUpper /= 2;
    lower = mid;
    fLower = fMid;
  }
  const sigma = Math.exp(upper / 2);
  const phiStar = Math.sqrt(phi ** 2 + sigma ** 2);
  const phiNext = 1 / Math.sqrt(1 / phiStar ** 2 + 1 / v);
  const muNext = mu + phiNext ** 2 * deltaSum;
  return { r: SCALE * muNext + 1500, rd: Math.min(RD_CAP, SCALE * phiNext), sigma };
}
