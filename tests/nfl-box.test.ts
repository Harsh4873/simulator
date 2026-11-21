import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import { parseFeedSlate, renderFeedSlate, type FeedGame, type FeedSlate } from '../src/feed.ts';
import { boxLine, playNflGame, renderNflBox, sideShares } from '../src/nfl/box.ts';
import { IDENTITY_CALIBRATION, nflSeed, planGame, publishCalibration, publishPlan, readCalibration, simulateGame } from '../src/nfl/projection.ts';
import type { RateCard, Slate } from '../src/types.ts';
import { season } from './helpers/nfl-season.ts';

const band = (b: { mean: number; p10: number; p50: number; p90: number }) => ({ mean: Math.round(b.mean * 10) / 10, p10: Math.round(b.p10 * 10) / 10, p50: Math.round(b.p50 * 10) / 10, p90: Math.round(b.p90 * 10) / 10 });

/** A game card with a published plan, built the way the NFL builder builds one. */
function plannedGame(now: Date, status: FeedGame['status'] = 'scheduled'): FeedGame {
  const games = season(8);
  const built = planGame(games, 'AAA', 'DDD', false, Date.parse('2026-12-01T00:00:00Z'));
  const plans = { home: publishPlan(built.home), away: publishPlan(built.away) };
  const calibration = { ...IDENTITY_CALIBRATION, temperature: 0.85, spread: { rec_yds: 1.1 }, bias: { 'WR:rec_yds': 0.98 } };
  const sim = simulateGame(plans.home, plans.away, false, 10_000, nflSeed('g1'), calibration).projection;
  const side = (name: string, abbreviation: string, score: number | null) => ({ name, abbreviation, score, logo_url: null, color: null, alternate_color: null });
  const final = status === 'final';
  return {
    id: 'g1',
    start_time: new Date(now.getTime() + (final ? -86_400_000 : 3_600_000)).toISOString(),
    status,
    listed: false,
    away: side('Delta Team', 'DDD', final ? 17 : null),
    home: side('Alpha Team', 'AAA', final ? 27 : null),
    venue: 'Alpha Field',
    neutral_site: false,
    competition: null,
    projection: { kind: 'game', away_win: 1 - sim.home_win, home_win: sim.home_win, summary: 'DDD · AAA' },
    projection_note: 'Simulated from box scores before kickoff.',
    sim: {
      draws: sim.draws,
      away_points: band(sim.away_points),
      home_points: band(sim.home_points),
      margin: band(sim.margin),
      combined: band(sim.combined),
      home_win: Math.round(sim.home_win * 1000) / 1000,
      players: final ? [{ id: 'AAA-wr0', name: 'AAA Receiver 0', side: 'home', position: 'WR', status: null, play: 1, stats: { rec_yds: { mean: 50, p10: 20, p50: 48, p90: 85 } }, td: 0.4, actual: { rec_yds: 61 } }] : [],
      plan: { neutral: false, home: plans.home, away: plans.away, calibration: publishCalibration(calibration) },
    },
  };
}

function slateWith(game: FeedGame, now: Date): FeedSlate {
  const today = chicagoDate(now);
  return {
    sport: 'nfl',
    source: 'ESPN NFL scoreboard and box scores',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [shiftChicagoDate(today, -1), today],
    games: [game],
    later: [],
    model: { fitted: true, name: 'nfl-sim-v1', note: 'Each game is played 10,000 times.', holdout_games: 103, holdout_brier: 0.213 },
  };
}

test('the page replays the published plan with the build\'s seed, so the box score matches the card', () => {
  const now = new Date('2026-11-21T18:00:00Z');
  const game = parseFeedSlate(JSON.stringify(slateWith(plannedGame(now), now)), 'nfl')!.games[0]!;
  const box = playNflGame(game)!;
  assert.ok(box);
  assert.equal(Math.round(box.result.projection.home_points.mean * 10) / 10, game.sim!.home_points.mean);
  assert.equal(Math.round(box.result.projection.home_win * 1000) / 1000, game.sim!.home_win);
  // The published calibration is read back field for field; the range scale travels as `ranges`.
  assert.deepEqual(readCalibration(game.sim!.plan!.calibration).spread, { rec_yds: 1.1 });
  assert.equal(JSON.stringify(game.sim!.plan).includes('"spread"'), false);
  const shares = sideShares(box.result, box.result.projection.draws);
  assert.ok(Math.abs(shares.away + shares.tie + shares.home - 1) < 1e-9);
  // A row is the player's average over every draw, his sits included, so a questionable player is pulled down.
  const receiver = game.sim!.plan!.home.players.find((player) => player.id === 'AAA-wr0')!;
  const line = boxLine(box.result, box.calibration, receiver, 'rec_yds');
  assert.ok(line.p10 <= line.mean && line.mean <= line.p90);
  assert.equal(playNflGame({ ...game, sim: { ...game.sim!, plan: null } }), null);
});

test('the NFL box score lays out the score, key numbers, charts and a passing, rushing and receiving table per side', () => {
  const now = new Date('2026-11-21T18:00:00Z');
  const scheduled = plannedGame(now);
  const html = renderNflBox(scheduled, playNflGame(scheduled)!, now);
  assert.match(html, /<button type="button" data-nfl-back>Back to games<\/button>/);
  assert.match(html, /<h2>DDD @ AAA<\/h2>/);
  assert.match(html, /class="scoreboard"/);
  assert.match(html, /Expected points from 10,000 games/);
  assert.match(html, /Win chance, calibrated on earlier weeks/);
  for (const block of ['nfl-box-score', 'nfl-box-charts', 'nfl-box-players', 'nfl-box-notes']) assert.match(html, new RegExp(`data-block="${block}"`));
  assert.equal((html.match(/<h3 class="stat-group-label">Passing<\/h3>/g) ?? []).length, 2);
  assert.equal((html.match(/<h3 class="stat-group-label">Rushing<\/h3>/g) ?? []).length, 2);
  assert.equal((html.match(/<h3 class="stat-group-label">Receiving<\/h3>/g) ?? []).length, 2);
  assert.match(html, /AAA Passer/);
  assert.match(html, /<th scope="row">Expected<\/th>/);
  assert.match(html, /<svg/);
  assert.equal(/odds|moneyline|sportsbook/i.test(html), false);
  const final = plannedGame(now, 'final');
  const finalHtml = renderNflBox(final, playNflGame(final)!, now);
  assert.match(finalHtml, /Final: DDD 17, AAA 27/);
  assert.match(finalHtml, /data-actual>Played 61</);
});

test('a card with a plan gets the Simulate button and leaves the player detail to the box score', () => {
  const now = new Date('2026-11-21T18:00:00Z');
  const planned = renderFeedSlate(parseFeedSlate(JSON.stringify(slateWith(plannedGame(now), now)), 'nfl')!, now);
  assert.match(planned, /<div class="card-actions"><button type="button" data-nfl-simulate="g1">Simulate<\/button><\/div>/);
  assert.doesNotMatch(planned, /<summary>Player projections<\/summary>/);
  // The card reads like an NBA card: the time, the matchup, then Simulate. The projection waits in the box score.
  assert.doesNotMatch(planned, /<p class="status">/);
  assert.doesNotMatch(planned, /feed-proj-score|class="nfl-sim"/);
  const older = slateWith(plannedGame(now), now);
  delete older.games[0]!.sim!.plan;
  older.games[0]!.sim!.players = [{ id: 'p', name: 'Some Player', side: 'home', position: 'WR', status: null, play: 1, stats: { rec: { mean: 3, p10: 1, p50: 3, p90: 5 } }, td: 0.2 }];
  const fallback = renderFeedSlate(parseFeedSlate(JSON.stringify(older), 'nfl')!, now);
  assert.doesNotMatch(fallback, /data-nfl-simulate/);
  assert.match(fallback, /<summary>Player projections<\/summary>/);
  // A plan that is out of range fails the file, as any broken block does.
  const broken = JSON.parse(JSON.stringify(slateWith(plannedGame(now), now)));
  broken.games[0].sim.plan.home.players[0].catchRate = 1.5;
  assert.equal(parseFeedSlate(JSON.stringify(broken), 'nfl'), null);
  const sneaky = JSON.parse(JSON.stringify(slateWith(plannedGame(now), now)));
  sneaky.games[0].sim.plan.calibration.spread = { rec: 1 };
  assert.equal(parseFeedSlate(JSON.stringify(sneaky), 'nfl'), null);
});

test('Simulate on an NFL card opens its box score in place of the games, and Back returns to them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-nfl-box-'));
  const timer = globalThis.setInterval;
  try {
    const { window, document } = parseHTML(readFileSync('index.html', 'utf8'));
    const globals = globalThis as unknown as Record<string, unknown>;
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Element', 'Event']) {
      globals[key] = (window as unknown as Record<string, unknown>)[key];
    }
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
    window.scrollTo = () => {};
    globals.scrollTo = () => {};
    let focused: Element | null = null;
    window.HTMLElement.prototype.focus = function focus(this: Element) {
      focused = this;
    };
    globals.CSS = { escape: (value: string) => value };
    const session = new Map<string, string>([['simulator.sport', 'nfl']]);
    globals.sessionStorage = { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => void session.set(key, value) };
    globals.localStorage = { getItem: () => null, setItem: () => {} };
    const now = new Date();
    const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
    const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
    card.generated_at = now.toISOString();
    slate.generated_at = card.generated_at;
    delete card.model_hash;
    const nfl = JSON.stringify(slateWith(plannedGame(now), now));
    globals.fetch = async (url: string) => {
      const text = String(url);
      const body = text.endsWith('/nfl.json') ? nfl : text.endsWith('/slate.json') ? JSON.stringify(slate) : text.endsWith('/rate-card.json') ? JSON.stringify(card) : '';
      return new Response(body, { status: body ? 200 : 404 });
    };
    globals.setInterval = () => 0;
    await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', outfile: join(dir, 'app.mjs'), loader: { '.css': 'empty' }, logLevel: 'silent' });
    await import(pathToFileURL(join(dir, 'app.mjs')).href);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    const games = document.querySelector<HTMLElement>('[data-region="games"]')!;
    const stage = document.querySelector<HTMLElement>('[data-region="stage"]')!;
    const button = document.querySelector<HTMLButtonElement>('[data-nfl-simulate="g1"]');
    assert.ok(button, 'the NFL card has a Simulate button');
    button.click();
    await settle();
    await settle();
    assert.equal(stage.hidden, false);
    assert.equal(games.hidden, true);
    const box = document.querySelector('#boxscore')!;
    assert.match(box.textContent ?? '', /DDD @ AAA/);
    assert.match(box.innerHTML, /<h3 class="stat-group-label">Receiving<\/h3>/);
    assert.equal(document.querySelector('.sim-screen'), null, 'the clock closes once the draws are done');
    assert.equal((focused as Element | null)?.hasAttribute('data-nfl-back'), true);

    // A player's name opens his sheet beside the box score, as an NBA name does.
    const frame = document.querySelector<HTMLElement>('[data-region="player"]')!;
    assert.equal(frame.hidden, true);
    const receiver = document.querySelector<HTMLButtonElement>('button[data-nfl-athlete="AAA-wr0"]');
    assert.ok(receiver, 'each row name is a button');
    receiver.click();
    assert.equal(frame.hidden, false);
    assert.match(frame.querySelector('.who-name')?.textContent ?? '', /AAA Receiver 0/);
    assert.match(frame.innerHTML, /Expected line/);
    assert.ok(frame.querySelector('[data-block="nfl-panel-charts"] svg'), 'the forecast draws his distribution');
    frame.querySelector<HTMLButtonElement>('[data-panel-tab="props"]')!.click();
    assert.equal(frame.querySelector<HTMLElement>('[data-panel-view="props"]')!.hidden, false);
    assert.match(frame.querySelector('[data-nfl-prop-results]')?.textContent ?? '', /Over [\d.]+\s*[\d.]+%/);
    const line = frame.querySelector<HTMLInputElement>('[data-nfl-prop-line]')!;
    line.value = '0.5';
    line.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(frame.querySelector('[data-nfl-prop-results]')?.textContent ?? '', /Over 0\.5/);
    const odds = frame.querySelector<HTMLInputElement>('[data-nfl-prop-odds]')!;
    odds.value = '-110';
    odds.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(frame.querySelector('[data-nfl-prop-results]')?.textContent ?? '', /Break-even\s*52\.4%/);
    frame.querySelector<HTMLButtonElement>('button[data-nfl-market="td"]')!.click();
    assert.match(frame.querySelector('[data-nfl-prop-results]')?.textContent ?? '', /Scores\s*[\d.]+%/);
    frame.querySelector<HTMLButtonElement>('[data-close]')!.click();
    assert.equal(frame.hidden, true);
    assert.equal((focused as Element | null)?.getAttribute('data-nfl-athlete'), 'AAA-wr0');

    // The line check reads a total against the same games.
    const total = document.querySelector<HTMLInputElement>('#boxscore input[data-game-line="total"]')!;
    total.value = '40.5';
    total.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.match(document.querySelector('#boxscore [data-line-result="total"]')?.textContent ?? '', /Above \d+\.\d%; below \d+\.\d%/);

    receiver.click();
    assert.equal(frame.hidden, false);
    document.querySelector<HTMLButtonElement>('[data-nfl-back]')!.click();
    assert.equal(frame.hidden, true, 'leaving the box score closes the sheet');
    await settle();
    assert.equal(stage.hidden, true);
    assert.equal(games.hidden, false);
    assert.equal(box.innerHTML, '');
    assert.equal((focused as Element | null)?.getAttribute('data-nfl-simulate'), 'g1');
  } finally {
    globalThis.setInterval = timer;
    rmSync(dir, { recursive: true, force: true });
  }
});
