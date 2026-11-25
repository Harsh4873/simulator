import { marginsOf } from './boxscore.ts';
import { compareOffers, currentDailyPrice, upcomingToday, type DailyOffer } from './daily-price.ts';
import { calibrationIssue } from './model-evidence.ts';
import { americanBreakEven, profitPerStake, PROP_POLICY } from './props.ts';
import type { Simulation } from './simulate.ts';
import type { RateCard, SlateGame } from './types.ts';

function signed(value: number): string {
  return value === 0 ? 'PK' : value > 0 ? `+${value}` : String(value);
}

/** A spread settles on the paired final scores, including overtime. A push returns the stake. */
export function dailySpreadForGame(game: SlateGame, card: RateCard, sim: Pick<Simulation, 'awayTotals' | 'homeTotals' | 'margins'>, now: Date): DailyOffer | null {
  if (!upcomingToday(game, now) || !game.spread_quotes?.length || !card.generated_at || Date.parse(card.generated_at) > now.getTime()) return null;
  const margins = marginsOf(sim);
  if (!margins.length || !margins.every(Number.isFinite)) return null;
  const mean = margins.reduce((sum, margin) => sum + margin, 0) / margins.length;
  const released = calibrationIssue(card.calibration, card.model_version ?? '', 'spread', card.source_cutoff ?? card.generated_at) === null;
  const offers: DailyOffer[] = [];
  for (const q of game.spread_quotes) {
    if (!currentDailyPrice(q.captured_at, game.start_time, now) || !Number.isFinite(q.home_spread) || !q.book.trim()) continue;
    let home = 0;
    let away = 0;
    for (const margin of margins) {
      if (margin + q.home_spread > 0) home++;
      if (margin + q.home_spread < 0) away++;
    }
    const decided = home + away;
    if (decided < PROP_POLICY.minDecided) continue;
    for (const side of ['home', 'away'] as const) {
      const odds = side === 'home' ? q.home_odds : q.away_odds;
      const need = americanBreakEven(odds);
      const profit = profitPerStake(odds);
      if (need === null || profit === null) continue;
      const wins = side === 'home' ? home : away;
      const probability = wins / decided;
      const edge = probability - need;
      const ev = (wins * profit - (decided - wins)) / margins.length;
      const noise = Math.sqrt(probability * (1 - probability) / decided) * PROP_POLICY.noiseMultiple;
      if (edge < PROP_POLICY.leanEdge || edge >= PROP_POLICY.extremeEdge || edge <= noise || ev < PROP_POLICY.leanReturn) continue;
      const spread = side === 'home' ? q.home_spread : -q.home_spread;
      const projected = Number((side === 'home' ? -mean : mean).toFixed(1));
      offers.push({
        eventId: game.event_id, title: `${game[side].name} ${signed(spread)}`,
        projectionLabel: `Model spread ${game[side].abbreviation} ${signed(projected)}`,
        matchup: `${game.away.abbreviation} at ${game.home.abbreviation}`, tip: game.start_time,
        book: q.book, pricedAt: q.captured_at, odds, modelProbability: probability, breakEven: need, expectedReturn: ev,
        // Spread leans have no graded record, so until the margins pass their release checks a spread is an unproven edge.
        grade: !released ? 'EDGE' : edge >= PROP_POLICY.betEdge && ev >= PROP_POLICY.betReturn ? 'BET' : 'LEAN',
        evidence: released
          ? 'The simulated margins have passed their release checks against settled games.'
          : 'Not a qualified pick: spread leans are not graded against results yet, and the simulated margins have not passed their release checks.',
      });
    }
  }
  return offers.sort(compareOffers)[0] ?? null;
}
