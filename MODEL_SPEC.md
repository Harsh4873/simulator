# Possessions v1 — 2026-10-30

This model uses ESPN rosters, injury designations and completed box scores. Box-score requests are restricted to event IDs in the permitted 2026/2027 public outcome history, at most 400 requested events per refresh. Recent completed boxes are revisited for corrections. The aggregate legacy shooting cache is not used for fitting; its population could not be audited by event. All production shooting and counting inputs now come from the same validated regular-season boxes.

This is an uncalibrated simulator. No sportsbook prices, spread captions or market totals enter fitting or sampling. Market comparisons are validation observations. A result near a posted line does not establish forecast accuracy.

## Data and publication

Required scoreboard, outcome, roster and injury failures stop publication. A malformed injury response is not an empty injury report. Explicitly empty reports are accepted. Completed boxes must contain both opponents, valid nonnegative integer counts, shooting identities, reconciled scores and plausible complete minutes. Partial/live/invalid boxes stay retryable. Regular-season fitting excludes preseason, postseason and play-in events. The 2026/2027 season restriction remains intentional until the permitted history lifecycle is expanded.

The slate and card have matching generation timestamps. Both are validated before either public file is replaced; a client seeing different generations rejects them. A GitHub Pages artifact publishes both together. Publication requires usable active rosters, finite rates, per-team shooting exposure and unique athlete memberships. The browser rejects mismatched generations, wrong Chicago dates and cards older than six hours, and rechecks after returning to the tab and every minute. These are operational expiry rules, not guarantees about injury-feed latency.

The off-site shooting cache stores completed event records so aggregates can be recomputed after corrections. `model_version`, `generator_sha`, `source_cutoff` and an input SHA-256 identify a card. Pre-tip cards and slates are archived under `data/forecast-archive/`; they and the shooting cache never enter `dist/`. A local uncommitted build cannot claim a committed generator SHA. Historical roster/injury snapshots were not retroactively invented.

## Minutes and participation

Long-term rate exposures weight the prior season 0.2 and current season 1. Current-role minutes are fitted separately: the ten most recent current-team regular-season appearances have a five-appearance half-life and a three-game prior from observed prior-season minutes (or the fitted population prior if absent). These strengths are modeling priors, not optimized coefficients.

Participation uses explicit archived team-event denominators and current-team appearances. Uncertain status scenarios use labelled, uncalibrated multipliers: probable 0.9, doubtful 0.1, questionable/day-to-day 0.5; out/suspended/inactive players receive zero. There is no inferred medical minutes restriction. Joint availability is sampled conditional on at least five players capable of full regulation and overtime minutes. This conditioning can raise marginal participation rates. The UI reports the actual simulated play share separately.

Positive minutes targets receive smooth noise and proportional capped allocation to 240 team minutes. There is no 24-minute cutoff or sequential bench residual assignment. Overtime happens only after a tie, uses the same participants and caps every player's increment at five, totaling 25 per team. There is no explicit substitution sequence; lineup feasibility beyond the minute/period constraints is not established.

## Possessions and production

The box-score possession estimator is `FGA + 0.44 FTA - ORB + TOV`. The 0.44 coefficient is the conventional approximation; the simulator's two-free-throw trips are a simplification and are not play-by-play reconstructed trips. A game's expected pace averages the two fitted team paces; its standard deviation comes from historical regulation-equivalent pace. Each draw gives both teams the same integer possession budget. Overtime uses the same pace scaled to five minutes.

Team pace, offensive and defensive points per possession, turnovers, offensive rebounds and assists are shrunk toward the observed league population with a 12-game prior. Active players divide shot/FT opportunities by minutes times fitted attempt rates. Team target efficiency is the geometric mean of active-lineup implied efficiency and historical team offense, multiplied by opponent defensive efficiency relative to the league and a venue term. The equal weight is a shrinkage assumption awaiting validation. Make probabilities are solved against this target before shots are sampled; scores are never adjusted after drawing. The home term is a paired empirical log-efficiency difference shrunk toward zero; neutral games omit it. It is not yet an opponent-adjusted causal estimate.

Each possession can end in a turnover, a field goal or a two-shot FT trip. Offensive rebounds extend that possession. Only field-goal misses and missed final free throws produce rebound opportunities. Offensive and defensive rebounds compete for the same opportunities; player shares use minute exposure and historical rebounding rates. Team/dead-ball rebounds, foul/bonus states and one-/three-shot trips are not explicitly modeled. Made field goals can have at most one assister, excluding the scorer. Steals are a subset of opponent turnovers and blocks a subset of opponent missed field goals. Stat allocations use period exposures rather than exact on-court lineups.

A fixed possession budget redistributes usage when players sit. It does not estimate absence-specific efficiency, defensive-lineup changes, travel, rest effects, garbage time, foul-outs or closing tactics. Rest intervals are retained for diagnosis only. Distributions and status probabilities remain uncalibrated. Older cards without matchup context use the fallback independent-stat sampler and should not be treated as the current model.

## Evaluation and UI

`npm run sanity` replays each current matchup with 10,000 draws and `fnv1a(event_id + ':' + generated_at)`. It reports a home spread with negative meaning home favored. It does not load market lines. Computation runs in a cancellable browser worker and is cached by event, generation and model version. Forecast rows and player panels display all-draw expectations, including DNPs. Scenario rows display one draw. Prop probabilities condition on participation and exclude pushes; the panel explains the difference. Steals, blocks and turnovers are unavailable on older cards without those samples.

`npm run backtest` writes `data/backtest-report.json`, using only event history from earlier Chicago dates. Same-date games are conservatively excluded because historical final timestamps are unavailable. It reports win Brier/log loss/reliability; margin/total CRPS, MAE, bias and interval coverage; and player-stat errors. A simple empirical historical baseline is scored on the same games, with paired game-cluster bootstrap intervals. Historical candidates are inferred from the preceding five team boxes, with unknown injuries. Ambiguous memberships are skipped and reported. This reconstruction is a diagnostic, not a replay of archived forecasts. Player errors cover matched actual participants, not a complete DNP/prop calibration population.

No historical closing-market archive is available. Release gates require at least 500 untouched games and 2,000 settled player markets; absolute margin/total bias at most 1/2 points; 80%/90% coverage within three percentage points; ECE at most .03; and game-clustered evidence of improvement over baselines without material market-relative regression. Those gates have not passed. Prop policy remains uncalibrated.

The October 27 audit reports describe their named historical snapshots. Their parameters and sample forecasts are not the current specification.

## Operations

The refresh job runs through evening availability changes. Its independent freshness workflow requests a recovery refresh and fails visibly after a missed deadline. Both depend on GitHub scheduling; they cannot guarantee recovery from a GitHub-wide outage. Inspect the failed workflow notification, dispatch `refresh-rate-card.yml` on main, then verify `deploy-pages.yml` succeeds. A dispatch alone is not deployment success: the refresh job follows the correlated deployment run and fails on cancellation, failure or timeout. Re-running the refresh also retries deployment when data did not change.

Source checks run before data commits. If main changes during a build, publication fails instead of copying stale generated data onto new code. Scheduled automation uses the approved bot identity; approved manual execution uses Harsh4873. No production verification was performed for this maintenance pass.

The site uses system fonts. ESPN team/player images are optional third-party requests with no referrer; monograms remain available if loading fails.
