# Sim v2

Sim v2 is a side path. The published card stays `possessions-v9`. Nothing here changes pace, offense, defense, or the rate card the page reads.

The question was whether a short run of points per minute should move a player's shot and free-throw rates, and whether v1's counting draws are wider than the games he has already played. Prices, spreads, and book lines are not inputs.

## Sources

[Four Factors](https://www.basketball-reference.com/about/factors.html) (Basketball-Reference, Dean Oliver). A team's box score splits into shooting, turnovers, rebounding, and free throws, with no betting line. v1 already fits those pieces: shooting rates, turnover rate, rebound rate, and free-throw trip rate. v2 does not add a second copy.

[A Multiresolution Stochastic Process Model for Predicting Basketball Possession Outcomes](https://arxiv.org/abs/1408.0777) (Cervone, D'Amour, Bornn, and Goldsberry, arXiv:1408.0777, Journal of the American Statistical Association 2016). Expected possession value is the points still to come on this possession, from optical tracking of all ten players. The paper does not use a betting line. Rejected here: the cache is box scores, and this branch does not add a tracking feed.

[Introducing RAPTOR](https://web.archive.org/web/20191015125623/https://fivethirtyeight.com/features/introducing-raptor-our-new-metric-for-the-modern-nba/) (FiveThirtyEight, archived 15 October 2019). The on-court/off-court piece is useful and noisy, so the published blend leans on the box-score piece. Descriptive RAPTOR does not use a height, weight, or age prior. Adopted only as the shrinkage idea: a short sample moves toward a larger box sample. Rejected as a number to paste in. RAPTOR is points per 100 possessions above average, it wants tracking, and it is not a next-game points rate.

Pythagorean expectation, the public win estimate from points scored and points allowed, was rejected. It is a season win rate. It does not say what a player scores in his next game.

Not used: a flat next-man-up multiplier, and any replacement of the fitted creator-off usage with a constant.

## What v2 does

v1's player rates already shrink a season of shots toward a position and a team (`K_RATE_MINUTES` in `src/fit.ts`) and blend the points log with the shooting prior (`K_MINUTES`). That weight is fixed. v2 does not replace it.

`src/sim-v2.ts` looks at the last 8 games with minutes, after at least 48 minutes of older games this season. It shrinks those recent points per minute toward the older season rate:

`(recent points + k * season rate) / (recent minutes + k)`

`k` is chosen on earlier games and then frozen. The grid is 0, 80, 160, 320, 640, and the season rate alone. The lowest given-minutes points error wins. A tie keeps the stronger pull toward the season rate. The winner scales that player's v1 field-goal and free-throw rates by `shrunk / season`. Scaling by 1 leaves v1. The copy is a new player object. The fitted v1 player is not rewritten.

`fitVarianceScale` compares the spread of played points with the spread of `drawStats` at those same minutes and a team shock of 1. If played games are at least 98% as wide as those draws, the scale stays 1. If they are tighter, the scale is their ratio, and it stops at 0.55. A scale below 1 raises the gamma shape in `drawStats` (`phi / scale^2`), which tightens the volume multiplier and leaves the mean. The published game has a team context, so it draws possessions and does not call `drawStats`. The scale does not move the page.

## How it was scored

`npm run sim-v2` reads `data/shooting-cache.json`. It does not call `stats.nba.com`. Minutes are the minutes that were played, so the points error is the rate, not a forecast of who sits. The same players and the same minutes are used for both models.

The season in the cache is 2027. The score set is the last 60 regular-season games, 14 November 2026 through 22 November 2026, 850 player-games. The fit set is every earlier game this season, 20 October 2026 through 14 November 2026, 180 games and 245 player-games. 14 November appears in both labels because that day's games are split by tip. No game is in both sets. Players need 8 recent games and 48 older minutes before they enter, which is why the early fit has fewer player-games than the score set.

Command: `npm run sim-v2` from this worktree (`node --experimental-strip-types scripts/sim-v2-compare.ts`).

| | v1 | v2 | v2 minus v1 |
| --- | ---: | ---: | ---: |
| Player points MAE, given minutes | 4.505 | 4.387 | -0.118 |
| Player points log score, given minutes | 3.228 | 3.172 | -0.056 |
| Residual SD on the fit | 6.917 | 6.087 | -0.830 |
| Share of score-set points inside the fit's 10th-to-90th band | 0.871 | 0.852 | -0.019 |
| Margin MAE, given minutes, 59 games | 15.055 | 15.045 | -0.010 |

The frozen weight is 80 minutes of the older season rate. On the fit, that MAE is 4.607. The season rate alone is 5.328. Using only the last 8 games is 4.686.

v2's band is narrower and still holds more than 8 in 10 outcomes on the games it did not fit. That is not a failed interval. The margin change is a hundredth of a point. Pre-tip margin from the team rating is the same number in both models, because v2 does not refit offense, defense, or pace.

On 227 fit player-games, 80 `drawStats` draws each, the played spread was 5.996 points and v1's counting draws were 6.941. The scale is 0.864. After the gamma change those draws are 6.650, still wider than the boxes, because makes and free throws stay binomial and Poisson. The variance is tightened there and nowhere else.

v2 is the better points-per-minute description on this split. It is not a better game model. The page keeps v1.
