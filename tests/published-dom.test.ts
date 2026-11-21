import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';
import { publishedIndex, summarizeSimulation } from '../src/published-sim.ts';
import { fnv1a } from '../src/rng.ts';
import { ITERATIONS, simulate } from '../src/simulate.ts';
import type { RateCard, Slate } from '../src/types.ts';

test('a game published with the card opens with no worker and no wait, in the board, the form and every stat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-published-dom-'));
  const { window, document } = parseHTML(readFileSync('index.html', 'utf8'));
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLImageElement', 'HTMLDetailsElement', 'Element', 'Event']) {
    globals[key] = (window as unknown as Record<string, unknown>)[key];
  }
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
  window.scrollTo = () => {};
  const loc = { hash: '#projections' };
  Object.defineProperty(window, 'location', { configurable: true, value: loc });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: loc });
  globals.CSS = { escape: (x: string) => x };
  const store = new Map<string, string>();
  globals.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const timer = globalThis.setInterval;
  globals.setInterval = () => 0;

  const card = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/rate-card.json', 'utf8')) as RateCard;
  const slate = JSON.parse(readFileSync('tests/fixtures/generation-2026-11-02/slate.json', 'utf8')) as Slate;
  const now = new Date();
  card.generated_at = now.toISOString();
  slate.generated_at = card.generated_at;
  const chicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  card.date = chicago;
  slate.date = chicago;
  slate.games.forEach((g) => {
    g.date = chicago;
    g.status_state = 'pre';
    g.completed = false;
    g.start_time = new Date(now.getTime() + 3600000).toISOString();
  });
  delete card.model_hash;

  const game = card.games[0];
  const seed = fnv1a(`${game.event_id}:${card.generated_at}`);
  const meta = { generated_at: card.generated_at, input_hash: card.input_hash ?? null, model_hash: null };
  const published = JSON.stringify(summarizeSimulation(simulate(game, seed, ITERATIONS), { event_id: game.event_id, ...meta, seed }));
  const index = JSON.stringify(publishedIndex({ ...meta, iterations: ITERATIONS }, [game.event_id]));
  const requested: string[] = [];
  globals.fetch = async (url: string) => {
    requested.push(url);
    const body = url.endsWith('/slate.json')
      ? JSON.stringify(slate)
      : url.endsWith('/rate-card.json')
        ? JSON.stringify(card)
        : url.endsWith('/sims/index.json')
          ? index
          : url.endsWith(`/sims/${game.event_id}.json`)
            ? published
            : '';
    return new Response(body, { status: body ? 200 : 404 });
  };
  // Games that were not published are still drawn by a worker. This one never answers, so only what it was asked is seen.
  const asked: string[] = [];
  class SilentWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage(message: { game: { event_id: string } }) {
      asked.push(message.game.event_id);
    }
    terminate() {}
  }
  globals.Worker = SilentWorker;

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'esm', outfile: join(dir, 'app.mjs'), loader: { '.css': 'empty' }, logLevel: 'silent' });
    await import(pathToFileURL(join(dir, 'app.mjs')).href);
    await wait(80);
    assert.equal(document.querySelector('#desk')?.getAttribute('data-mode'), 'projections');
    assert.ok(requested.some((url) => url.endsWith('/sims/index.json')), 'the page asks which games were published');

    // Opening the game shows its board from the published counts, with nothing to wait for.
    document.querySelector<HTMLButtonElement>(`button[data-projection-game="${game.event_id}"]`)?.click();
    await wait(80);
    assert.ok(requested.some((url) => url.endsWith(`/sims/${game.event_id}.json`)));
    assert.equal(asked.includes(game.event_id), false, 'no worker was asked to draw the published game');
    assert.equal(document.querySelector('.sim-screen'), null);
    assert.equal(document.querySelector('.projection-drawing'), null);
    assert.ok(document.querySelector(`button[data-projection-game="${game.event_id}"] .ready-dot`), 'the game is marked ready');
    const projections = [...document.querySelectorAll('[data-projection-board] .pick-proj .pick-value')].map((cell) => cell.textContent ?? '');
    assert.ok(projections.some((text) => /^\d+\.\d$/.test(text)), `projections rendered: ${projections.slice(0, 4).join(', ')}`);

    // A player opens with his own line and chances, and every stat answers, combined ones and milestones included.
    const player = document.querySelector<HTMLButtonElement>('[data-projection-board] button[data-projection-player]');
    assert.ok(player);
    player.click();
    await wait(40);
    assert.equal(asked.includes(game.event_id), false);
    assert.ok(document.querySelector('.who-name'));
    assert.match(document.querySelector('[data-model-chances]')?.textContent ?? '', /Over\s*\d/);
    for (const market of ['pra', 'ra', 'reb', 'tpm', 'dd']) {
      document.querySelector<HTMLButtonElement>(`[data-projection-market="${market}"]`)?.click();
      assert.match(document.querySelector('[data-model-chances]')?.textContent ?? '', /Over\s*(\d|—)/, market);
    }
    assert.equal(asked.includes(game.event_id), false);

    // Ruling a player out changes the game, so that one is drawn here.
    const mate = game.players.find((p) => p.minutes_weight === 1 && !p.replacement_level && p.team_id === game.home_team_id)!;
    document.querySelector<HTMLButtonElement>('#projections button[data-lineup]')?.click();
    const out = document.querySelector<HTMLInputElement>(`input[data-lineup-choice="${mate.athlete_id}"][value="out"]`);
    assert.ok(out);
    out.checked = true;
    out.dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-back]')?.click();
    document.querySelector<HTMLButtonElement>('[data-projection-rerun]')?.click();
    await wait(40);
    assert.equal(asked.includes(game.event_id), true, 'a called game is drawn by a worker');
  } finally {
    delete (globalThis as Record<string, unknown>).location;
    globals.setInterval = timer;
    rmSync(dir, { recursive: true, force: true });
  }
});
