import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chicagoDate, shiftChicagoDate } from '../src/date.ts';
import type { RateCard, Slate } from '../src/types.ts';

const KNOWN_DATA = [
  '/slate.json',
  '/rate-card.json',
  '/manifest.json',
  '/health.json',
  '/picks.json',
  '/matchups.json',
  '/prop-calibration.json',
  '/sims/index.json',
  '/nfl.json',
  '/esports.json',
];

function nflFile(now: Date): string {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  const side = { score: null, logo_url: null, color: null, alternate_color: null };
  return JSON.stringify({
    sport: 'nfl',
    source: 'ESPN NFL scoreboard',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    later: [],
    model: { fitted: false, name: 'none', note: 'Projection is not fitted.', holdout_games: null, holdout_brier: null },
    games: [{
      id: '401',
      start_time: new Date(now.getTime() + 3_600_000).toISOString(),
      status: 'scheduled',
      listed: false,
      away: { ...side, name: 'Indianapolis Colts', abbreviation: 'IND' },
      home: { ...side, name: 'Houston Texans', abbreviation: 'HOU' },
      venue: 'NRG Stadium',
      neutral_site: false,
      competition: null,
      projection: null,
      projection_note: 'Projection is not fitted.',
    }],
  });
}

function esportsFile(now: Date): string {
  const today = chicagoDate(now);
  const yesterday = shiftChicagoDate(today, -1);
  return JSON.stringify({
    sport: 'esports',
    generated_at: now.toISOString(),
    timezone: 'America/Chicago',
    dates: [yesterday, today],
    model: {
      name: 'esports-player-means-v1',
      fitted: true,
      note: 'Each number is the player mean on earlier games. Fewer than 8 earlier games is not fitted. No match winner and no posted line were used.',
    },
    titles: [{
      title: 'CS2',
      source: 'BO3.gg',
      matches: [{
        id: 'm1',
        start_time: new Date(now.getTime() + 3_600_000).toISOString(),
        teams: ['GamerLegion', 'BIG'],
        competition: 'Stake Ranked Episode 6',
        players: [{
          name: 'volt',
          team: 'GamerLegion',
          props: [
            { stat: 'kills', mean: 18.2 },
            { stat: 'deaths', mean: null },
          ],
        }],
      }],
    }],
  });
}

test('the sport switch keeps the NBA slate and parks the other two', async () => {
  const timer = globalThis.setInterval;
  const boots: string[] = [];
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
  async function boot(seed: string | null, feeds = true) {
    const dir = mkdtempSync(join(tmpdir(), 'sim-sport-'));
    boots.push(dir);
    const { window, document } = parseHTML(readFileSync('index.html', 'utf8'));
    const globals = globalThis as unknown as Record<string, unknown>;
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Element', 'Event']) {
      globals[key] = (window as unknown as Record<string, unknown>)[key];
    }
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
    window.scrollTo = () => {};
    globals.CSS = { escape: (value: string) => value };
    const session = new Map<string, string>();
    if (seed) session.set('simulator.sport', seed);
    const localKeys: string[] = [];
    globals.sessionStorage = {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => {
        session.set(key, value);
      },
    };
    globals.localStorage = {
      getItem: () => null,
      setItem: (key: string) => {
        localKeys.push(key);
      },
    };
    const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
    const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
    const now = new Date();
    card.generated_at = now.toISOString();
    slate.generated_at = card.generated_at;
    const chicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    card.date = chicago;
    slate.date = chicago;
    slate.games.forEach((game) => {
      game.date = chicago;
      game.status_state = 'pre';
      game.completed = false;
      game.start_time = new Date(now.getTime() + 3600000).toISOString();
    });
    delete card.model_hash;
    const fetched: string[] = [];
    globals.fetch = async (url: string) => {
      fetched.push(String(url));
      const ok = url.endsWith('/slate.json') || url.endsWith('/rate-card.json') || (feeds && (url.endsWith('/nfl.json') || url.endsWith('/esports.json')));
      const body = url.endsWith('/slate.json')
        ? JSON.stringify(slate)
        : url.endsWith('/rate-card.json')
          ? JSON.stringify(card)
          : url.endsWith('/nfl.json')
            ? nflFile(now)
            : url.endsWith('/esports.json')
              ? esportsFile(now)
              : '';
      return new Response(body, { status: ok ? 200 : 404 });
    };
    globals.setInterval = () => 0;
    await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', outfile: join(dir, 'app.mjs'), loader: { '.css': 'empty' }, logLevel: 'silent' });
    await import(pathToFileURL(join(dir, 'app.mjs')).href);
    await flush();
    return { document, window, session, localKeys, fetched };
  }
  const key = (document: ReturnType<typeof parseHTML>['document'], window: ReturnType<typeof parseHTML>['window'], selector: string, name: string) => {
    const target = document.querySelector(selector);
    assert.ok(target, selector);
    const event = new window.Event('keydown', { bubbles: true });
    Object.assign(event, { key: name });
    target.dispatchEvent(event);
  };
  const checked = (document: ReturnType<typeof parseHTML>['document']) =>
    document.querySelector('[data-sport][aria-checked="true"]')?.getAttribute('data-sport') ?? '';
  const tab = (document: ReturnType<typeof parseHTML>['document'], sport: string) =>
    document.querySelector(`[data-sport="${sport}"]`)?.getAttribute('tabindex');
  try {
    const page = await boot(null);
    const { document } = page;
    const group = document.querySelector('.sport-switch');
    assert.equal(group?.getAttribute('role'), 'radiogroup');
    assert.equal(group?.getAttribute('aria-label'), 'Sport');
    assert.match(document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '', /NBA simulator/);
    const buttons = [...document.querySelectorAll('[data-sport]')];
    assert.deepEqual(buttons.map((button) => button.getAttribute('data-sport')), ['nba', 'nfl', 'esports']);
    assert.deepEqual(buttons.map((button) => button.getAttribute('aria-label')), ['NBA', 'NFL', 'Esports']);
    for (const button of buttons) {
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(button.getAttribute('role'), 'radio');
      const svg = button.querySelector('svg');
      assert.ok(svg);
      assert.equal(svg.getAttribute('viewBox'), '0 0 32 32');
      assert.equal(svg.getAttribute('fill'), 'none');
      assert.equal(svg.getAttribute('stroke'), 'currentColor');
      assert.equal(svg.getAttribute('stroke-width'), '2');
      assert.equal(svg.getAttribute('aria-hidden'), 'true');
      assert.equal(button.querySelector('img'), null);
    }
    assert.equal(group?.querySelector('img'), null);
    assert.equal(/https?:/i.test(group?.innerHTML ?? ''), false);
    assert.ok(document.querySelector('button[data-event]'));
    assert.equal(checked(document), 'nba');
    assert.equal(tab(document, 'nba'), '0');
    assert.equal(tab(document, 'nfl'), '-1');
    assert.equal(tab(document, 'esports'), '-1');
    key(document, page.window, '[data-desk-tab="projections"]', 'ArrowRight');
    assert.equal(checked(document), 'nba');
    assert.ok(document.querySelector('button[data-event]'));

    document.querySelector<HTMLButtonElement>('[data-sport="nfl"]')?.click();
    await flush();
    assert.match(document.querySelector('#slate')?.textContent ?? '', /Indianapolis Colts/);
    assert.match(document.querySelector('#slate')?.textContent ?? '', /Houston Texans/);
    assert.match(document.querySelector('#slate')?.textContent ?? '', /Projection is not fitted\./);
    assert.equal(/not live yet/i.test(document.querySelector('#slate')?.textContent ?? ''), false);
    assert.equal(document.querySelector('.brand .sub')?.textContent, 'Today and yesterday, Chicago time');
    assert.equal(document.querySelector('button[data-event]'), null);
    assert.ok(document.querySelector('.game-card'));
    assert.equal(document.querySelector('.projection-board, [data-model-sides], .lean-row'), null);
    assert.equal(/lean|spread|moneyline|odds/i.test(document.querySelector('#slate')?.textContent ?? ''), false);
    assert.equal(document.querySelector('#projections')?.textContent, '');
    assert.equal(document.querySelector('[data-region="projections"]')?.hasAttribute('hidden'), true);
    assert.equal(document.querySelector('.desk-tabs')?.hasAttribute('hidden'), true);
    assert.equal(document.querySelector('[data-fresh]')?.hasAttribute('hidden'), true);
    assert.match(document.querySelector('.foot')?.textContent ?? '', /No line or price is shown/);
    assert.equal(document.querySelector('#desk')?.getAttribute('data-mode'), 'sport');
    assert.equal(page.session.get('simulator.sport'), 'nfl');
    assert.equal(page.localKeys.includes('simulator.sport'), false);
    assert.equal(checked(document), 'nfl');
    assert.equal(tab(document, 'nfl'), '0');

    key(document, page.window, '[data-sport="nfl"]', 'ArrowRight');
    await flush();
    assert.equal(checked(document), 'esports');
    assert.equal(tab(document, 'esports'), '0');
    assert.equal(tab(document, 'nfl'), '-1');
    assert.equal(tab(document, 'nba'), '-1');
    assert.match(document.querySelector('#slate')?.textContent ?? '', /GamerLegion/);
    assert.match(document.querySelector('#slate')?.textContent ?? '', /volt/);
    assert.match(document.querySelector('#slate')?.textContent ?? '', /18\.2/);
    assert.match(document.querySelector('#slate')?.textContent ?? '', /not fitted/);
    assert.equal(/55\.0%|tier-1|Not calibrated/.test(document.querySelector('#slate')?.textContent ?? ''), false);
    assert.equal(/not live yet/i.test(document.querySelector('#slate')?.textContent ?? ''), false);
    assert.equal(document.querySelector('button[data-event]'), null);
    assert.equal(document.querySelector('[data-desk-tab="projections"]')?.closest('.desk-tabs')?.hasAttribute('hidden'), true);
    key(document, page.window, '[data-sport="esports"]', 'ArrowLeft');
    await flush();
    assert.equal(checked(document), 'nfl');
    assert.equal(tab(document, 'nfl'), '0');
    assert.equal(tab(document, 'esports'), '-1');
    key(document, page.window, '[data-sport="nfl"]', 'Home');
    await flush();
    assert.equal(checked(document), 'nba');
    assert.equal(tab(document, 'nba'), '0');
    assert.equal(tab(document, 'nfl'), '-1');
    assert.equal(tab(document, 'esports'), '-1');
    key(document, page.window, '[data-sport="nba"]', 'End');
    await flush();
    assert.equal(checked(document), 'esports');
    assert.equal(tab(document, 'esports'), '0');
    assert.equal(tab(document, 'nba'), '-1');
    assert.equal(document.querySelector('button[data-event]'), null);

    document.querySelector<HTMLButtonElement>('[data-sport="nba"]')?.click();
    await flush();
    assert.ok(document.querySelector('button[data-event]'));
    assert.equal(document.querySelector('.brand .sub')?.textContent, 'Today and yesterday, Chicago time');
    assert.match(document.querySelector('.foot')?.textContent ?? '', /10,000/);
    assert.equal(document.querySelector('.desk-tabs')?.hasAttribute('hidden'), false);
    assert.equal(document.querySelector('[data-fresh]')?.hasAttribute('hidden'), false);
    assert.equal(checked(document), 'nba');
    assert.equal(page.localKeys.includes('simulator.sport'), false);

    const parked = await boot('esports', false);
    assert.match(parked.document.querySelector('#slate')?.textContent ?? '', /Esports slate could not be loaded/);
    assert.equal(/not live yet/i.test(parked.document.querySelector('#slate')?.textContent ?? ''), false);
    assert.equal(parked.document.querySelector('button[data-event]'), null);
    assert.equal(parked.document.querySelector('[data-sport="esports"]')?.getAttribute('aria-checked'), 'true');
    assert.equal(parked.document.querySelector('.desk-tabs')?.hasAttribute('hidden'), true);
    assert.equal(parked.document.querySelector('[data-fresh]')?.hasAttribute('hidden'), true);
    assert.equal(parked.session.get('simulator.sport'), 'esports');
    assert.ok(parked.fetched.some((url) => url.endsWith('/slate.json')));
    assert.ok(parked.fetched.some((url) => url.endsWith('/rate-card.json')));
    assert.ok(parked.fetched.some((url) => url.endsWith('/esports.json')));
    for (const url of parked.fetched) {
      assert.ok(KNOWN_DATA.some((name) => url.endsWith(name)), url);
    }
    parked.document.querySelector<HTMLButtonElement>('[data-sport="nba"]')?.click();
    await flush();
    assert.ok(parked.document.querySelector('button[data-event]'));
    assert.match(parked.document.querySelector('.foot')?.textContent ?? '', /10,000/);
  } finally {
    globalThis.setInterval = timer;
    for (const dir of boots) rmSync(dir, { recursive: true, force: true });
  }
});
