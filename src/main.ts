import './styles.css';
import {lineProbability} from './distributions.ts';
import {loadGeneration} from './load-generation.ts';
import type {RefreshHealth} from './generation.ts';
import { freshnessIssue } from './validate-card.ts';
import {
  DEFAULT_SIDE_SORTS,
  isColumnKey,
  nextBoxSort,
  DEFAULT_PROP_FORM,
  renderBoxScore,
  renderPlayerPanel,
  renderPropResults,
  type PanelTab,
  type PropFormState,
  type SideSorts,
} from './boxscore.ts';
import { nextPanelAthlete, themeFromStorage } from './display.ts';
import { renderLineupEditor } from './lineup-editor.ts';
import { applyLineupOverrides, cleanOverrides, isLineupChoice, LINEUP_STORAGE_KEY, overridesKey, readStoredLineups, summarizeOverrides, type LineupOverrides } from './lineup-overrides.ts';
import { healthyCheck } from './generation.ts';
import { fnv1a } from './rng.ts';
import {
  defaultMarketLine,
  gameLogRowsHtml,
  historyChartBlockHtml,
  historySummaryHtml,
  historyWindowsHtml,
  isDefenseSlot,
  isHistorySplit,
  isPropMarket,
  l10HistoricalValues,
  modelChanceHtml,
  playedValues,
  projectionBoardHtml,
  projectionChartHtml,
  renderProjections,
  searchHitsHtml,
  viewerLine,
  type HistorySplit,
  type ProjectionView,
  type SupportMode,
} from './projections.ts';
import { unpackPlayerGames, type DefenseSlot } from './projection-context.ts';
import { escapeHtml, renderSlate } from './slate.ts';
import { ITERATIONS, type Simulation } from './simulate.ts';
import type { RateCard, RateGame, Slate, SlateGame } from './types.ts';

const DATA_BASE = '/simulator/data/';
const THEME_KEY = 'simulator.theme';

const desk = document.querySelector<HTMLElement>('#desk');
const slateRoot = document.querySelector<HTMLElement>('#slate');
const boxRoot = document.querySelector<HTMLElement>('#boxscore');
const stageFrame = document.querySelector<HTMLElement>('[data-region="stage"]');
const playerFrame = document.querySelector<HTMLElement>('[data-region="player"]');
const panelBody = document.querySelector<HTMLElement>('[data-panel-body]');
const projectionsRoot = document.querySelector<HTMLElement>('#projections');
const projectionsFrame = document.querySelector<HTMLElement>('[data-region="projections"]');

let slate: Slate | null = null;
let card: RateCard | null = null;
let health:RefreshHealth|null=null;
let bound = false;
let running = false;
let activeWorker: Worker | null = null;
let cancelRun: (()=>void) | null = null;
const simulationCache = new Map<string, Simulation>();
let panelAthlete: string | null = null;
let view: { game: SlateGame; rates: RateGame; result: Simulation } | null = null;
let sideSorts: SideSorts = DEFAULT_SIDE_SORTS;
let panelTab: PanelTab = 'forecast';
let propForm: PropFormState = { ...DEFAULT_PROP_FORM };
let lineupEdits: Record<string, LineupOverrides> = {};
let lineupEvent: string | null = null;
let lineupOrigin: 'slate' | 'projections' = 'slate';
let projectionQuery = '';
let projectionEvent: string | null = null;
let projectionAthlete: string | null = null;
let projectionHistorySplit: HistorySplit = 'all';
let projectionSelectedBar: number | null = null;
let projectionSupportMode: SupportMode = 'avg';
let projectionTeammate: string | null = null;
let projectionDefenseSlot: DefenseSlot | null = null;
let projectionAutoLine = false;
/** Set only while this game's worker is drawing. A cache hit never sets it. */
let drawingEvent: string | null = null;

function storedLineups(): string | null {
  try {
    return localStorage.getItem(LINEUP_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveLineups(): void {
  try {
    localStorage.setItem(LINEUP_STORAGE_KEY, JSON.stringify(lineupEdits));
  } catch {
    // Calls still apply for this visit when storage is blocked.
  }
}

function editsFor(eventId: string): LineupOverrides {
  const base = rateGame(eventId);
  return base ? cleanOverrides(base, lineupEdits[eventId]) : {};
}

function setEdits(eventId: string, overrides: LineupOverrides): void {
  if (Object.keys(overrides).length) lineupEdits = { ...lineupEdits, [eventId]: overrides };
  else {
    const { [eventId]: _cleared, ...rest } = lineupEdits;
    lineupEdits = rest;
  }
  saveLineups();
}

function editCounts(): Record<string, number> {
  return Object.fromEntries(Object.keys(lineupEdits).map((id) => [id, Object.keys(editsFor(id)).length]));
}

function relativeAge(iso: string | null | undefined, now: Date): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min ago`;
}

function paintFreshness(): void {
  const pill = document.querySelector<HTMLElement>('[data-fresh]');
  if (!pill || !slate || !card) return;
  const now = new Date();
  const checked = healthyCheck(health, card, now.getTime()) ?? card.generated_at;
  const age = relativeAge(checked, now);
  if (!age) {
    pill.hidden = true;
    return;
  }
  const stale = freshnessIssue(slate, card, now, health) !== null;
  pill.hidden = false;
  pill.dataset.state = stale ? 'stale' : 'fresh';
  pill.textContent = stale ? `Data stale · checked ${age}` : `Data checked ${age}`;
}

function rateGame(eventId: string): RateGame | null {
  return card?.games.find((game) => game.event_id === eventId) ?? null;
}

function gamesFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-region="games"]');
}

function simulationKey(eventId: string, overrides: LineupOverrides): string {
  return `${eventId}:${card?.input_hash ?? card?.generated_at}:${card?.model_hash ?? card?.model_version ?? 'legacy'}:${overridesKey(overrides)}`;
}

function cachedSimulation(eventId: string): Simulation | null {
  if (!card) return null;
  return simulationCache.get(simulationKey(eventId, editsFor(eventId))) ?? null;
}

function unmountProjections(): void {
  if (projectionsFrame) projectionsFrame.hidden = true;
  projectionsRoot?.replaceChildren();
}

function unmountSheet(): void {
  panelAthlete = null;
  panelBody?.replaceChildren();
  desk?.classList.remove('panel-open');
  if (playerFrame) playerFrame.hidden = true;
}

function markDeskTabs(): void {
  const projections = desk?.dataset.mode === 'projections';
  document.querySelectorAll<HTMLButtonElement>('[data-desk-tab]').forEach((button) => {
    const on = (button.dataset.deskTab === 'projections') === projections;
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function projectionView(): ProjectionView | null {
  if (!slate || !card) return null;
  const form = propForm.market === 'dd' || propForm.market === 'td' ? { ...propForm, line: '0.5' } : propForm;
  return {
    slate,
    card,
    now: new Date(),
    query: projectionQuery,
    eventId: projectionEvent,
    athleteId: projectionAthlete,
    form,
    simulation: projectionEvent ? cachedSimulation(projectionEvent) : null,
    drawing: projectionEvent !== null && drawingEvent === projectionEvent && !cachedSimulation(projectionEvent),
    overrides: projectionEvent ? editsFor(projectionEvent) : {},
    historySplit: projectionHistorySplit,
    selectedGameIndex: projectionSelectedBar,
    supportMode: projectionSupportMode,
    selectedTeammateId: projectionTeammate,
    defenseSlot: projectionDefenseSlot,
  };
}

function lockMilestoneLine(): void {
  if (propForm.market !== 'dd' && propForm.market !== 'td') return;
  propForm = { ...propForm, line: '0.5' };
  const line = projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-line]');
  if (line) {
    line.value = '0.5';
    line.readOnly = true;
  }
}

function projectionCaret(): { selector: string; start: number | null; end: number | null } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !projectionsRoot?.contains(active)) return null;
  const selector = active.matches('[data-prop-line]')
    ? '[data-prop-line]'
    : active.matches('[data-prop-odds]')
      ? '[data-prop-odds]'
      : active.matches('[data-prop-opposite]')
        ? '[data-prop-opposite]'
        : null;
  if (!selector) return null;
  return { selector, start: active.selectionStart, end: active.selectionEnd };
}

function restoreProjectionCaret(caret: { selector: string; start: number | null; end: number | null } | null): void {
  if (!caret || !projectionsRoot) return;
  const input = projectionsRoot.querySelector<HTMLInputElement>(caret.selector);
  if (!input) return;
  input.focus();
  const start = caret.start ?? input.value.length;
  const end = caret.end ?? start;
  try {
    input.setSelectionRange(start, end);
  } catch {
    // Some input modes reject a selection range. Focus still lands in the field.
  }
}

function paintProjection(): void {
  const viewModel = projectionView();
  if (!projectionsRoot || !viewModel) return;
  const caret = projectionCaret();
  projectionsRoot.innerHTML = renderProjections(viewModel);
  lockMilestoneLine();
  restoreProjectionCaret(caret);
}

function paintProjectionFigures(): void {
  if (!projectionsRoot || !slate || !card || !projectionEvent) return;
  const rate = rateGame(projectionEvent);
  const game = slate.games.find((item) => item.event_id === projectionEvent) ?? null;
  const simulation = cachedSimulation(projectionEvent);
  const sample = projectionAthlete ? simulation?.playerDraws.get(projectionAthlete) ?? null : null;
  const form = propForm.market === 'dd' || propForm.market === 'td' ? { ...propForm, line: '0.5' } : propForm;
  const chances = projectionsRoot.querySelector<HTMLElement>('[data-model-chances]');
  if (chances) chances.innerHTML = modelChanceHtml(sample, form.market, form.line);
  const chart = projectionsRoot.querySelector<HTMLElement>('[data-projection-chart]');
  if (chart) chart.innerHTML = projectionChartHtml(sample, form.market, form.line);
  const board = projectionsRoot.querySelector<HTMLElement>('[data-projection-board]');
  if (board && rate) board.innerHTML = projectionBoardHtml(rate, simulation, form, projectionEvent, projectionAthlete, card.projection_context);
  const player = projectionAthlete ? rate?.players.find((item) => item.athlete_id === projectionAthlete) ?? null : null;
  const results = projectionsRoot.querySelector<HTMLElement>('[data-prop-results]');
  if (results && simulation && projectionAthlete) {
    const open = results.querySelector('details.prop-advanced');
    const keepOpen = open instanceof HTMLDetailsElement && open.open;
    results.innerHTML = renderPropResults(simulation, projectionAthlete, form, player);
    const details = results.querySelector('details.prop-advanced');
    if (keepOpen && details instanceof HTMLDetailsElement) details.open = true;
  }
  const context = card.projection_context;
  if (context && player && game) {
    const allRows = unpackPlayerGames(context.players[player.athlete_id]?.games);
    const filtered =
      projectionHistorySplit === 'home'
        ? allRows.filter((r) => r.home)
        : projectionHistorySplit === 'away'
          ? allRows.filter((r) => !r.home)
          : allRows;
    const teamSide = player.team_id === game.away.team_id ? game.away : game.home;
    const oppSide = player.team_id === game.away.team_id ? game.home : game.away;
    const teamAbbr = teamSide.abbreviation.trim() || teamSide.name.trim() || 'Team';
    const summaryEl = projectionsRoot.querySelector<HTMLElement>('[data-history-summary]');
    if (summaryEl) summaryEl.innerHTML = historySummaryHtml(filtered, allRows, form, context.active_season);
    const histChartEl = projectionsRoot.querySelector<HTMLElement>('[data-history-chart]');
    if (histChartEl) histChartEl.innerHTML = historyChartBlockHtml(filtered, form, projectionSelectedBar, teamAbbr, slate, context);
    const windowsEl = projectionsRoot.querySelector<HTMLElement>('[data-history-windows]');
    if (windowsEl) windowsEl.innerHTML = historyWindowsHtml(filtered, form, context.active_season, oppSide.team_id);
    const logBody = projectionsRoot.querySelector<HTMLElement>('[data-gamelog-body]');
    if (logBody) logBody.innerHTML = gameLogRowsHtml(filtered, form, slate, context);
  }
}

function showProjections(): void {
  if (!slate || !card || !desk || !projectionsRoot) return;
  const entering = desk.dataset.mode !== 'projections';
  if (entering) {
    cancelRun?.();
    drawingEvent = null;
  }
  unmountSheet();
  const games = gamesFrame();
  if (games) games.hidden = true;
  if (stageFrame) stageFrame.hidden = true;
  if (entering) {
    lineupEvent = null;
    boxRoot?.replaceChildren();
  }
  if (projectionsFrame) projectionsFrame.hidden = false;
  desk.dataset.mode = 'projections';
  paintProjection();
  markDeskTabs();
}

function showSlate(): void {
  if (!slateRoot || !slate || !card) return;
  cancelRun?.();
  drawingEvent = null;
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
  lineupEvent = null;
  unmountProjections();
  try {
    if (location.hash === '#projections') location.hash = '';
  } catch {
    // Hosts without a location object keep the surface change.
  }
  slateRoot.innerHTML = renderSlate(slate, card, new Date(), health, editCounts());
  paintFreshness();
  markDeskTabs();
}

function paintScore(): void {
  if (!boxRoot || !view) return;
  const scrollY = window.scrollY;
  const base = rateGame(view.game.event_id);
  const note = base ? summarizeOverrides(base, editsFor(view.game.event_id)) : undefined;
  boxRoot.innerHTML = renderBoxScore(view.game, view.rates, view.result, new Date(), sideSorts, note);
  window.scrollTo(0, scrollY);
}

function showScore(): void {
  const games = gamesFrame();
  if (games) games.hidden = true;
  if (stageFrame) stageFrame.hidden = false;
  if (playerFrame) playerFrame.hidden = true;
  desk?.classList.remove('panel-open');
  unmountProjections();
  if (desk) desk.dataset.mode = 'score';
  markDeskTabs();
}

function syncPanel(): void {
  if (desk?.dataset.mode === 'projections') return;
  if (!desk || !panelBody || !view) return;
  if (panelAthlete === null) {
    desk.classList.remove('panel-open');
    if (playerFrame) playerFrame.hidden = true;
    panelBody.replaceChildren();
    return;
  }
  if (playerFrame) playerFrame.hidden = false;
  desk.classList.add('panel-open');
  panelBody.innerHTML = renderPlayerPanel(
    view.game,
    view.rates,
    view.result,
    panelAthlete,
    panelTab,
    propForm,
  );
}

const CLOCK_RADIUS = 64;
const CLOCK_ARC = 2 * Math.PI * CLOCK_RADIUS;

function clockTicks(): string {
  return Array.from({ length: 12 }, (_, index) => {
    const major = index % 3 === 0;
    const angle = (index / 12) * Math.PI * 2 - Math.PI / 2;
    const inner = major ? 74 : 82;
    const outer = 92;
    const point = (radius: number) => `${(100 + Math.cos(angle) * radius).toFixed(2)},${(100 + Math.sin(angle) * radius).toFixed(2)}`;
    const [x1, y1] = point(inner).split(',');
    const [x2, y2] = point(outer).split(',');
    return `<line class="${major ? 'major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
  }).join('');
}

function paintSimClock(screen: HTMLElement, progress: number): void {
  const clamped = Math.min(1, Math.max(0, progress));
  const arc = screen.querySelector<SVGCircleElement>('.sim-arc');
  if (arc) {
    arc.style.strokeDasharray = String(CLOCK_ARC);
    arc.style.strokeDashoffset = String(CLOCK_ARC * (1 - clamped));
    arc.style.opacity = clamped <= 0 ? '0' : '1';
  }
  const hand = screen.querySelector<SVGGElement>('.sim-hand');
  if (hand) hand.setAttribute('transform', `rotate(${(clamped * 360).toFixed(2)} 100 100)`);
  screen.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
}

function openSimClock(game: SlateGame): HTMLElement {
  const away = game.away.abbreviation.trim() || game.away.name.trim();
  const home = game.home.abbreviation.trim() || game.home.name.trim();
  const screen = document.createElement('div');
  screen.className = 'sim-screen';
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-modal', 'true');
  screen.setAttribute('aria-labelledby', 'sim-clock-title');
  screen.innerHTML = `<div class="sim-clock" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${escapeHtml(`Simulating ${away} at ${home}`)}"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="sim-face" cx="100" cy="100" r="96"></circle><g class="sim-ticks">${clockTicks()}</g><circle class="sim-track" cx="100" cy="100" r="${CLOCK_RADIUS}"></circle><circle class="sim-arc" cx="100" cy="100" r="${CLOCK_RADIUS}" transform="rotate(-90 100 100)"></circle><g class="sim-hand" transform="rotate(0 100 100)"><line class="sim-hand-tail" x1="100" y1="100" x2="100" y2="118"></line><line class="sim-hand-arm" x1="100" y1="100" x2="100" y2="40"></line><circle class="sim-hub" cx="100" cy="100" r="5"></circle></g></svg></div><p id="sim-clock-title" class="sim-clock-title">${escapeHtml(away)} <span class="at">@</span> ${escapeHtml(home)}</p><p class="sim-clock-note">Simulating</p><button type="button" class="ghost" data-cancel>Cancel</button>`;
  screen.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-cancel]')) cancelRun?.();
  });
  document.body.append(screen);
  document.body.classList.add('sim-open');
  paintSimClock(screen, 0);
  screen.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
  return screen;
}

function closeSimClock(screen: HTMLElement | null): void {
  screen?.remove();
  if (!document.querySelector('.sim-screen')) document.body.classList.remove('sim-open');
}

function drawSimulation(rates: RateGame, eventId: string, screen: HTMLElement | null): Promise<Simulation> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const worker = new Worker(new URL('./simulation-worker.ts', import.meta.url), { type: 'module' });
      activeWorker = worker;
      const finish = () => {
        worker.terminate();
        activeWorker = null;
        cancelRun = null;
      };
      cancelRun = () => {
        finish();
        reject(new Error('Simulation cancelled'));
      };
      worker.onmessage = (event: MessageEvent<{ result?: Simulation; error?: string; progress?: number }>) => {
        if (event.data.progress !== undefined) {
          if (screen) paintSimClock(screen, event.data.progress);
          return;
        }
        finish();
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error ?? 'Simulation failed'));
      };
      worker.onerror = () => {
        finish();
        reject(new Error('Simulation worker failed'));
      };
      worker.postMessage({ game: rates, seed: fnv1a(`${eventId}:${card!.generated_at ?? ''}`), iterations: ITERATIONS });
    }, 0);
  });
}

async function runSimulation(eventId: string): Promise<Simulation | null> {
  if (running || !eventId || !slate || !card) return null;
  if (freshnessIssue(slate, card, new Date(), health)) {
    showSlate();
    return null;
  }
  const game = slate.games.find((item) => item.event_id === eventId);
  const base = rateGame(eventId);
  if (!game || !base) return null;
  const overrides = editsFor(eventId);
  const rates = applyLineupOverrides(base, overrides);
  const key = simulationKey(eventId, overrides);
  const cached = simulationCache.get(key);
  if (cached) {
    if (drawingEvent === eventId) drawingEvent = null;
    simulationCache.set(key, cached);
    if (simulationCache.size > 12) simulationCache.delete(simulationCache.keys().next().value!);
    view = { game, rates, result: cached };
    return cached;
  }
  running = true;
  drawingEvent = eventId;
  desk?.setAttribute('aria-busy', 'true');
  if (desk?.dataset.mode === 'projections') paintProjection();
  const screen = openSimClock(game);
  try {
    const result = await drawSimulation(rates, eventId, screen);
    simulationCache.set(key, result);
    if (simulationCache.size > 12) simulationCache.delete(simulationCache.keys().next().value!);
    view = { game, rates, result };
    return result;
  } finally {
    if (drawingEvent === eventId) drawingEvent = null;
    closeSimClock(screen);
    desk?.setAttribute('aria-busy', 'false');
    running = false;
  }
}

async function onSimulate(button: HTMLButtonElement): Promise<void> {
  const eventId = button.dataset.event;
  if (running || !eventId || !boxRoot) return;
  const label = button.textContent ?? 'Simulate';
  button.disabled = true;
  try {
    const result = await runSimulation(eventId);
    if (!result || !view || !boxRoot) return;
    panelAthlete = null;
    panelBody?.replaceChildren();
    unmountProjections();
    paintScore();
    showScore();
    boxRoot.querySelector<HTMLButtonElement>('[data-back]')?.focus();
  } catch (error) {
    const status = document.createElement('p');
    status.setAttribute('role', 'alert');
    status.textContent = error instanceof Error ? error.message : 'Simulation failed. Retry.';
    button.after(status);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

async function simulateProjection(eventId: string): Promise<void> {
  try {
    const result = await runSimulation(eventId);
    if (drawingEvent === eventId) drawingEvent = null;
    if (desk?.dataset.mode !== 'projections') return;
    if (result && projectionAthlete && (propForm.line.trim() === '' || projectionAutoLine)) {
      const sample = result.playerDraws.get(projectionAthlete) ?? null;
      const auto = defaultMarketLine(propForm.market, sample, card?.projection_context, projectionAthlete);
      if (auto !== null) propForm = { ...propForm, line: String(auto) };
      projectionAutoLine = false;
    }
    paintProjection();
    if (result) return;
  } catch (error) {
    if (drawingEvent === eventId) drawingEvent = null;
    if (desk?.dataset.mode !== 'projections' || !projectionsRoot) return;
    paintProjection();
    const status = document.createElement('p');
    status.setAttribute('role', 'alert');
    status.textContent = error instanceof Error ? error.message : 'Simulation failed. Retry.';
    projectionsRoot.prepend(status);
  }
}

function showLineups(eventId: string, focusSelector?: string): void {
  if (!boxRoot || !slate) return;
  const game = slate.games.find((item) => item.event_id === eventId);
  const base = rateGame(eventId);
  if (!game || !base) return;
  cancelRun?.();
  drawingEvent = null;
  lineupEvent = eventId;
  panelAthlete = null;
  panelBody?.replaceChildren();
  desk?.classList.remove('panel-open');
  boxRoot.innerHTML = renderLineupEditor(game, base, editsFor(eventId));
  const games = gamesFrame();
  if (games) games.hidden = true;
  if (stageFrame) stageFrame.hidden = false;
  if (playerFrame) playerFrame.hidden = true;
  unmountProjections();
  if (desk) desk.dataset.mode = 'lineups';
  markDeskTabs();
  const focus = focusSelector ? boxRoot.querySelector<HTMLElement>(focusSelector) : null;
  (focus ?? boxRoot.querySelector<HTMLElement>('#lineup-title'))?.focus();
}

function onLineupChoice(input: HTMLInputElement): void {
  const eventId = lineupEvent;
  const athlete = input.dataset.lineupChoice;
  if (!eventId || !athlete || !isLineupChoice(input.value)) return;
  const next = { ...editsFor(eventId) };
  if (input.value === 'auto') delete next[athlete];
  else next[athlete] = input.value;
  setEdits(eventId, next);
  showLineups(eventId, `input[data-lineup-choice="${CSS.escape(athlete)}"][value="${input.value}"]`);
}

function onDeskClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if(target.closest('[data-retry]')){void load();return;}
  const lineupButton = target.closest('button[data-lineup]');
  if (lineupButton instanceof HTMLButtonElement) {
    const id = lineupButton.dataset.lineup;
    if (id && !running) {
      lineupOrigin = desk?.dataset.mode === 'projections' ? 'projections' : 'slate';
      showLineups(id);
    }
    return;
  }
  if (target.closest('[data-lineup-reset]') && lineupEvent) {
    setEdits(lineupEvent, {});
    showLineups(lineupEvent, '[data-lineup-run]');
    return;
  }
  if (target.closest('[data-lineup-clear]') && view && !running) {
    const id = view.game.event_id;
    setEdits(id, {});
    const card = slateRoot?.querySelector<HTMLButtonElement>(`button[data-event="${CSS.escape(id)}"]`);
    if (card) void onSimulate(card);
    return;
  }
  if(target.closest('[data-cancel]')){cancelRun?.();return;}
  const projectionMarket = target.closest('button[data-projection-market]');
  if (projectionMarket instanceof HTMLButtonElement && isPropMarket(projectionMarket.dataset.projectionMarket ?? '')) {
    const market = projectionMarket.dataset.projectionMarket as typeof propForm.market;
    const sample = projectionEvent && projectionAthlete ? cachedSimulation(projectionEvent)?.playerDraws.get(projectionAthlete) ?? null : null;
    const auto = defaultMarketLine(market, sample, card?.projection_context, projectionAthlete);
    projectionSelectedBar = null;
    projectionAutoLine = sample === null && auto !== null;
    propForm = { ...propForm, market, line: auto !== null ? String(auto) : market === 'dd' || market === 'td' ? '0.5' : propForm.line };
    paintProjection();
    projectionsRoot?.querySelector<HTMLButtonElement>(`[data-projection-market="${CSS.escape(market)}"]`)?.focus();
    return;
  }
  const l10Btn = target.closest('button[data-line-l10]');
  if (l10Btn instanceof HTMLButtonElement) {
    if (propForm.market === 'dd' || propForm.market === 'td') return;
    const vals = l10HistoricalValues(card?.projection_context, projectionAthlete, propForm.market);
    if (!vals.length) return;
    projectionAutoLine = false;
    propForm = { ...propForm, line: String(viewerLine(propForm.market, vals)) };
    const input = projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-line]');
    if (input) input.value = propForm.line;
    paintProjectionFigures();
    return;
  }
  const historySplitBtn = target.closest('button[data-history-split]');
  if (historySplitBtn instanceof HTMLButtonElement && isHistorySplit(historySplitBtn.dataset.historySplit ?? '')) {
    const nextSplit = historySplitBtn.dataset.historySplit as HistorySplit;
    projectionHistorySplit = nextSplit;
    projectionSelectedBar = null;
    paintProjection();
    projectionsRoot?.querySelector<HTMLButtonElement>(`button[data-history-split="${nextSplit}"]`)?.focus();
    return;
  }
  const historyBar = target.closest('[data-history-bar]');
  if (historyBar instanceof Element) {
    const idx = Number(historyBar.getAttribute('data-history-bar'));
    if (Number.isInteger(idx) && idx >= 0) {
      projectionSelectedBar = idx;
      paintProjectionFigures();
      projectionsRoot?.querySelector<HTMLElement>(`[data-history-bar="${idx}"]`)?.focus();
    }
    return;
  }
  const supportBtn = target.closest('button[data-support-mode]');
  if (supportBtn instanceof HTMLButtonElement) {
    const mode = supportBtn.dataset.supportMode === 'med' ? 'med' : 'avg';
    projectionSupportMode = mode;
    paintProjection();
    projectionsRoot?.querySelector<HTMLButtonElement>(`button[data-support-mode="${mode}"]`)?.focus();
    return;
  }
  const mateBtn = target.closest('button[data-onoff-mate]');
  if (mateBtn instanceof HTMLButtonElement) {
    const mateId = mateBtn.dataset.onoffMate ?? '';
    if (!mateId) return;
    projectionTeammate = mateId;
    paintProjection();
    projectionsRoot?.querySelector<HTMLButtonElement>(`.mate-pill[data-onoff-mate="${CSS.escape(mateId)}"]`)?.focus();
    return;
  }
  const defBtn = target.closest('button[data-defense-slot]');
  if (defBtn instanceof HTMLButtonElement && isDefenseSlot(defBtn.dataset.defenseSlot ?? '')) {
    const slot = defBtn.dataset.defenseSlot as DefenseSlot;
    projectionDefenseSlot = slot;
    paintProjection();
    projectionsRoot?.querySelector<HTMLButtonElement>(`button[data-defense-slot="${slot}"]`)?.focus();
    return;
  }
  const nudge = target.closest('button[data-line-nudge]');
  if (nudge instanceof HTMLButtonElement) {
    if (propForm.market === 'dd' || propForm.market === 'td') return;
    projectionAutoLine = false;
    const delta = Number(nudge.dataset.lineNudge);
    const current = Number(propForm.line);
    const base = propForm.line.trim() === '' || !Number.isFinite(current) ? 0 : current;
    const next = Math.max(0, Math.round((base + delta) * 2) / 2);
    propForm = { ...propForm, line: String(next) };
    const input = projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-line]');
    if (input) input.value = propForm.line;
    paintProjectionFigures();
    return;
  }
  const median = target.closest('[data-line-median]');
  if (median instanceof HTMLButtonElement) {
    const sample = projectionEvent && projectionAthlete ? cachedSimulation(projectionEvent)?.playerDraws.get(projectionAthlete) : null;
    const next = sample ? viewerLine(propForm.market, playedValues(sample, propForm.market)) : propForm.market === 'dd' || propForm.market === 'td' ? 0.5 : null;
    if (next === null) return;
    projectionAutoLine = false;
    propForm = { ...propForm, line: String(next) };
    const input = projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-line]');
    if (input) input.value = propForm.line;
    paintProjectionFigures();
    return;
  }
  const rerunBtn = target.closest('button[data-projection-rerun]');
  if (rerunBtn instanceof HTMLButtonElement) {
    const eventId = rerunBtn.dataset.projectionRerun ?? '';
    if (!eventId || running) return;
    if (cachedSimulation(eventId)) {
      paintProjection();
      return;
    }
    drawingEvent = eventId;
    paintProjection();
    void simulateProjection(eventId);
    return;
  }
  const projectionPlayer = target.closest('button[data-projection-player]');
  if (projectionPlayer instanceof HTMLButtonElement) {
    const eventId = projectionPlayer.dataset.projectionEvent ?? '';
    const athleteId = projectionPlayer.dataset.projectionPlayer ?? '';
    if (!eventId || !athleteId || running) return;
    if (projectionPlayer.closest('[data-projection-hits]')) projectionQuery = '';
    projectionEvent = eventId;
    projectionAthlete = athleteId;
    projectionSelectedBar = null;
    projectionTeammate = null;
    projectionDefenseSlot = null;
    const cached = cachedSimulation(eventId);
    const sample = cached?.playerDraws.get(athleteId) ?? null;
    const auto = defaultMarketLine(propForm.market, sample, card?.projection_context, athleteId);
    projectionAutoLine = sample === null && auto !== null;
    if (auto !== null) propForm = { ...propForm, line: String(auto) };
    else if (propForm.market === 'dd' || propForm.market === 'td') propForm = { ...propForm, line: '0.5' };
    if (cached) {
      if (drawingEvent === eventId) drawingEvent = null;
      paintProjection();
      return;
    }
    drawingEvent = eventId;
    paintProjection();
    void simulateProjection(eventId);
    return;
  }
  const projectionGame = target.closest('button[data-projection-game]');
  if (projectionGame instanceof HTMLButtonElement) {
    const eventId = projectionGame.dataset.projectionGame ?? '';
    if (!eventId || running) return;
    projectionQuery = '';
    projectionEvent = eventId;
    projectionAthlete = null;
    paintProjection();
    return;
  }
  const simulateButton = target.closest('button[data-event]');
  if (simulateButton instanceof HTMLButtonElement) {
    if (simulateButton.disabled) return;
    if (simulateButton.hasAttribute('data-lineup-run') && lineupOrigin === 'projections') {
      const eventId = simulateButton.dataset.event ?? '';
      lineupOrigin = 'slate';
      if (!eventId || running) return;
      projectionEvent = eventId;
      showProjections();
      if (!cachedSimulation(eventId)) {
        drawingEvent = eventId;
        paintProjection();
        void simulateProjection(eventId);
      }
      return;
    }
    void onSimulate(simulateButton);
    return;
  }
  if (target.closest('[data-back]')) {
    if (lineupEvent && lineupOrigin === 'projections') {
      lineupOrigin = 'slate';
      showProjections();
      return;
    }
    const eventId=lineupEvent??view?.game.event_id;
    showSlate();
    if(eventId)slateRoot?.querySelector<HTMLButtonElement>(`[data-event="${CSS.escape(eventId)}"]`)?.focus();
    return;
  }
  if (target.closest('[data-close]')) {
    if(panelAthlete)document.querySelector<HTMLButtonElement>(`button[data-athlete="${CSS.escape(panelAthlete)}"]`)?.focus();
    panelAthlete = nextPanelAthlete(panelAthlete, null);
    syncPanel();
    return;
  }
  const tab = target.closest('[data-panel-tab]');
  if (tab instanceof HTMLButtonElement) {
    panelTab = tab.dataset.panelTab === 'props' ? 'props' : 'forecast';
    syncPanel();
    document.getElementById(`${panelTab}-tab`)?.focus();
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
    boxRoot?.querySelector<HTMLButtonElement>(`button[data-sort="${key}"][data-side="${side}"]`)?.focus();
    return;
  }
  const player = target.closest('button[data-athlete]');
  if (!(player instanceof HTMLButtonElement)) return;
  propForm = {...DEFAULT_PROP_FORM};
  panelAthlete = nextPanelAthlete(panelAthlete, player.dataset.athlete ?? null);
  syncPanel();
  if(panelAthlete)document.getElementById(`${panelTab}-tab`)?.focus();
}

function readPropForm(): void {
  const market = document.querySelector<HTMLSelectElement>('[data-prop-market]');
  const line = document.querySelector<HTMLInputElement>('[data-prop-line]');
  const odds = document.querySelector<HTMLInputElement>('[data-prop-odds]');
  const opposite = document.querySelector<HTMLInputElement>('[data-prop-opposite]');
  const style = document.querySelector<HTMLSelectElement>('[data-prop-style]');
  const side = document.querySelector<HTMLInputElement>('[data-prop-side]:checked');
  if (!market || !line || !odds || !opposite) return;
  propForm = {
    market: market.value==='pa'||market.value==='pr'||market.value==='ra'||market.value==='dd'||market.value==='td'||market.value === 'stl' || market.value === 'blk' || market.value === 'tov' || market.value === 'reb' || market.value === 'ast' || market.value === 'pra' || market.value === 'tpm' ? market.value : 'pts',
    side: side?.value === 'under' ? 'under' : 'over',
    line: line.value,
    style: style?.value === 'multiplier' || style?.value === 'percent' ? style.value : 'american',
    odds: odds.value,
    opposite: opposite.value,
  };
}

function paintPropResults(): void {
  if (desk?.dataset.mode === 'projections') {
    paintProjectionFigures();
    return;
  }
  if (!view || !panelAthlete) return;
  const results = playerFrame?.querySelector<HTMLElement>('[data-prop-results]') ?? null;
  if (!results) return;
  const open = results.querySelector('details.prop-advanced');
  const keepOpen = open instanceof HTMLDetailsElement && open.open;
  const player = view.rates.players.find((item) => item.athlete_id === panelAthlete) ?? null;
  results.innerHTML = renderPropResults(view.result, panelAthlete, propForm, player);
  const details = results.querySelector('details.prop-advanced');
  if (keepOpen && details instanceof HTMLDetailsElement) details.open = true;
}

function onPropEdit(event: Event): void {
  if(event.target instanceof HTMLInputElement&&event.target.matches('[data-game-line]')&&view){
    const kind=event.target.dataset.gameLine,values=kind==='total'?view.result.combinedTotals:view.result.homeTotals.map((x,i)=>x-view!.result.awayTotals[i]);
    const result=document.querySelector(`[data-line-result="${kind}"]`);
    if(result){const line=Number(event.target.value);if(!event.target.value||!Number.isFinite(line)){result.textContent='Enter a line.';return;}const p=lineProbability(values,line);result.textContent=`Above ${(p.over*100).toFixed(1)}%; below ${(p.under*100).toFixed(1)}%; push ${(p.push*100).toFixed(1)}%.`;}
    return;
  }
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches('[data-projection-search]')) {
    projectionQuery = target.value;
    const hits = projectionsRoot?.querySelector<HTMLElement>('[data-projection-hits]');
    if (hits && slate && card) hits.innerHTML = searchHitsHtml(slate, card, projectionQuery);
    return;
  }
  if (!(target instanceof Element) || !target.closest('[data-prop-form]')) return;
  readPropForm();
  if (desk?.dataset.mode === 'projections') {
    if (target instanceof HTMLInputElement && target.matches('[data-prop-line]')) projectionAutoLine = false;
    if (propForm.market === 'dd' || propForm.market === 'td') propForm = { ...propForm, line: '0.5' };
    const structural = target instanceof HTMLSelectElement && (target.matches('[data-prop-market]') || target.matches('[data-prop-style]'));
    if (structural) {
      paintProjection();
      const selector = target.matches('[data-prop-style]') ? '[data-prop-style]' : '[data-prop-market]';
      projectionsRoot?.querySelector<HTMLElement>(selector)?.focus();
      return;
    }
    const line = projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-line]');
    if (line && (propForm.market === 'dd' || propForm.market === 'td')) line.value = '0.5';
    paintProjectionFigures();
    return;
  }
  if (target instanceof HTMLSelectElement && target.matches('[data-prop-style]')) {
    syncPanel();
    return;
  }
  paintPropResults();
}

function onDeskChange(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.matches('input[data-lineup-choice]')) onLineupChoice(target);
}

function onImageError(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) return;
  const frame = target.closest('.logo, .photo, .avatar');
  if (!(frame instanceof HTMLElement)) return;
  target.hidden = true;
  const mono = frame.querySelector('.mono');
  if (mono instanceof HTMLElement) mono.hidden = false;
  if (!frame.classList.contains('photo')) return;
  const note = frame.parentElement?.querySelector('.photo-note');
  if (note instanceof HTMLElement) note.hidden = false;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && document.querySelector('.sim-screen')) {
    event.preventDefault();
    cancelRun?.();
    return;
  }
  if(event.target instanceof Element && event.target.matches('[data-panel-tab]') && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();panelTab=event.key==='Home'?'forecast':event.key==='End'?'props':panelTab==='forecast'?'props':'forecast';syncPanel();document.getElementById(`${panelTab}-tab`)?.focus();return;
  }
  if (event.target instanceof Element && event.target.matches('[data-history-bar]') && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    const idx = Number(event.target.getAttribute('data-history-bar'));
    if (Number.isInteger(idx) && idx >= 0) {
      projectionSelectedBar = idx;
      paintProjectionFigures();
      projectionsRoot?.querySelector<HTMLElement>(`[data-history-bar="${idx}"]`)?.focus();
    }
    return;
  }
  if (event.key !== 'Escape' || panelAthlete === null) return;
  document.querySelector<HTMLButtonElement>(`button[data-athlete="${CSS.escape(panelAthlete)}"]`)?.focus();
  panelAthlete = nextPanelAthlete(panelAthlete, null);
  syncPanel();
}

function bind(): void {
  if (bound || !desk) return;
  bound = true;
  desk.addEventListener('click', onDeskClick);
  desk.addEventListener('change', onDeskChange);
  desk.addEventListener('input', onPropEdit);
  desk.addEventListener('change', onPropEdit);
  desk.addEventListener('submit', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-prop-form]')) event.preventDefault();
  });
  desk.addEventListener('error', onImageError, true);
  document.addEventListener('keydown', onKey);
}

async function load(): Promise<void> {
  if (!slateRoot) return;
  try {
    const loaded=await loadGeneration(async name=>{
      const response=await fetch(`${DATA_BASE}${name}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(response.status===404&&['manifest.json','health.json'].includes(name))return null;
      if(!response.ok)throw new Error('Data fetch failed');
      const text=await response.text();
      if(name==='health.json'){try{JSON.parse(text);}catch{return null;}}
      return text;
    },async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join(''));
    slate=loaded.slate;card=loaded.card;health=loaded.health;
    lineupEdits=readStoredLineups(storedLineups(),slate.games.map(g=>g.event_id));
    bind();
    if (readHash() === '#projections') showProjections();
    else showSlate();
  } catch {
    bind();
    slateRoot.innerHTML = '<p class="state" role="alert">Slate could not be loaded or validated. <button data-retry>Retry</button></p>';
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

function readHash(): string {
  try {
    return location.hash;
  } catch {
    return '';
  }
}

function navigateDesk(mode: 'games' | 'projections'): void {
  const next = mode === 'projections' ? '#projections' : '';
  try {
    if (location.hash !== next) {
      location.hash = next;
      return;
    }
  } catch {
    // Some hosts have no location object. The click still changes the surface.
  }
  if (mode === 'projections') showProjections();
  else showSlate();
}

document.querySelectorAll<HTMLButtonElement>('[data-desk-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    navigateDesk(button.dataset.deskTab === 'projections' ? 'projections' : 'games');
  });
});

window.addEventListener('hashchange', () => {
  if (!slate || !card) {
    markDeskTabs();
    return;
  }
  if (readHash() === '#projections') showProjections();
  else showSlate();
});

applyTheme(themeFromStorage(storedTheme(), window.matchMedia('(prefers-color-scheme: light)').matches));
bindTheme();
void load();

function recheckFreshness(): void {
  paintFreshness();
  if(slate && card && freshnessIssue(slate,card,new Date(),health)){activeWorker?.terminate();cancelRun?.();showSlate();}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)recheckFreshness();});
setInterval(recheckFreshness,60000);
