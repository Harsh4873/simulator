// Score sim v2 against v1 on the same regular-season boxes. Minutes are the minutes that were played,
// so this is the production rate, not a pre-tip minutes forecast. Team ratings are not refit.
import { readFileSync } from 'node:fs';
import { attachPlayCache } from './play-cache.ts';
import { samplePointsGivenMinutes } from '../src/simulate.ts';
import { fitVarianceScale, kMinutesOf, productionRatio, selectShrinkage, shrunkPointsPerMinute, type BoxAppearance, type ScoredAppearance } from '../src/sim-v2.ts';
import { priorPointsPerMinute } from '../src/fit.ts';
import type { ShootingCache, RatePlayer } from '../src/types.ts';
import type { CompletedEvent, ParsedPlayerGame } from '../src/parse-summary.ts';

const scoreGames = Number(process.env.SIM_V2_SCORE_GAMES ?? 60);
if (!Number.isInteger(scoreGames) || scoreGames < 10) throw new Error('SIM_V2_SCORE_GAMES must be an integer of at least 10');

const cache = JSON.parse(readFileSync('data/shooting-cache.json', 'utf8')) as ShootingCache;
attachPlayCache(cache, 'data/shooting-cache.json');
const events = (cache.events ?? []).filter((event) => event.season_type === 2).sort((a, b) => a.start_time.localeCompare(b.start_time));
if (events.length < scoreGames + 30) throw new Error('Not enough regular-season games in the shooting cache');
const activeSeason = Math.max(...events.map((event) => event.season));

interface App extends BoxAppearance {
  fga: number;
  fta: number;
  tpa: number;
  tpm: number;
  fgm: number;
  ftm: number;
}

const byPlayer = new Map<string, App[]>();
const MIN_OLDER_MINUTES = 48;
function qualifies(history: readonly App[]): boolean {
  if (history.length < 9) return false;
  const older = history.slice(0, history.length - 8);
  return older.reduce((sum, row) => sum + row.minutes, 0) >= MIN_OLDER_MINUTES;
}

interface Row extends ScoredAppearance {
  event: CompletedEvent;
  player: ParsedPlayerGame;
  historyApps: App[];
}

const rows: Row[] = [];
for (const event of events) {
  if (event.season !== activeSeason) continue;
  for (const player of event.players) {
    if (!(player.minutes > 0)) continue;
    const prior = byPlayer.get(player.athlete_id) ?? [];
    if (qualifies(prior)) {
      rows.push({
        event,
        player,
        historyApps: prior.slice(),
        history: prior.map((row) => ({ minutes: row.minutes, points: row.points })),
        minutes: player.minutes,
        points: player.pts,
      });
    }
    const next: App = {
      minutes: player.minutes,
      points: player.pts,
      fga: player.fga,
      fta: player.fta,
      tpa: player.tpa,
      tpm: player.tpm,
      fgm: player.fgm,
      ftm: player.ftm,
    };
    const list = byPlayer.get(player.athlete_id);
    if (list) list.push(next);
    else byPlayer.set(player.athlete_id, [next]);
  }
}

const scoreEventIds = new Set(events.filter((event) => event.season === activeSeason).slice(-scoreGames).map((event) => event.event_id));
const fitRows = rows.filter((row) => !scoreEventIds.has(row.event.event_id));
const scoreRows = rows.filter((row) => scoreEventIds.has(row.event.event_id));
const shrinkage = selectShrinkage(fitRows);
if (!shrinkage) throw new Error('No fit rows for the shrinkage weight');
const kMinutes = kMinutesOf(shrinkage);

function rate(row: Row, model: 'v1' | 'v2'): number | null {
  return shrunkPointsPerMinute(row.history, model === 'v1' ? Number.POSITIVE_INFINITY : kMinutes);
}

function mae(model: 'v1' | 'v2', sample: Row[]): number | null {
  let n = 0;
  let abs = 0;
  for (const row of sample) {
    const ppm = rate(row, model);
    if (ppm === null) continue;
    abs += Math.abs(ppm * row.minutes - row.points);
    n += 1;
  }
  return n ? abs / n : null;
}

const Z90 = 1.2815515655446004;
function residualSd(model: 'v1' | 'v2', sample: Row[]): number | null {
  const errors: number[] = [];
  for (const row of sample) {
    const ppm = rate(row, model);
    if (ppm === null) continue;
    errors.push(row.points - ppm * row.minutes);
  }
  if (errors.length < 2) return null;
  const mean = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  return Math.sqrt(errors.reduce((sum, value) => sum + (value - mean) ** 2, 0) / errors.length);
}

function coverage(model: 'v1' | 'v2', sample: Row[], spread: number): number | null {
  let n = 0;
  let hit = 0;
  for (const row of sample) {
    const ppm = rate(row, model);
    if (ppm === null) continue;
    const mean = ppm * row.minutes;
    n += 1;
    if (row.points >= mean - Z90 * spread && row.points <= mean + Z90 * spread) hit += 1;
  }
  return n ? hit / n : null;
}

function logScore(model: 'v1' | 'v2', sample: Row[], spread: number): number | null {
  if (!(spread > 0)) return null;
  let n = 0;
  let total = 0;
  const variance = spread * spread;
  for (const row of sample) {
    const ppm = rate(row, model);
    if (ppm === null) continue;
    const error = row.points - ppm * row.minutes;
    total += 0.5 * Math.log(2 * Math.PI * variance) + (error * error) / (2 * variance);
    n += 1;
  }
  return n ? total / n : null;
}

function margin(model: 'v1' | 'v2'): { mae: number; games: number } | null {
  const byEvent = new Map<string, Row[]>();
  for (const row of scoreRows) {
    const list = byEvent.get(row.event.event_id);
    if (list) list.push(row);
    else byEvent.set(row.event.event_id, [row]);
  }
  let n = 0;
  let abs = 0;
  for (const group of byEvent.values()) {
    let homeActual = 0;
    let awayActual = 0;
    let homePred = 0;
    let awayPred = 0;
    let home = 0;
    let away = 0;
    for (const row of group) {
      const ppm = rate(row, model);
      if (ppm === null) continue;
      const predicted = ppm * row.minutes;
      if (row.player.team_id === row.event.home_team_id) {
        home += 1;
        homeActual += row.points;
        homePred += predicted;
      } else if (row.player.team_id === row.event.away_team_id) {
        away += 1;
        awayActual += row.points;
        awayPred += predicted;
      }
    }
    if (home < 3 || away < 3) continue;
    n += 1;
    abs += Math.abs(homePred - awayPred - (homeActual - awayActual));
  }
  return n ? { mae: abs / n, games: n } : null;
}

function countingPlayer(history: readonly App[], minutes: number, scale?: number): RatePlayer {
  let min = 0;
  let fga = 0;
  let fta = 0;
  let tpa = 0;
  let tpm = 0;
  let fgm = 0;
  let ftm = 0;
  for (const row of history) {
    min += row.minutes;
    fga += row.fga;
    fta += row.fta;
    tpa += row.tpa;
    tpm += row.tpm;
    fgm += row.fgm;
    ftm += row.ftm;
  }
  const share = fga > 0 ? Math.min(1, tpa / fga) : 0.36;
  const twos = fga - tpa;
  const fg2 = twos > 0 ? Math.min(1, Math.max(0, (fgm - tpm) / twos)) : 0.5;
  const tp = tpa > 0 ? Math.min(1, tpm / tpa) : 0.36;
  const ft = fta > 0 ? Math.min(1, ftm / fta) : 0.78;
  return {
    athlete_id: 'sample',
    name: 'sample',
    team_id: 't',
    position: 'G',
    position_group: 'Guard',
    injury_status: 'healthy',
    minutes_weight: 1,
    questionable_widen: false,
    games_2026: 0,
    games_2027: history.length,
    games: history.length,
    shooting_games: history.length,
    thin_sample: false,
    minutes_mean: minutes,
    fga_per_min: min > 0 ? fga / min : 0.2,
    fta_per_min: min > 0 ? fta / min : 0.05,
    tpa_given_fga: share,
    fg2_pct: fg2,
    tp_pct: tp,
    ft_pct: ft,
    reb_per_min: 0.12,
    ast_per_min: 0.08,
    ...(scale !== undefined && scale < 1 ? { sim_v2_variance_scale: scale } : {}),
  };
}

function sd(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length));
}

const probe = fitRows.filter((row) => row.minutes >= 12 && row.minutes <= 40).slice(0, 300);
const residuals: number[] = [];
const modelSds: number[] = [];
probe.forEach((row, index) => {
  const player = countingPlayer(row.historyApps, row.minutes);
  const draws = samplePointsGivenMinutes(player, row.minutes, 80, 1000 + index);
  const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
  residuals.push(row.points - mean);
  modelSds.push(sd(draws));
});
const empiricalSd = sd(residuals);
const modelSd = Math.sqrt(modelSds.reduce((sum, value) => sum + value * value, 0) / Math.max(1, modelSds.length));
const variance = fitVarianceScale(empiricalSd, modelSd);

let achievedSd = modelSd;
if (variance.tightened) {
  const scaled: number[] = [];
  probe.forEach((row, index) => {
    const player = countingPlayer(row.historyApps, row.minutes, variance.scale);
    scaled.push(sd(samplePointsGivenMinutes(player, row.minutes, 80, 1000 + index)));
  });
  achievedSd = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0) / Math.max(1, scaled.length));
}

const v1Spread = residualSd('v1', fitRows);
const v2Spread = residualSd('v2', fitRows);
const example = scoreRows[0];
const exampleRatio = example ? productionRatio(example.history, kMinutes) : 1;
const exampleMean = example ? priorPointsPerMinute(countingPlayer(example.historyApps, example.minutes)) : null;

const fitEvents = events.filter((event) => event.season === activeSeason && !scoreEventIds.has(event.event_id));
const scoredEvents = events.filter((event) => scoreEventIds.has(event.event_id));
const report = {
  version: 'possessions-v9-sim-v2',
  v1: 'possessions-v9',
  published_card: 'unchanged. Team offense, defense and pace are the v1 fit.',
  season: activeSeason,
  fit: {
    games: fitEvents.length,
    from: fitEvents[0]?.start_time.slice(0, 10) ?? null,
    to: fitEvents.at(-1)?.start_time.slice(0, 10) ?? null,
    player_games: fitRows.length,
  },
  score: {
    games: scoredEvents.length,
    from: scoredEvents[0]?.start_time.slice(0, 10) ?? null,
    to: scoredEvents.at(-1)?.start_time.slice(0, 10) ?? null,
    player_games: scoreRows.length,
  },
  shrinkage: {
    k_minutes: shrinkage.kMinutes,
    fit_mae: shrinkage.mae,
    by_k: shrinkage.byK.map((row) => ({ k_minutes: row.kMinutes, mae: Number(row.mae.toFixed(4)) })),
  },
  points: {
    given: 'minutes that were played',
    v1_mae: mae('v1', scoreRows),
    v2_mae: mae('v2', scoreRows),
    v1_log_score: v1Spread ? logScore('v1', scoreRows, v1Spread) : null,
    v2_log_score: v2Spread ? logScore('v2', scoreRows, v2Spread) : null,
    v1_fit_sd: v1Spread,
    v2_fit_sd: v2Spread,
    v1_coverage80: v1Spread ? coverage('v1', scoreRows, v1Spread) : null,
    v2_coverage80: v2Spread ? coverage('v2', scoreRows, v2Spread) : null,
  },
  margin: {
    given: 'minutes that were played, players with a season rate only',
    note: 'Pre-tip margin from the team rating is the same in both models.',
    v1: margin('v1'),
    v2: margin('v2'),
  },
  variance: {
    ...variance,
    probe_player_games: probe.length,
    draws_each: 80,
    achieved_model_sd: achievedSd,
    example_production_ratio: exampleRatio,
    example_v1_points_per_minute: exampleMean,
  },
};
console.log(JSON.stringify(report, null, 2));
