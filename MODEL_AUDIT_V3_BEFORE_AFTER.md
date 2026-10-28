# Minutes and margin pass

Market odds were not an input. October 27 final scores were not used to fit anything. The frozen legacy card and the legacy sampler are unchanged.

## What changed

Participation is no longer "everyone with 3 or more logged games plays every draw." `P(play)` uses this season's appearances over the team's logged games, with a prior from last season's games and minutes. A player with no games this season, fewer than 20 games last season, and no shooting sample is a cameo: low `P(play)` and at most 12 minutes. Players who appeared in every logged team game this season stay in the rotation. Minutes are then shared only among the players who were drawn in, with a tighter Dirichlet concentration (320) and a 48-minute cap.

The headline is the mean of the 10,000 team scores, plus the mean and median margin and the share of draws won by 10 and by 20. The box score is one draw near that two-team mean, labeled as a draw. The 95th-percentile game is still the upside control.

A saved `pre` status after tip-off no longer says the game has not started.

## Kings, 300 paired draws on the frozen October 27 card

These are model expectations, not the final box score.

| Player | P(play) | Mean minutes | Plays |
|---|---:|---:|---:|
| Sean Pedulla | 0.08 | 1.0 | 9% |
| Leaky Black | 0.23 | cameo cap 12 | not every draw |
| Emanuel Sharp | 0.85 | 22.9 | 83% |
| Zach LaVine | 0.90 | 31.1 | 90% |
| Domantas Sabonis | 0.85 | 26.6 | 85% |

Sharp still plays often because the counting log has him in all 3 Kings games already stored. His shot rates are still the prior. Pedulla does not.

## Nets at Celtics, 500 draws

Mean score about 113–103, Nets by 10.5. The Nets are ahead by 10 or more in 51% of draws and by 20 or more in 38%. Boston is ahead by 10 or more in 24%. That is the same direction as the earlier independent card. It was not pulled toward the market, and it was not fit to the overtime final.

## Not done

There is no new opponent or pace model fitted on held-out games. The shooting cache still has no 2027 rows, so this pass did not rebuild Tatum's shot rates. There is no walk-forward backtest, so this is not a betting model. The participation prior is a fixed rule on the fields the card already stores, not a coefficient estimated from historical DNPs.
