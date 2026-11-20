# Simulator

Today's NBA games in America/Chicago. Simulate draws 10,000 independent games in the browser from a committed rate card.

This is a simulator, not a betting ticket.

The NFL switch shows today's and yesterday's games, then the rest of the week, with each team's record. Each game is simulated 10,000 times from this season's box scores and its injury report: a projected score, win chance and margin, and a projection with a 10th-to-90th range for each quarterback, back and receiver. The win chances, ranges and player means are calibrated walk-forward on earlier weeks, which the page reports. No market line is used. Without enough box scores it falls back to a score-only Elo.

The esports switch projects each player: CS2 kills and headshots over maps 1-2 from his kills and headshots per round, Dota 2 and League of Legends kills and assists per game. Each projection has a 10th-to-90th range calibrated on the same players' earlier games, with the plain average beneath it and what he did once the game is played. An upcoming CS2 match lists the five players on each side who played most recently.

Lineups lets you rule any player in or out for one game before simulating. Your calls stay in your browser and never change the published card.

The current model and its limits are described in [MODEL_SPEC.md](MODEL_SPEC.md). The `MODEL_AUDIT_*` reports are historical snapshots.

Projections compares each simulation with the posted over/under line for that player and shows how comparisons like it have settled. Every comparison is logged before its game tips and graded from the final box score, so the record under the list is measured, not claimed.

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run validate-artifact`, and `npm run validate-privacy` to verify. `GENERATOR_SHA=pending npm run rate-card` explicitly builds local data; publishing from a committed source uses that source SHA instead of pending. This refreshes the permitted source data. `npm run sanity` reports seeded 10,000-draw projections; `npm run walk-forward` scores the team model out of sample on every game since January 2026; `npm run replay` rebuilds archived pre-tip cards with the current code and scores them against results and archived lines; `npm run backtest` runs the chronological diagnostic. The backtest does not certify calibration or market accuracy. `npm run picks` compares the published card with posted lines, logs and grades them, and writes `public/data/picks.json`; `node --experimental-strip-types scripts/publish-sims.ts dist/data` draws each game of the built card the way the deploy does and writes the files the page reads in place of a phone's own draws. `npm run picks:backfill` replays archived pre-tip cards against the lines posted at the time (`BACKFILL_REBUILD=1` after a model change).
