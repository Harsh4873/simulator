# Simulator

Today's NBA games in America/Chicago. Simulate draws 10,000 independent games in the browser from a committed rate card.

This is a simulator, not a betting ticket.

The current model and its limits are described in [MODEL_SPEC.md](MODEL_SPEC.md). The `MODEL_AUDIT_*` reports are historical snapshots.

Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run validate-artifact` to verify. `npm run rate-card` refreshes the permitted source data. `npm run sanity` reports seeded 10,000-draw projections; `npm run backtest` runs the chronological diagnostic. The backtest does not certify calibration or market accuracy.
