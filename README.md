# Simulator

Today's NBA games in America/Chicago. Simulate draws 10,000 independent games in the browser from a committed rate card.

This is a simulator, not a betting ticket.

Lineups lets you rule any player in or out for one game before simulating. Your calls stay in your browser and never change the published card.

The current model and its limits are described in [MODEL_SPEC.md](MODEL_SPEC.md). The `MODEL_AUDIT_*` reports are historical snapshots.

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run validate-artifact`, and `npm run validate-privacy` to verify. `GENERATOR_SHA=pending npm run rate-card` explicitly builds local data; publishing from a committed source uses that source SHA instead of pending. This refreshes the permitted source data. `npm run sanity` reports seeded 10,000-draw projections; `npm run walk-forward` scores the team model out of sample on every game since January 2026; `npm run replay` rebuilds archived pre-tip cards with the current code and scores them against results and archived lines; `npm run backtest` runs the chronological diagnostic. The backtest does not certify calibration or market accuracy.
