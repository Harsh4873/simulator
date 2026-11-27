import { nflUpcomingToday, type DailyOffer } from './daily-price.ts';
import { bestSpreadOffer } from './daily-spread.ts';
import type { FeedGame } from './feed.ts';
import { nflGameLineValues, playNflGame } from './nfl/box.ts';
import type { SpreadQuote } from './types.ts';

/** NFL team bets of the day: the point spread only, for now. NFL player props are not posted. */

const NFL_UNRELEASED = 'Not a qualified pick: NFL spread leans are not graded against results yet. The simulation is checked on earlier weeks’ winners and score ranges, not on spreads.';

/**
 * The home margins the NFL box score's line check reads: the game's published plan replayed with the build's seed, with
 * the range calibrated on earlier weeks. Null when the file carries no plan.
 */
export function nflMargins(game: FeedGame): number[] | null {
  const box = playNflGame(game);
  return box ? nflGameLineValues(box, 'margin') : null;
}

/** The NFL game's best spread. Prices come from the scoreboard, never from the NFL slate, which carries none. */
export function dailyNflSpreadForGame(
  game: FeedGame, quotes: readonly SpreadQuote[], now: Date, draw: (game: FeedGame) => readonly number[] | null = nflMargins,
): DailyOffer | null {
  if (!nflUpcomingToday(game, now) || !quotes.length) return null;
  const margins = draw(game);
  if (!margins) return null;
  return bestSpreadOffer(
    // Kickoff in the same second-precision form as an NBA tip.
    { eventId: game.id, start: new Date(Date.parse(game.start_time)).toISOString().replace(/\.\d{3}Z$/, 'Z'), home: game.home, away: game.away },
    margins, quotes, now, { released: false, evidence: NFL_UNRELEASED },
  );
}
