import { type BookLine } from './book-lines.ts';
import { currentDailyPrice, gradeRank, upcomingToday, type DailyGrade, type DailyOffer } from './daily-price.ts';
import {
  EXTREME_CLAIM, gameLeans, LEAN_BUCKETS, linesByKey, listed, liveTierFor, MIN_MEASURED_EDGE, MIN_PLAY_SHARE, MIN_TIER_LEANS,
  type PicksFile, type TierRecord,
} from './picks.ts';
import { groupOf, mapIsCurrent, quoteCalibrationFor, type parsePublishedPropCalibration } from './prop-calibration.ts';
import {
  decideVerdict, profitPerStake, PROP_POLICY, propContextFromPlayer, propPolicyFromArtifacts, quoteProp, type PropMarket, type PropPolicy, type PropSide,
} from './props.ts';
import { marketLabel } from './projections.ts';
import type { Simulation } from './simulate.ts';
import type { RateCard, RateGame, SlateGame } from './types.ts';

export interface DailyPropPick {
  eventId: string;
  athleteId: string;
  player: string;
  matchup: string;
  market: PropMarket;
  side: PropSide;
  line: number;
  odds: number;
  book: string;
  pricedAt: string;
  tip: string;
  projection: number;
  modelProbability: number;
  breakEven: number;
  expectedReturn: number;
  /** BET or LEAN for a listed lean; EDGE for an unlisted one; THIN or TOP for the best prop below the edge bar. */
  grade: DailyGrade;
  /** What the grade rests on: the live record of graded leans of this side and strength, or that there is none yet. */
  evidence: string;
}

function points(edge: number): string {
  return (Math.abs(edge) * 100).toFixed(1);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * The verdict with its price, size and noise bars removed and no bet possible, so only its data checks can turn a prop
 * away: role and minutes evidence, a player who plays in the draws, few sit-outs, enough decided draws, no extreme gap.
 */
const BELOW_BAR: PropPolicy = { ...PROP_POLICY, calibrated: false, leanEdge: -1, leanReturn: -Infinity, noiseMultiple: -Infinity, betEdge: Infinity };

/** Why an unlisted lean is not a qualified pick, read from the live record of leans of its side and strength. */
export function unprovenEvidence(side: PropSide, tier: TierRecord | null): string {
  const prefix = 'Not a qualified pick: ';
  if (!tier || !(tier.pooled > 0)) return `${prefix}${side} leans this strong have no live-graded record yet.`;
  const graded = tier.pooled.toLocaleString('en-US');
  if (tier.edge < 0) return `${prefix}live-graded ${side} leans this strong have settled ${points(tier.edge)} points short of the posted price across ${graded} leans.`;
  if (tier.pooled < MIN_TIER_LEANS) return `${prefix}only ${graded} live-graded ${side} leans this strong so far, and listing needs ${MIN_TIER_LEANS}.`;
  return `${prefix}live-graded ${side} leans this strong have beaten the posted price by ${points(tier.edge)} points across ${graded} leans, short of the ${points(MIN_MEASURED_EDGE)} listing needs.`;
}

function gameOffers(picks: PicksFile, eventId: string): BookLine[] {
  if (picks.offers) return (picks.offers[eventId] ?? []).map(([book, athlete_id, market, line, over_odds, under_odds, priced_at]) => (
    { event_id: eventId, book, athlete_id, market, line, over_odds, under_odds, priced_at }
  ));
  if (!picks.book?.trim()) return [];
  return [...linesByKey({ book: picks.book, lines: { [eventId]: picks.lines[eventId] ?? [] } }).values()];
}

export function dailyPropForGame(
  game: SlateGame, rate: RateGame, simulation: Pick<Simulation, 'playerDraws'>, picks: PicksFile | null,
  card: RateCard, calibration: ReturnType<typeof parsePublishedPropCalibration>, now: Date,
): DailyPropPick | null {
  if (!upcomingToday(game, now) || rate.event_id !== game.event_id || rate.simulation_error || !picks || !calibration ||
      !card.generated_at || !(Date.parse(card.generated_at) <= now.getTime()) || picks.generated_at !== card.generated_at ||
      !card.model_hash || picks.model_hash !== card.model_hash || !card.input_hash || picks.input_hash !== card.input_hash) return null;
  const offers = gameOffers(picks, game.event_id).filter(line => currentDailyPrice(line.priced_at, game.start_time, now));
  const panel = { ...calibration, modelVersion: card.model_version ?? null, tipDate: game.date };
  const candidates: DailyPropPick[] = [];
  // Never recommend a side at worse odds when another current offer has the same player, stat and line.
  const bestPrices = new Map<string, number>();
  for (const offer of offers) {
    for (const side of ['over', 'under'] as const) {
      const key = JSON.stringify([offer.athlete_id, offer.market, offer.line, side]);
      const profit = profitPerStake(side === 'over' ? offer.over_odds : offer.under_odds);
      if (profit !== null) bestPrices.set(key, Math.max(bestPrices.get(key) ?? 0, profit));
    }
  }
  const lines = new Map(offers.map((line, i) => [String(i), line]));
  for (const lean of gameLeans(game, rate, simulation.playerDraws, lines, panel.table, card.model_version)) {
    const group = groupOf(lean.market);
    const artifact = calibration.artifacts.find(a => a.group === group);
    if (!artifact || !mapIsCurrent(artifact, card.model_version, game.date) || !(artifact.validated_through < game.date) ||
        !lean.calibrationMethod) continue;
    // Every pick, qualified or not, needs a map that is not red on drift, a claim short of extreme, and a likely player.
    if (lean.drift === 'red' || !(lean.claimed < EXTREME_CLAIM) || !(lean.play >= MIN_PLAY_SHARE)) continue;
    const over = lean.side === 'over';
    const odds = over ? lean.over_odds : lean.under_odds;
    const key = JSON.stringify([lean.athlete_id, lean.market, lean.line, lean.side]);
    if (profitPerStake(odds) !== bestPrices.get(key)) continue;
    const player = rate.players.find(p => p.athlete_id === lean.athlete_id);
    const sample = simulation.playerDraws.get(lean.athlete_id);
    if (!player || !sample) continue;
    const map = quoteCalibrationFor(panel, lean.market, lean.side);
    const quote = quoteProp(sample, lean.market, lean.side, lean.line, odds, over ? lean.under_odds : lean.over_odds, map);
    if (!quote || quote.expectedReturn === null) continue;
    const tier = liveTierFor(picks.record, lean.side, lean.claimed);
    const base = { ...propContextFromPlayer(player), propCalibration: map };
    let grade: DailyGrade | null = null;
    let evidence = '';
    // Why a claim over the bar still did not qualify, in the verdict's words (sampling noise, pushes, sit-outs).
    let shortfall: string | null = null;
    if (lean.claimed >= LEAN_BUCKETS[1] && quote.expectedReturn > 0) {
      // A listed lean's side and strength have beaten the price in live grading. An unlisted one is graded on its price
      // and data alone as an unproven edge, and its record is printed beside it instead of overruling it.
      const isListed = listed(lean, picks.record);
      const measured = isListed && tier ? { measured: { edge: tier.edge, graded: tier.pooled } } : {};
      const verdict = decideVerdict(quote, { ...base, ...measured }, lean.market, propPolicyFromArtifacts([artifact], card.model_version, game.date), true);
      if (verdict && verdict.verdict !== 'PASS') {
        grade = isListed ? verdict.verdict : 'EDGE';
        evidence = isListed && tier
          ? `Live-graded ${lean.side} leans this strong have beaten the posted price by ${points(tier.edge)} points across ${tier.pooled.toLocaleString('en-US')} leans.`
          : unprovenEvidence(lean.side, tier);
      } else if (verdict) {
        shortfall = verdict.text;
      }
    }
    if (!grade) {
      // Below the edge bar the best prop is still posted, so a day with prices always has one, but only past the same
      // data checks: the verdict runs with its price, size and noise bars removed.
      const verdict = decideVerdict(quote, base, lean.market, BELOW_BAR, true);
      if (!verdict || verdict.verdict === 'PASS') continue;
      const thin = lean.claimed > 0 && quote.expectedReturn > 0;
      grade = thin ? 'THIN' : 'TOP';
      const gap = `the calibrated chance of ${percent(lean.model)} clears the ${percent(lean.need)} break-even by ${points(lean.claimed)} points`;
      if (thin) {
        evidence = `Below the edge bar: ${gap}${shortfall ? `. ${shortfall}` : `, short of the ${points(LEAN_BUCKETS[1])} a lean needs.`}`;
      } else {
        const reason = lean.claimed > 0
          ? `${gap}, but pushes and sit-outs bring the expected return to ${quote.expectedReturn < 0 ? '−' : ''}${percent(Math.abs(quote.expectedReturn))}`
          : `the calibrated chance of ${percent(lean.model)} is under the ${percent(lean.need)} break-even`;
        evidence = `No edge at this price: ${reason}. It was the closest player prop to an edge when posted, not a qualified pick.`;
      }
    }
    candidates.push({
      eventId: game.event_id, athleteId: lean.athlete_id, player: lean.name, matchup: lean.matchup,
      market: lean.market, side: lean.side, line: lean.line, odds, book: lean.book, pricedAt: lean.priced_at,
      tip: game.start_time, projection: lean.projection, modelProbability: lean.model, breakEven: lean.need,
      expectedReturn: quote.expectedReturn, grade, evidence,
    });
  }
  return candidates.sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade) || b.expectedReturn - a.expectedReturn ||
    b.modelProbability - a.modelProbability || a.athleteId.localeCompare(b.athleteId) || a.market.localeCompare(b.market) ||
    a.line - b.line || a.side.localeCompare(b.side) || a.book.localeCompare(b.book))[0] ?? null;
}

/** The panel's wording for a prop pick: the bet as a book lists it, and the model's number behind it. */
export function dailyPropOffer(pick: DailyPropPick): DailyPropPick & DailyOffer {
  const stat = marketLabel(pick.market).toLowerCase();
  // Double- and triple-doubles are yes/no props that settle yes as over 0.5.
  const milestone = pick.market === 'dd' || pick.market === 'td';
  const title = milestone
    ? `${pick.player} ${pick.side === 'over' ? 'to record a' : 'no'} ${stat}`
    : `${pick.player} ${pick.side === 'over' ? 'Over' : 'Under'} ${pick.line} ${stat}`;
  const projectionLabel = milestone
    ? `Simulated ${stat} in ${(pick.projection * 100).toFixed(0)}% of games played`
    : `Model projection ${pick.projection.toFixed(1)} ${stat}`;
  return { ...pick, title, projectionLabel, settle: { kind: 'prop', athlete_id: pick.athleteId, market: pick.market, side: pick.side, line: pick.line } };
}
