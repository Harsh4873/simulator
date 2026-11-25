import { type BookLine } from './book-lines.ts';
import { currentDailyPrice, upcomingToday, type DailyOffer } from './daily-price.ts';
import { gameLeans, LEAN_BUCKETS, linesByKey, listed, liveTierFor, type PicksFile } from './picks.ts';
import { groupOf, mapIsCurrent, quoteCalibrationFor, type parsePublishedPropCalibration } from './prop-calibration.ts';
import { decideVerdict, profitPerStake, propContextFromPlayer, propPolicyFromArtifacts, quoteProp, type PropMarket, type PropSide } from './props.ts';
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
  grade: 'BET' | 'LEAN';
  /** The live record of graded leans of this side and strength, which is what lets this one be listed. */
  evidence: string;
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
        !lean.calibrationMethod || lean.claimed < LEAN_BUCKETS[1] || !listed(lean, picks.record)) continue;
    const over = lean.side === 'over';
    const odds = over ? lean.over_odds : lean.under_odds;
    const key = JSON.stringify([lean.athlete_id, lean.market, lean.line, lean.side]);
    if (profitPerStake(odds) !== bestPrices.get(key)) continue;
    const player = rate.players.find(p => p.athlete_id === lean.athlete_id);
    const sample = simulation.playerDraws.get(lean.athlete_id);
    if (!player || !sample) continue;
    const map = quoteCalibrationFor(panel, lean.market, lean.side);
    const quote = quoteProp(sample, lean.market, lean.side, lean.line, odds, over ? lean.under_odds : lean.over_odds, map);
    if (!quote || quote.expectedReturn === null || quote.expectedReturn <= 0) continue;
    const tier = liveTierFor(picks.record, lean.side, lean.claimed)!;
    const policy = propPolicyFromArtifacts([artifact], card.model_version, game.date);
    const context = { ...propContextFromPlayer(player), propCalibration: map, measured: { edge: tier.edge, graded: tier.pooled } };
    const verdict = decideVerdict(quote, context, lean.market, policy, true);
    if (!verdict || verdict.verdict === 'PASS') continue;
    candidates.push({
      eventId: game.event_id, athleteId: lean.athlete_id, player: lean.name, matchup: lean.matchup,
      market: lean.market, side: lean.side, line: lean.line, odds, book: lean.book, pricedAt: lean.priced_at,
      tip: game.start_time, projection: lean.projection, modelProbability: lean.model, breakEven: lean.need,
      expectedReturn: quote.expectedReturn, grade: verdict.verdict,
      evidence: `Live-graded ${lean.side} leans this strong have beaten the posted price by ${(tier.edge * 100).toFixed(1)} points across ${tier.pooled.toLocaleString('en-US')} leans.`,
    });
  }
  return candidates.sort((a, b) => Number(b.grade === 'BET') - Number(a.grade === 'BET') || b.expectedReturn - a.expectedReturn ||
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
  return { ...pick, title, projectionLabel };
}
