import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PRIOR_SEASON_WEIGHT,
  DEFAULT_TEAM_PENALTY,
  PRIOR_WEIGHT_CANDIDATES,
  TEAM_PENALTY_CANDIDATES,
  fitTeamEffects,
} from '../src/team-effects.ts';
import { eventPossessions } from '../src/team-model.ts';
import { eligibleEvents } from '../src/team-model.ts';
import type { ShootingCache } from '../src/types.ts';

test('empty events keep the labelled default ridge', () => {
  const e = fitTeamEffects([], () => 100);
  assert.equal(e.games, 0);
  assert.equal(e.team_penalty, DEFAULT_TEAM_PENALTY);
  assert.equal(e.prior_season_weight, DEFAULT_PRIOR_SEASON_WEIGHT);
  assert.equal(e.holdout_mae, null);
});

test('chronological holdout picks a penalty and prior weight from the candidate grid', { timeout: 60_000 }, () => {
  const cache = JSON.parse(readFileSync('data/shooting-cache.json', 'utf8')) as ShootingCache;
  const events = eligibleEvents(cache.events ?? [], '2026-11-04T12:00:00Z');
  assert.ok(events.length >= 50, `need a real history, got ${events.length}`);
  const effects = fitTeamEffects(events, eventPossessions);
  assert.ok((TEAM_PENALTY_CANDIDATES as readonly number[]).includes(effects.team_penalty), String(effects.team_penalty));
  assert.ok((PRIOR_WEIGHT_CANDIDATES as readonly number[]).includes(effects.prior_season_weight), String(effects.prior_season_weight));
  assert.ok(effects.holdout_games > 0);
  assert.ok(effects.holdout_mae !== null && effects.holdout_mae > 0);
  const offenses = Object.values(effects.offense);
  assert.ok(Math.max(...offenses) / Math.min(...offenses) > 1.03);
});
