# Simulator maintenance

This repository is the public NBA simulator at `/simulator/`.

The page lists today's and yesterday's NBA games in America/Chicago. Simulate draws 10,000 independent games in the browser from the committed rate card. It is a simulator, not a betting ticket. The spread caption is visible text. The sampler does not read it.

## Data

- `public/data/slate.json` and `public/data/rate-card.json` are what the browser reads.
- `data/shooting-cache.json` stays off the site. It is not under `public/` and is not copied into `dist/`.
- `.github/workflows/refresh-rate-card.yml` rebuilds those files. Its concurrency group is `simulator-rate-card`. Do not join `pick-cache-writer`.
- After a data push, that job dispatches `deploy-pages.yml`. A token push does not emit `push`, so the site would otherwise keep the previous artifact.
- GitHub drops or delays many cron slots, so every refresh run ends (with `if: always()`) by arming `.github/workflows/refresh-timer.yml`. The timer waits until the time from `src/refresh-window.ts` (every 45 minutes within four hours of a tip, about 30 minutes before each tip, just after Chicago midnight, at least every 3.5 hours otherwise), then dispatches the refresh with `trigger=timer`. Its concurrency group is `simulator-refresh-timer`, and a newer timer cancels the waiting one. The cron schedule stays as a backstop.
- Forecast archives keep only games tipping within two hours. `npm run replay` scores archived pre-tip inputs with the current code.
- The job may call the ESPN scoreboard, team index, roster, injuries, and box-score summary endpoints, and it may read PickLedger's public outcome gzip. It does not call `stats.nba.com`. It does not scrape CBS or Rotowire. It does not call the player gamelog URL. Summary requests are limited to event ids already in the 2026 and 2027 outcome rows, at most 400 new events a run.
- The NFL refresh may call ESPN's NFL scoreboard, game summary (box scores and the injury report), and team roster endpoints. It reads no odds. `data/nfl-cache.json` keeps finished box scores off the site, so a run fetches only newly finished games.
- The esports refresh may call OpenDota, Leaguepedia, and BO3.gg. It does not call HLTV, Riot, or an odds vendor.
- The picks step (`npm run picks`) also reads PickLedger's public NBA prop price files (`data/nba_prop_prices/<date>.jsonl.gz`), for the slate's dates only. Those prices are compared with the simulations after the draws exist and are used to grade them. When the book's opening number differs from the current line, the page shows both. The public feed names one book per row. They never enter fitting, the rate card, or sampling. `PICK_LINES=off` stops the read.
- `public/data/picks.json` is what the page reads for posted lines, leans, and the graded record. It is optional: the page simulates and projects without it.
- `data/pick-ledger/<date>.json` stays off the site. Each posted over/under line is logged once, with the model's chance at that line, before its game tips; later runs add the last posted price before the tip and the box-score result. A row's opening comparison (line, price, model chance) is never rewritten. A later card's comparison, or the same card against a newer price, is stored as the row's `last` while the game has not started, and the record grades `last` (falling back to the opening one): it is the forecast the page showed last, and what a replay of the last pre-tip card measures. `source: replay` days were rebuilt from archived pre-tip inputs by `npm run picks:backfill`; `source: live` days were logged before the tip, and a replay never touches them.
- The deploy job also runs `scripts/publish-sims.ts` on the built `dist/data`: it draws every playable game on the card with the seed the page derives (`fnv1a(event_id:generated_at)`) and 10,000 draws, and writes `data/sims/<event>.json` and `data/sims/index.json` (the index last). These are generated at deploy and never committed. They hold each game's summary and, per player and stat, the count of played draws at each value, so a phone fetches about 26 KB instead of running the draws. The page uses a published game only when its card hashes, seed, and draw count match and its counts add up; otherwise, and always for a viewer's lineup calls, it draws the game in the browser. A failure of that step does not block the deploy.
- `npm run calibrate-props` runs before the picks step on every refresh and cannot fail it. It refits the prop calibration maps (`data/prop-calibration/<group>.json` plus a dated report) from settled live ledger rows of the card's `model_version`, using walk-forward validation. A map ships only while it beats the raw simulation on later days it never saw. Maps are keyed to `model_version`, not `model_hash`, so a page-only change does not retire them; bump `MODEL_VERSION` when the simulation changes. MODEL_SPEC.md has the gates.
- The rate-card job attaches the ESPN scoreboard's current point spreads (`spread_quotes`: book, home handicap, both prices, capture time) to pregame games in the published `slate.json`, after fitting and hashing. They never enter fitting, the input hash, or sampling. The manifest's `slate_hash` covers the published file, quotes included.
- `publish-sims.ts` also writes `daily` into `data/sims/index.json`: for each game still to tip at deploy, the best qualifying player prop (a listed lean at the best current book price) and game spread, read from the same draws. It is tied to the slate hash and the picks build. The page shows the best one whose game has not tipped and whose price is at most six hours old, and says why a category is empty. The daily picks are display only: they never feed the ledger, the record, or fitting.
- The picks step runs after the rate card is built and cannot fail the refresh. A failure leaves the last `picks.json` in place, and the page ignores published leans from another card.
- `public/data/matchups.json` is optional and is not in the manifest. The refresh reads the shooting cache and the committed slate and rate card after picks, and a failure leaves the previous file without failing the rate-card job. The file is still built and the page no longer shows it. Every game's verdict is NO BET. The report is descriptive.
- The rate card is not published until the shooting cache contains some free-throw attempts.
- Scheduled data commits may use `github-actions[bot]`. Human and agent commits use `Harsh4873` only.

## Privacy

This repository deploys publicly. Never write the owner's real name, personal email, home location, or other personal details into committed files or commit messages. Refer to the owner generically. The GitHub identity `Harsh4873` is the only owner reference that belongs in the repo.

## Verification

- Run `npm test`, `npm run typecheck`, and `npm run build` before publishing.
- Do not open the live site or a browser to verify. The owner checks production.
- Do not add a `CNAME`.

## Ship every change to harsh.bet

A request to add a feature, fix a bug, or change this app is standing permission to deploy it to the harsh.bet domain in the same session.

1. Implement and verify from source using this repository's tests, typecheck, and build.
2. Commit on `main` as GitHub user `Harsh4873` (`Harsh4873 <43502626+Harsh4873@users.noreply.github.com>`) after `gh api user` shows that login. Verify the commit author. Never invent or switch identity.
3. Keep commit messages and code free of AI fingerprints: no `Co-authored-by:` trailers and no tool taglines, comments, or metadata. If the environment injects a trailer, rewrite the commit with git plumbing (`git commit-tree`) before pushing so GitHub never sees an AI co-author.
4. Push to `origin/main`. That push runs `.github/workflows/deploy-pages.yml`.
5. Confirm the workflow with `gh run list` and `gh run view`.

Do not force-push to `main`. Leave unrelated dirty files out of the commit.

The repository name is the route. Pages source is GitHub Actions. `configure-pages` fails until Settings, Pages, Source is GitHub Actions. A workflow token cannot enable that. Enable it once with an admin token: `gh api --method POST repos/Harsh4873/simulator/pages -f build_type=workflow`.
