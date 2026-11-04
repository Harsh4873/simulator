import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitTeamEffects } from '../src/team-effects.ts';
import { eligibleEvents, eventPossessions } from '../src/team-model.ts';
import { mean, reliability, scoreProbability } from '../src/evaluation.ts';
import type { ShootingCache } from '../src/types.ts';

function erf(x: number): number {
  const s = Math.sign(x), a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

test('dropping geometric-mean compression raises favorite confidence without using market lines', { timeout: 60_000 }, () => {
  const cache = JSON.parse(readFileSync('data/shooting-cache.json', 'utf8')) as ShootingCache;
  const events = eligibleEvents(cache.events ?? [], '2026-11-04T12:00:00Z');
  const split = Math.floor(events.length * 0.8);
  const train = events.slice(0, split);
  const hold = events.slice(split);
  assert.ok(train.length >= 80 && hold.length >= 20, `history ${train.length}/${hold.length}`);
  const effects = fitTeamEffects(train, eventPossessions);
  const league = mean(Object.values(effects.offense));
  const sd = Math.max(10, (effects.residual_sd || 0.12) * 100);
  const predict = (compress: boolean) => hold.map(e => {
    const shrink = (value: number) => (compress ? Math.sqrt(Math.max(0.01, value) * league) : value);
    const home = shrink(effects.offense[e.home_team_id] ?? league) * shrink(effects.defense[e.away_team_id] ?? league) / league * Math.exp(e.neutral ? 0 : effects.home);
    const away = shrink(effects.offense[e.away_team_id] ?? league) * shrink(effects.defense[e.home_team_id] ?? league) / league;
    const pace = (eventPossessions(e, e.home_team_id) + eventPossessions(e, e.away_team_id)) / 2;
    const margin = pace * (home - away);
    const p = Math.min(0.999, Math.max(0.001, normalCdf(margin / sd)));
    const y = e.home_pts > e.away_pts;
    return { p, y: Number(y), margin, brier: scoreProbability(p, y).brier };
  });
  const compressed = predict(true);
  const unshrunk = predict(false);
  assert.ok(mean(unshrunk.map(r => Math.abs(r.p - 0.5))) > mean(compressed.map(r => Math.abs(r.p - 0.5))));
  const favorites = (rows: typeof unshrunk) => rows.filter(r => r.p >= 0.7 || r.p <= 0.3);
  const favUn = favorites(unshrunk), favComp = favorites(compressed);
  assert.ok(favUn.length >= 5, `need held-out favorites, got ${favUn.length}`);
  const brierUn = mean(unshrunk.map(r => r.brier));
  const brierComp = mean(compressed.map(r => r.brier));
  const favBrierUn = mean(favUn.map(r => r.brier));
  const favBrierComp = mean(favComp.length ? favComp.map(r => r.brier) : favUn.map(r => r.brier));
  assert.ok(brierUn <= brierComp + 0.02, `unshrunk Brier ${brierUn.toFixed(4)} vs compressed ${brierComp.toFixed(4)}`);
  const cal = reliability(unshrunk);
  assert.ok(cal.ece < 0.2, `walk-forward ECE ${cal.ece}`);
  assert.ok(favBrierUn <= favBrierComp + 0.03 || favUn.length > favComp.length);
});
