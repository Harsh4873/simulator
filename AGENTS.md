# Simulator maintenance

This repository is the public NBA simulator at `/simulator/`.

The page lists today's NBA games in America/Chicago. Simulate draws 10,000 independent games in the browser from the committed rate card. It is a simulator, not a betting ticket. The spread caption is visible text. The sampler does not read it.

## Data

- `public/data/slate.json` and `public/data/rate-card.json` are what the browser reads.
- `data/shooting-cache.json` stays off the site. It is not under `public/` and is not copied into `dist/`.
- `.github/workflows/refresh-rate-card.yml` rebuilds those files. Its concurrency group is `simulator-rate-card`. Do not join `pick-cache-writer`.
- After a data push, that job dispatches `deploy-pages.yml`. A token push does not emit `push`, so the site would otherwise keep the previous artifact.
- The job may call the ESPN scoreboard, team index, roster, injuries, and box-score summary endpoints, and it may read PickLedger's public outcome gzip. It does not call `stats.nba.com`. It does not scrape CBS or Rotowire. It does not call the player gamelog URL. Summary requests are limited to event ids already in the 2026 and 2027 outcome rows, at most 400 new events a run.
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
