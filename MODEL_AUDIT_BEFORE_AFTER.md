# Model audit before and after

The frozen rate card is `tests/fixtures/rate-card-2026-10-27.json` (`generated_at` 2026-10-27T21:31:55Z). Each row is 1,000 paired draws. Legacy and revised use the same seed, `iterationSeed(fnv1a(event id + ":" + generated_at), index)`.

Market odds were not an input. The sampler does not read a spread, a price, or a side the card should beat. A Nets result above a Celtics result is a legal draw.

## Team scores

| Game | Model | Away mean | Away median | Home mean | Home median | Away wins | Ties | Home wins |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 401909877 Brooklyn Nets at Boston Celtics | Legacy | 111.08 | 110 | 102.72 | 102 | 609 | 18 | 373 |
| 401909877 Brooklyn Nets at Boston Celtics | Revised | 111.14 | 109 | 100.84 | 100 | 644 | 0 | 356 |
| 401909878 Detroit Pistons at New York Knicks | Legacy | 113.91 | 113 | 118.36 | 117 | 446 | 13 | 541 |
| 401909878 Detroit Pistons at New York Knicks | Revised | 114.12 | 114 | 117.51 | 117 | 464 | 0 | 536 |
| 401909879 Sacramento Kings at San Antonio Spurs | Legacy | 111.87 | 110 | 121.56 | 120 | 353 | 16 | 631 |
| 401909879 Sacramento Kings at San Antonio Spurs | Revised | 110.55 | 109 | 121.50 | 121 | 348 | 0 | 652 |
| 401909880 Portland Trail Blazers at Los Angeles Lakers | Legacy | 117.16 | 116 | 122.94 | 122 | 410 | 20 | 570 |
| 401909880 Portland Trail Blazers at Los Angeles Lakers | Revised | 118.08 | 117 | 124.33 | 124 | 424 | 0 | 576 |

## Players

Shot rates on the frozen card were not rewritten. Missing shooting means `shooting_games === 0`, which the sampler treats as missing even when the card has no `missing_shooting` field.

| Player | Game | Model | Expected minutes | Expected points | Share at 0 minutes | Missing shooting |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Moritz Wagner | 401909877 Brooklyn Nets at Boston Celtics | Legacy | 8.67 | 5.25 | 0.0% | no |
| Moritz Wagner | 401909877 Brooklyn Nets at Boston Celtics | Revised | 9.79 | 5.87 | 0.0% | no |
| Chris Cenac Jr. | 401909877 Brooklyn Nets at Boston Celtics | Legacy | 15.41 | 7.34 | 0.0% | yes |
| Chris Cenac Jr. | 401909877 Brooklyn Nets at Boston Celtics | Revised | 2.37 | 1.11 | 78.5% | yes |
| Jayson Tatum | 401909877 Brooklyn Nets at Boston Celtics | Legacy | 20.96 | 10.10 | 0.0% | yes |
| Jayson Tatum | 401909877 Brooklyn Nets at Boston Celtics | Revised | 23.24 | 11.13 | 0.0% | yes |
| Nolan Traoré | 401909877 Brooklyn Nets at Boston Celtics | Legacy | 14.42 | 5.74 | 0.0% | no |
| Nolan Traoré | 401909877 Brooklyn Nets at Boston Celtics | Revised | 15.97 | 6.40 | 0.0% | no |
| Karl-Anthony Towns | 401909878 Detroit Pistons at New York Knicks | Legacy | 20.35 | 12.76 | 0.0% | no |
| Karl-Anthony Towns | 401909878 Detroit Pistons at New York Knicks | Revised | 22.97 | 14.16 | 0.0% | no |

## What moved

Unobserved players leave the 240-minute pool. A player with no shooting games and fewer than 3 games draws one uniform and plays only when it is below 0.2. The minutes they used to absorb go to teammates who are playing. Chris Cenac Jr. is that profile: expected minutes are about 0.2 times a draw under a 12-minute cap, so the mean stays under 5 and most draws are 0. Players with a shooting sample, including Moritz Wagner, keep the shrunk shot rates already on the card and stay in the minutes draw. Overtime is not a coin. Both teams are drawn at 240 first. Extra 25-minute periods are added only when the regulation totals tie, on the same participants and the same team shock. A returned game has different final scores.

Team totals and win counts move because those minute and overtime rules change who is on the floor. The table is that reallocation.
