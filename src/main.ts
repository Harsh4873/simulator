import './styles.css';
import { DEFAULT_SIDE_SORTS, isColumnKey, nextBoxSort, renderBoxScore, renderPlayerPanel, type SideSorts } from './boxscore.ts';
import { nextPanelAthlete, probabilityColorsOn, themeFromStorage } from './display.ts';
import { fnv1a } from './rng.ts';
import { renderSlate } from './slate.ts';
import { ITERATIONS, simulate, type Simulation } from './simulate.ts';
import type { RateCard, RateGame, Slate, SlateGame } from './types.ts';

const DATA_BASE = '/simulator/data/';
const COLOR_KEY = 'simulator.probability-colors';
const THEME_KEY = 'simulator.theme';

const desk = document.querySelector<HTMLElement>('#desk');
const slateRoot = document.querySelector<HTMLElement>('#slate');
const boxRoot = document.querySelector<HTMLElement>('#boxscore');
const stageFrame = document.querySelector<HTMLElement>('[data-region="stage"]');
const playerFrame = document.querySelector<HTMLElement>('[data-region="player"]');
const panelBody = document.querySelector<HTMLElement>('[data-panel-body]');

let slate: Slate | null = null;
let card: RateCard | null = null;
let bound = false;
let running = false;
let panelAthlete: string | null = null;
let view: { game: SlateGame; rates: RateGame; result: Simulation } | null = null;
let sideSorts: SideSorts = DEFAULT_SIDE_SORTS;

function rateGame(eventId: string): RateGame | null {
  return card?.games.find((game) => game.event_id === eventId) ?? null;
}

function gamesFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-region="games"]');
}

function storedColorsOn(): boolean {
  try {
    return probabilityColorsOn(localStorage.getItem(COLOR_KEY));
  } catch {
    return false;
  }
}

function applyProbabilityColors(): void {
  const on = storedColorsOn();
  if (desk) desk.dataset.colors = on ? 'on' : 'off';
  const box = document.querySelector<HTMLInputElement>('input[data-probability-colors]');
  if (box) box.checked = on;
}

function showSlate(): void {
  if (!slateRoot || !slate || !card) return;
  view = null;
  panelAthlete = null;
  boxRoot?.replaceChildren();
  panelBody?.replaceChildren();
  desk?.classList.remove('panel-open');
  const games = gamesFrame();
  if (games) games.hidden = false;
  if (stageFrame) stageFrame.hidden = true;
  if (playerFrame) playerFrame.hidden = true;
  if (desk) {
    const unbuilt = slate.generated_at === null || slate.games.length === 0;
    desk.dataset.mode = unbuilt ? 'empty' : 'games';
  }
  slateRoot.innerHTML = renderSlate(slate, card, new Date());
}

function paintScore(): void {
  if (!boxRoot || !view) return;
  const scrollY = window.scrollY;
  boxRoot.innerHTML = renderBoxScore(view.game, view.rates, view.result, new Date(), sideSorts);
  applyProbabilityColors();
  window.scrollTo(0, scrollY);
}

function showScore(): void {
  const games = gamesFrame();
  if (games) games.hidden = true;
  if (stageFrame) stageFrame.hidden = false;
  if (playerFrame) playerFrame.hidden = true;
  desk?.classList.remove('panel-open');
  if (desk) desk.dataset.mode = 'score';
}

function syncPanel(): void {
  if (!desk || !panelBody || !view) return;
  if (panelAthlete === null) {
    desk.classList.remove('panel-open');
    if (playerFrame) playerFrame.hidden = true;
    panelBody.replaceChildren();
    return;
  }
  if (playerFrame) playerFrame.hidden = false;
  desk.classList.add('panel-open');
  panelBody.innerHTML = renderPlayerPanel(view.game, view.rates, view.result, panelAthlete);
}

async function onSimulate(button: HTMLButtonElement): Promise<void> {
  const eventId = button.dataset.event;
  if (running || !eventId || !slate || !card || !boxRoot) return;
  const game = slate.games.find((item) => item.event_id === eventId);
  const rates = rateGame(eventId);
  if (!game || !rates) return;
  running = true;
  button.disabled = true;
  button.textContent = 'Simulating…';
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  try {
    const result = simulate(rates, fnv1a(`${eventId}:${card.generated_at ?? ''}`), ITERATIONS);
    view = { game, rates, result };
    panelAthlete = null;
    panelBody?.replaceChildren();
    paintScore();
    showScore();
  } catch {
    button.disabled = false;
    button.textContent = 'Simulate';
  } finally {
    running = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = 'Simulate';
    }
  }
}

function onDeskClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const simulateButton = target.closest('button[data-event]');
  if (simulateButton instanceof HTMLButtonElement) {
    if (simulateButton.disabled) return;
    void onSimulate(simulateButton);
    return;
  }
  if (target.closest('[data-back]')) {
    showSlate();
    return;
  }
  if (target.closest('[data-close]')) {
    panelAthlete = nextPanelAthlete(panelAthlete, null);
    syncPanel();
    return;
  }
  const sortButton = target.closest('button[data-sort]');
  if (sortButton instanceof HTMLButtonElement) {
    const key = sortButton.dataset.sort ?? '';
    const side = sortButton.dataset.side;
    if (!isColumnKey(key) || (side !== 'away' && side !== 'home') || !view) return;
    sideSorts = { ...sideSorts, [side]: nextBoxSort(sideSorts[side], key) };
    paintScore();
    syncPanel();
    return;
  }
  const player = target.closest('button[data-athlete]');
  if (!(player instanceof HTMLButtonElement)) return;
  panelAthlete = nextPanelAthlete(panelAthlete, player.dataset.athlete ?? null);
  syncPanel();
}

function onProbabilityColors(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.matches('[data-probability-colors]')) return;
  const on = target.checked;
  try {
    localStorage.setItem(COLOR_KEY, on ? 'on' : 'off');
  } catch {
    // The desk still follows the checkbox when storage is blocked.
  }
  if (desk) desk.dataset.colors = on ? 'on' : 'off';
}

function onImageError(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) return;
  const frame = target.closest('.logo, .photo');
  if (!(frame instanceof HTMLElement)) return;
  target.hidden = true;
  const mono = frame.querySelector('.mono');
  if (mono instanceof HTMLElement) mono.hidden = false;
  if (!frame.classList.contains('photo')) return;
  const note = frame.parentElement?.querySelector('.photo-note');
  if (note instanceof HTMLElement) note.hidden = false;
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || panelAthlete === null) return;
  panelAthlete = nextPanelAthlete(panelAthlete, null);
  syncPanel();
}

function bind(): void {
  if (bound || !desk) return;
  bound = true;
  desk.addEventListener('click', onDeskClick);
  desk.addEventListener('change', onProbabilityColors);
  desk.addEventListener('error', onImageError, true);
  document.addEventListener('keydown', onKey);
  applyProbabilityColors();
}

async function load(): Promise<void> {
  if (!slateRoot) return;
  try {
    const [slateResponse, cardResponse] = await Promise.all([
      fetch(`${DATA_BASE}slate.json`),
      fetch(`${DATA_BASE}rate-card.json`),
    ]);
    if (!slateResponse.ok || !cardResponse.ok) throw new Error('fetch failed');
    slate = (await slateResponse.json()) as Slate;
    card = (await cardResponse.json()) as RateCard;
    bind();
    showSlate();
  } catch {
    slateRoot.innerHTML = '<p class="state">Slate could not be loaded.</p>';
    if (desk) desk.dataset.mode = 'error';
  }
}

function storedTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;
  const light = theme === 'light';
  button.textContent = light ? 'Light' : 'Dark';
  button.setAttribute('aria-pressed', light ? 'true' : 'false');
}

function bindTheme(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // The header still follows the click when storage is blocked.
    }
    applyTheme(next);
  });
}

applyTheme(themeFromStorage(storedTheme(), window.matchMedia('(prefers-color-scheme: light)').matches));
bindTheme();
void load();
