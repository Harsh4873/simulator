import { marginsOf } from './boxscore.ts';
import { compareOffers, currentDailyPrice, upcomingToday, type DailyGrade, type DailyOffer } from './daily-price.ts';
import { calibrationIssue } from './model-evidence.ts';
import { americanBreakEven, profitPerStake, PROP_POLICY } from './props.ts';
import type { Simulation } from './simulate.ts';
import type { RateCard, SlateGame, SpreadQuote } from './types.ts';

function signed(value: number): string {
  return value === 0 ? 'PK' : value > 0 ? `+${value}` : String(value);
}

function points(edge: number): string {
  return (Math.abs(edge) * 100).toFixed(1);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** One game as a spread pick reads it, from either sport's slate. */
export interface SpreadGame {
  eventId: string;
  start: string;
  home: { name: string; abbreviation: string };
  away: { name: string; abbreviation: string };
}

/** Whether the sport's simulated margins have passed their release checks, and what a qualified pick says it rests on. */
export interface SpreadRelease {
  released: boolean;
  evidence: string;
}

/**
 * The best spread on one game, read from its simulated home margins at each current two-sided price. A spread settles on
 * the paired final scores, including overtime, and a push returns the stake. Every pick needs a current price, enough
 * decided draws, and no side with the extreme edge that marks a model more likely wrong than right. One that also
 * clears the edge, noise and return bars is qualified: an unproven edge until the margins pass their release checks,
 * then a lean or a bet. Below the bar the best side is still offered, THIN when it beats the break-even and the return
 * is positive, TOP when it does not, so a priced game always has a pick.
 */
export function bestSpreadOffer(game: SpreadGame, margins: readonly number[], quotes: readonly SpreadQuote[], now: Date, release: SpreadRelease): DailyOffer | null {
  if (!margins.length || !margins.every(Number.isFinite)) return null;
  const mean = margins.reduce((sum, margin) => sum + margin, 0) / margins.length;
  const offers: DailyOffer[] = [];
  for (const q of quotes) {
    if (!currentDailyPrice(q.captured_at, game.start, now) || !Number.isFinite(q.home_spread) || !q.book.trim()) continue;
    let home = 0;
    let away = 0;
    for (const margin of margins) {
      if (margin + q.home_spread > 0) home++;
      if (margin + q.home_spread < 0) away++;
    }
    const decided = home + away;
    if (decided < PROP_POLICY.minDecided) continue;
    const sides = (['home', 'away'] as const).flatMap((side) => {
      const odds = side === 'home' ? q.home_odds : q.away_odds;
      const need = americanBreakEven(odds);
      const profit = profitPerStake(odds);
      if (need === null || profit === null) return [];
      const wins = side === 'home' ? home : away;
      const probability = wins / decided;
      return [{ side, odds, need, probability, edge: probability - need, ev: (wins * profit - (decided - wins)) / margins.length }];
    });
    // A model this far from the price is more likely wrong than right about the game, so neither side is offered.
    if (sides.some((row) => row.edge >= PROP_POLICY.extremeEdge)) continue;
    for (const { side, odds, need, probability, edge, ev } of sides) {
      const noise = Math.sqrt(probability * (1 - probability) / decided) * PROP_POLICY.noiseMultiple;
      const gap = `the model’s cover chance of ${percent(probability)} clears the ${percent(need)} break-even by ${points(edge)} points`;
      const pushes = `pushes bring the expected return to ${ev < 0 ? '−' : '+'}${percent(Math.abs(ev))}`;
      let grade: DailyGrade;
      let evidence: string;
      if (edge >= PROP_POLICY.leanEdge && edge > noise && ev >= PROP_POLICY.leanReturn) {
        grade = !release.released ? 'EDGE' : edge >= PROP_POLICY.betEdge && ev >= PROP_POLICY.betReturn ? 'BET' : 'LEAN';
        evidence = release.evidence;
      } else if (edge > 0 && ev > 0) {
        grade = 'THIN';
        const short = edge < PROP_POLICY.leanEdge ? `short of the ${points(PROP_POLICY.leanEdge)} a lean needs`
          : edge <= noise ? 'inside the simulation’s sampling noise' : `but ${pushes}`;
        evidence = `Below the edge bar: ${gap}, ${short}.`;
      } else {
        grade = 'TOP';
        const reason = edge > 0 ? `${gap}, but ${pushes}` : `the model’s cover chance of ${percent(probability)} is under the ${percent(need)} break-even`;
        evidence = `No edge at this price: ${reason}. It was the closest spread to an edge when posted, not a qualified pick.`;
      }
      const spread = side === 'home' ? q.home_spread : -q.home_spread;
      const projected = Number((side === 'home' ? -mean : mean).toFixed(1));
      offers.push({
        eventId: game.eventId, title: `${game[side].name} ${signed(spread)}`,
        projectionLabel: `Model spread ${game[side].abbreviation} ${signed(projected)}`,
        matchup: `${game.away.abbreviation} at ${game.home.abbreviation}`, tip: game.start,
        book: q.book, pricedAt: q.captured_at, odds, modelProbability: probability, breakEven: need, expectedReturn: ev,
        grade, evidence,
        settle: { kind: 'spread', side, home_spread: q.home_spread, home: game.home.abbreviation, away: game.away.abbreviation },
      });
    }
  }
  return offers.sort(compareOffers)[0] ?? null;
}

const NBA_RELEASED = 'The simulated margins have passed their release checks against settled games.';
const NBA_UNRELEASED = 'Not a qualified pick: spread leans are not graded against results yet, and the simulated margins have not passed their release checks.';

/** The NBA game's best spread, from the same draws as its box score. */
export function dailySpreadForGame(game: SlateGame, card: RateCard, sim: Pick<Simulation, 'awayTotals' | 'homeTotals' | 'margins'>, now: Date): DailyOffer | null {
  if (!upcomingToday(game, now) || !game.spread_quotes?.length || !card.generated_at || Date.parse(card.generated_at) > now.getTime()) return null;
  // Spread leans have no graded record, so until the margins pass their release checks a qualified spread is an unproven edge.
  const released = calibrationIssue(card.calibration, card.model_version ?? '', 'spread', card.source_cutoff ?? card.generated_at) === null;
  return bestSpreadOffer(
    { eventId: game.event_id, start: game.start_time, home: game.home, away: game.away },
    marginsOf(sim), game.spread_quotes, now, { released, evidence: released ? NBA_RELEASED : NBA_UNRELEASED },
  );
}
