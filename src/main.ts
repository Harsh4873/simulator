import './styles.css';
import {lineProbability} from './distributions.ts';
import {loadGeneration} from './load-generation.ts';
import type {RefreshHealth} from './generation.ts';
import { freshnessIssue } from './validate-card.ts';
import {
  DEFAULT_SIDE_SORTS,
  isColumnKey,
  marginsOf,
  nextBoxSort,
  DEFAULT_PROP_FORM,
  renderBoxScore,
  renderPlayerPanel,
  renderPropResults,
  type PanelTab,
  type PropFormState,
  type SideSorts,
} from './boxscore.ts';
import { nextPanelAthlete, sportFromStorage, themeFromStorage, type Sport } from './display.ts';
import { renderLineupEditor } from './lineup-editor.ts';
import { applyLineupOverrides, cleanOverrides, isLineupChoice, LINEUP_STORAGE_KEY, overridesKey, readStoredLineups, summarizeOverrides, type LineupOverrides } from './lineup-overrides.ts';
import { healthyCheck } from './generation.ts';
import { fnv1a } from './rng.ts';
import type { BookLine } from './book-lines.ts';
import { buildOddsScreen, renderOddsBoard, type OddsQuote } from './odds-board.ts';
import { gameLeans, LEAN_BUCKETS, linesByKey, MIN_PLAY_SHARE, parsePicksFile, type Lean, type PicksFile } from './picks.ts';
import { parsePublishedPropCalibration, type PropCalibrationArtifact, type PropCalibrationCard, type PropCalibrationGroup, type PropPanelCalibration } from './prop-calibration.ts';
import {
  bookLineFor,
  defaultMarketLine,
  gameLogRowsHtml,
  historyChartBlockHtml,
  historySummaryHtml,
  historyWindowsHtml,
  isDefenseSlot,
  isBoardSort,
  isHistorySplit,
  isPropMarket,
  l10HistoricalValues,
  leanPanelHtml,
  measuredNoteHtml,
  modelChanceHtml,
  openLeanEvents,
  playedValues,
  postedLineHtml,
  projectionBoardHtml,
  projectionChartHtml,
  renderProjections,
  searchHitsHtml,
  viewerLine,
  type BoardSort,
  type HistorySplit,
  type ProjectionView,
  type SupportMode,
} from './projections.ts';
import { unpackPlayerGames, type DefenseSlot } from './projection-context.ts';
import { fetchPublishedIndex, fetchPublishedSimulation, type PublishedExpectation } from './published-sim.ts';
import { hydrateSimulationCache, persistSimulationEntry } from './simulation-cache.ts';
import { parseEsportsDocument, renderEsports } from './esports/props.ts';
import { parseFeedSlate, renderFeedSlate } from './feed.ts';
import { escapeHtml, renderSlate } from './slate.ts';
import { ITERATIONS, type Simulation } from './simulate.ts';
import type { RateCard, RateGame, Slate, SlateGame } from './types.ts';

const DATA_BASE = '/simulator/data/';
const THEME_KEY = 'simulator.theme';
const SPORT_KEY = 'simulator.sport';
const FEED_FOOT = 'Schedule from a public feed. No line or price is shown. A projection is shown only when it is fit from results.';
const SECTION_KEY = 'simulator.sections';
const MEMORY_CACHE_LIMIT = 24;

const desk = document.querySelector<HTMLElement>('#desk');
const slateRoot = document.querySelector<HTMLElement>('#slate');
const boxRoot = document.querySelector<HTMLElement>('#boxscore');
const stageFrame = document.querySelector<HTMLElement>('[data-region="stage"]');
const playerFrame = document.querySelector<HTMLElement>('[data-region="player"]');
const panelBody = document.querySelector<HTMLElement>('[data-panel-body]');
const projectionsRoot = document.querySelector<HTMLElement>('#projections');
const projectionsFrame = document.querySelector<HTMLElement>('[data-region="projections"]');
const boardRoot = document.querySelector<HTMLElement>('#board');
const boardFrame = document.querySelector<HTMLElement>('[data-region="board"]');
const foot = document.querySelector<HTMLElement>('.foot p');
const nbaFoot = foot?.textContent ?? '';

let slate: Slate | null = null;
let card: RateCard | null = null;
let health:RefreshHealth|null=null;
let bound = false;
let running = false;
let activeWorker: Worker | null = null;
let cancelRun: (()=>void) | null = null;
let prefetchWorker: Worker | null = null;
let cancelPrefetch: (()=>void) | null = null;
let prefetchTimer = 0;
let simulationEpoch = 0;
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
let projectionBoardSort: BoardSort = 'projection';
let projectionSelectedBar: number | null = null;
let projectionSupportMode: SupportMode = 'avg';
let projectionTeammate: string | null = null;
let projectionDefenseSlot: DefenseSlot | null = null;
let projectionAutoLine = false;
/** True while the price boxes hold the posted price rather than something the viewer typed. */
let projectionAutoPrice = false;
/** Published lines, leans and record. Optional: the page works without it. */
let picks: PicksFile | null = null;
let bookLines: Map<string, BookLine> = new Map();
let propCalibration: { table: Map<PropCalibrationGroup, PropCalibrationCard>; artifacts: PropCalibrationArtifact[] } | null = null;
/** Leans compared in this browser, per cached simulation. Reset whenever the posted lines are reloaded. */
let localLeans = new WeakMap<Simulation, Lean[]>();
/** Games whose 10,000 draws were published with this card, so they are fetched instead of simulated. */
let publishedEvents = new Set<string>();
const publishedInFlight = new Map<string, Promise<Simulation | null>>();
let prefetchingPublished = false;
/** Set only while this game's worker is drawing. A cache hit never sets it. */
let drawingEvent: string | null = null;
let drawingProgress = 0;
let sport: Sport = 'nba';
let feedToken = 0;
let nbaFailed = false;

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
  if (!pill) return;
  if (currentSport() !== 'nba') {
    pill.hidden = true;
    return;
  }
  if (!slate || !card) return;
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
  const full = stale ? `Data stale · checked ${age}` : `Data checked ${age}`;
  // On a phone the pill is short so the header stays one row; the dot's color and the title carry the rest.
  pill.textContent = window.matchMedia('(max-width: 560px)').matches ? (stale ? `Stale · ${age}` : age) : full;
  pill.title = full;
}

/** On a phone the detail and the board sit below the list that was tapped, so bring the one just opened into view. */
function reveal(selector: string): void {
  if (!window.matchMedia('(max-width: 1020px)').matches) return;
  const target = projectionsRoot?.querySelector<HTMLElement>(selector);
  if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function rateGame(eventId: string): RateGame | null {
  return card?.games.find((game) => game.event_id === eventId) ?? null;
}

function gamesFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-region="games"]');
}

function generationKey(): string {
  return `${card?.input_hash ?? card?.generated_at}:${card?.model_hash ?? card?.model_version ?? 'legacy'}`;
}

function simulationKey(eventId: string, overrides: LineupOverrides): string {
  return `${eventId}:${generationKey()}:${overridesKey(overrides)}`;
}

function storeCachedSimulation(key: string, result: Simulation): void {
  simulationCache.delete(key);
  simulationCache.set(key, result);
  while (simulationCache.size > MEMORY_CACHE_LIMIT) {
    simulationCache.delete(simulationCache.keys().next().value!);
  }
  // A published game is a small file to fetch again. Storing it would only copy its arrays into the browser's database.
  if (card && !result.published) void persistSimulationEntry(key, generationKey(), result);
}

async function getData(name: string): Promise<string | null> {
  const response = await fetch(`${DATA_BASE}${name}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  return response.ok ? response.text() : null;
}

function publishedExpectation(eventId: string): PublishedExpectation | null {
  if (!card) return null;
  return {
    event_id: eventId,
    generated_at: card.generated_at,
    input_hash: card.input_hash ?? null,
    model_hash: card.model_hash ?? null,
    seed: fnv1a(`${eventId}:${card.generated_at ?? ''}`),
    iterations: ITERATIONS,
  };
}

async function loadPublishedIndex(): Promise<void> {
  publishedEvents = new Set();
  publishedInFlight.clear();
  const expected = publishedExpectation('0');
  if (!expected) return;
  const { event_id: _event, seed: _seed, ...rest } = expected;
  void _event;
  void _seed;
  publishedEvents = await fetchPublishedIndex(getData, rest);
}

/**
 * The game's 10,000 draws as published with this card, or null to draw them here. A viewer's lineup calls change the
 * game, so a called game is always drawn here.
 */
function publishedSimulation(eventId: string): Promise<Simulation | null> {
  const expected = publishedExpectation(eventId);
  if (!expected || !publishedEvents.has(eventId) || Object.keys(editsFor(eventId)).length) return Promise.resolve(null);
  let pending = publishedInFlight.get(eventId);
  if (!pending) {
    pending = fetchPublishedSimulation(getData, expected).then((result) => {
      publishedInFlight.delete(eventId);
      // A file that could not be read is not asked for again; the game is drawn here.
      if (!result) publishedEvents.delete(eventId);
      return result;
    });
    publishedInFlight.set(eventId, pending);
  }
  return pending;
}

function cachedSimulation(eventId: string): Simulation | null {
  if (!card) return null;
  return simulationCache.get(simulationKey(eventId, editsFor(eventId))) ?? null;
}

function readyEventIdSet(): Set<string> {
  const ready = new Set<string>();
  if (!slate || !card) return ready;
  for (const g of slate.games) {
    if (cachedSimulation(g.event_id)) ready.add(g.event_id);
  }
  return ready;
}

function unmountProjections(): void {
  if (projectionsFrame) projectionsFrame.hidden = true;
  projectionsRoot?.replaceChildren();
}

function unmountBoard(): void {
  if (boardFrame) boardFrame.hidden = true;
  boardRoot?.replaceChildren();
}

function unmountSheet(): void {
  panelAthlete = null;
  panelBody?.replaceChildren();
  desk?.classList.remove('panel-open');
  if (playerFrame) playerFrame.hidden = true;
}

/** Score, empty, error, loading, and lineups stay on the Games tab. */
function deskTabName(): 'games' | 'projections' | 'board' {
  const mode = desk?.dataset.mode;
  if (mode === 'projections') return 'projections';
  if (mode === 'board') return 'board';
  return 'games';
}

function markDeskTabs(): void {
  const selected = deskTabName();
  document.querySelectorAll<HTMLButtonElement>('[data-desk-tab]').forEach((button) => {
    button.setAttribute('aria-selected', button.dataset.deskTab === selected ? 'true' : 'false');
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
    drawProgress: drawingProgress,
    readyEventIds: readyEventIdSet(),
    overrides: projectionEvent ? editsFor(projectionEvent) : {},
    historySplit: projectionHistorySplit,
    boardSort: projectionBoardSort,
    selectedGameIndex: projectionSelectedBar,
    supportMode: projectionSupportMode,
    selectedTeammateId: projectionTeammate,
    defenseSlot: projectionDefenseSlot,
    lines: bookLines,
    ...slateLeans(),
    record: picks?.record ?? null,
    book: picks?.book ?? null,
    propCalibration: panelCalibration(projectionEvent ? slate.games.find((item) => item.event_id === projectionEvent)?.date ?? null : null),
  };
}

function panelCalibration(tipDate: string | null | undefined): PropPanelCalibration | null {
  if (!propCalibration || !tipDate) return null;
  // Maps are keyed to the simulation family, so a page-only release does not retire them.
  return { table: propCalibration.table, modelVersion: card?.model_version ?? null, tipDate, artifacts: propCalibration.artifacts, cutoff: tipDate };
}

function postedLine(eventId: string | null, athleteId: string | null, market: PropFormState['market']): BookLine | null {
  return bookLineFor(bookLines, eventId, athleteId, market);
}

/**
 * Leans for games that have not started. A game simulated in this browser is compared here, so a lineup call shows
 * up in its leans. Any other game uses the leans published with the same card. A game with neither is still waiting.
 */
function slateLeans(): { leans: Lean[]; leansWaiting: number } {
  const leans: Lean[] = [];
  let leansWaiting = 0;
  if (!slate || !card) return { leans, leansWaiting };
  const published = picks !== null && picks.generated_at === card.generated_at && picks.model_hash === (card.model_hash ?? null);
  for (const eventId of openLeanEvents(slate, bookLines, new Date())) {
    const game = slate.games.find((item) => item.event_id === eventId);
    const base = rateGame(eventId);
    if (!game || !base || base.simulation_error) continue;
    const overrides = editsFor(eventId);
    const simulation = cachedSimulation(eventId);
    if (simulation) {
      let mine = localLeans.get(simulation);
      if (!mine) {
        mine = gameLeans(game, applyLineupOverrides(base, overrides), simulation.playerDraws, bookLines, propCalibration?.table, card.model_version).filter(
          (lean) => lean.claimed >= LEAN_BUCKETS[1] && lean.play >= MIN_PLAY_SHARE,
        );
        localLeans.set(simulation, mine);
      }
      leans.push(...mine);
    } else if (published && Object.keys(overrides).length === 0) {
      for (const lean of picks!.leans) if (lean.event_id === eventId) leans.push(lean);
    } else leansWaiting += 1;
  }
  return { leans, leansWaiting };
}

function paintModelSides(): void {
  const el = projectionsRoot?.querySelector<HTMLElement>('[data-model-sides]');
  if (!el || !slate || !card) return;
  const open = el.querySelectorAll<HTMLDetailsElement>('details[open]');
  const keep = new Set(Array.from(open, (item) => item.className));
  el.innerHTML = leanPanelHtml({
    slate,
    now: new Date(),
    lines: bookLines,
    ...slateLeans(),
    record: picks?.record ?? null,
    book: picks?.book ?? null,
    calibration: { artifacts: propCalibration?.artifacts ?? [], family: card.model_version ?? null },
  });
  for (const details of el.querySelectorAll<HTMLDetailsElement>('details')) if (keep.has(details.className)) details.open = true;
}

/** Fills the line, and the price when one is posted, for the player and stat now in view. */
function applyDefaultLine(market: PropFormState['market'], sample: Parameters<typeof defaultMarketLine>[1], eventId: string | null, athleteId: string | null): void {
  const posted = postedLine(eventId, athleteId, market);
  const auto = defaultMarketLine(market, sample, card?.projection_context, athleteId, posted);
  projectionAutoLine = sample === null && auto !== null && !posted;
  // A line carried over from the last player or stat would grade this one at someone else's number.
  const line = auto !== null ? String(auto) : market === 'dd' || market === 'td' ? '0.5' : '';
  if (posted) {
    const over = propForm.side !== 'under';
    propForm = { ...propForm, market, line, style: 'american', odds: String(over ? posted.over_odds : posted.under_odds), opposite: String(over ? posted.under_odds : posted.over_odds) };
    projectionAutoPrice = true;
  } else {
    propForm = projectionAutoPrice ? { ...propForm, market, line, odds: '', opposite: '' } : { ...propForm, market, line };
    projectionAutoPrice = false;
  }
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
  const keep = new Set(Array.from(projectionsRoot.querySelectorAll<HTMLDetailsElement>('[data-model-sides] details[open]'), (item) => item.className));
  projectionsRoot.innerHTML = renderProjections(viewModel);
  for (const details of projectionsRoot.querySelectorAll<HTMLDetailsElement>('[data-model-sides] details')) if (keep.has(details.className)) details.open = true;
  lockMilestoneLine();
  restoreProjectionCaret(caret);
  applyHiddenSections(projectionsRoot);
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
  if (board && rate) board.innerHTML = projectionBoardHtml(rate, simulation, form, projectionEvent, projectionAthlete, card.projection_context, projectionBoardSort, bookLines, panelCalibration(game?.date));
  const postedEl = projectionsRoot.querySelector<HTMLElement>('[data-posted]');
  if (postedEl) postedEl.innerHTML = postedLineHtml(postedLine(projectionEvent, projectionAthlete, form.market), form);
  const measuredEl = projectionsRoot.querySelector<HTMLElement>('[data-measured]');
  if (measuredEl) measuredEl.innerHTML = measuredNoteHtml(sample, form, picks?.record ?? null, panelCalibration(game?.date));
  const player = projectionAthlete ? rate?.players.find((item) => item.athlete_id === projectionAthlete) ?? null : null;
  const results = projectionsRoot.querySelector<HTMLElement>('[data-prop-results]');
  if (results && simulation && projectionAthlete) {
    const open = results.querySelector('details.prop-advanced');
    const keepOpen = open instanceof HTMLDetailsElement && open.open;
    results.innerHTML = renderPropResults(simulation, projectionAthlete, form, player, picks?.record ?? null, panelCalibration(game?.date));
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
    if (windowsEl) windowsEl.innerHTML = historyWindowsHtml(filtered, form, context.active_season, oppSide.team_id, allRows);
    const logBody = projectionsRoot.querySelector<HTMLElement>('[data-gamelog-body]');
    if (logBody) logBody.innerHTML = gameLogRowsHtml(filtered, form, slate, context);
  }
}

function paintProjectionProgress(progress: number): void {
  drawingProgress = Math.min(1, Math.max(0, progress));
  if (desk?.dataset.mode !== 'projections' || !projectionsRoot) return;
  const pct = Math.round(drawingProgress * 100);
  const fill = projectionsRoot.querySelector<HTMLElement>('[data-projection-progress]');
  if (fill) fill.style.width = `${pct}%`;
  const text = projectionsRoot.querySelector<HTMLElement>('[data-projection-pct]');
  if (text) text.textContent = `${pct}%`;
  const bar = fill?.closest('[role="progressbar"]');
  if (bar) bar.setAttribute('aria-valuenow', String(pct));
}

function stopPrefetch(): void {
  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = 0;
  }
  cancelPrefetch?.();
}

/** What the page does when a game's draws arrive in the background, whether fetched or simulated. */
function prefetched(eventId: string, key: string, result: Simulation): void {
  storeCachedSimulation(key, result);
  if (desk?.dataset.mode !== 'projections') return;
  if (projectionEvent === eventId) {
    if (projectionAthlete && (propForm.line.trim() === '' || projectionAutoLine)) {
      applyDefaultLine(propForm.market, result.playerDraws.get(projectionAthlete) ?? null, projectionEvent, projectionAthlete);
      projectionAutoLine = false;
    }
    paintProjection();
  } else {
    const btn = projectionsRoot?.querySelector<HTMLElement>(`button[data-projection-game="${CSS.escape(eventId)}"] .game-row-head`);
    if (btn && !btn.querySelector('.ready-dot')) {
      btn.insertAdjacentHTML('beforeend', '<span class="ready-dot" title="10,000 simulations cached">10k ready</span>');
    }
    paintModelSides();
  }
  scheduleNextPrefetch();
}

function scheduleNextPrefetch(): void {
  if (prefetchTimer || prefetchWorker || prefetchingPublished || running || desk?.dataset.mode !== 'projections') return;
  if (typeof indexedDB === 'undefined') return;
  if (!slate || !card || freshnessIssue(slate, card, new Date(), health)) return;
  const candidates = [...slate.games].sort((a, b) => {
    const aPriority = a.event_id === projectionEvent ? 0 : a.completed ? 2 : 1;
    const bPriority = b.event_id === projectionEvent ? 0 : b.completed ? 2 : 1;
    return aPriority - bPriority || a.start_time.localeCompare(b.start_time);
  });
  const nextGame = candidates.find((g) => {
    const base = rateGame(g.event_id);
    return Boolean(base && !base.simulation_error && !cachedSimulation(g.event_id));
  });
  if (!nextGame) return;
  prefetchTimer = window.setTimeout(() => {
    prefetchTimer = 0;
    if (running || prefetchWorker || desk?.dataset.mode !== 'projections' || !slate || !card) return;
    if (cachedSimulation(nextGame.event_id)) {
      scheduleNextPrefetch();
      return;
    }
    const base = rateGame(nextGame.event_id);
    if (!base || base.simulation_error) return;
    const overrides = editsFor(nextGame.event_id);
    const rates = applyLineupOverrides(base, overrides);
    const key = simulationKey(nextGame.event_id, overrides);
    if (publishedEvents.has(nextGame.event_id) && !Object.keys(overrides).length) {
      prefetchingPublished = true;
      void publishedSimulation(nextGame.event_id).then((result) => {
        prefetchingPublished = false;
        if (result && !cachedSimulation(nextGame.event_id)) prefetched(nextGame.event_id, key, result);
        else scheduleNextPrefetch();
      });
      return;
    }
    const worker = new Worker(new URL('./simulation-worker.ts', import.meta.url), { type: 'module' });
    prefetchWorker = worker;
    const finish = () => {
      worker.terminate();
      if (prefetchWorker === worker) prefetchWorker = null;
      cancelPrefetch = null;
    };
    cancelPrefetch = finish;
    worker.onmessage = (event: MessageEvent<{ result?: Simulation; error?: string; progress?: number }>) => {
      if (event.data.progress !== undefined) return;
      finish();
      if (event.data.result) prefetched(nextGame.event_id, key, event.data.result);
    };
    worker.onerror = () => finish();
    worker.postMessage({ game: rates, seed: fnv1a(`${nextGame.event_id}:${card.generated_at ?? ''}`), iterations: ITERATIONS });
  }, 180);
}

function showProjections(): void {
  if (currentSport() !== 'nba') return;
  if (!slate || !card || !desk || !projectionsRoot) return;
  const entering = desk.dataset.mode !== 'projections';
  if (entering) {
    cancelRun?.();
    drawingEvent = null;
    drawingProgress = 0;
  }
  unmountSheet();
  unmountBoard();
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
  scheduleNextPrefetch();
}

function showSlate(): void {
  if (currentSport() !== 'nba') return;
  if (!slateRoot || !slate || !card) return;
  stopPrefetch();
  cancelRun?.();
  drawingEvent = null;
  drawingProgress = 0;
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
  unmountBoard();
  try {
    if (location.hash === '#projections' || location.hash === '#board') location.hash = '';
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
  applyHiddenSections(boxRoot);
  window.scrollTo(0, scrollY);
}

function showScore(): void {
  const games = gamesFrame();
  if (games) games.hidden = true;
  if (stageFrame) stageFrame.hidden = false;
  if (playerFrame) playerFrame.hidden = true;
  desk?.classList.remove('panel-open');
  unmountProjections();
  unmountBoard();
  if (desk) desk.dataset.mode = 'score';
  markDeskTabs();
}

function syncPanel(): void {
  if (desk?.dataset.mode === 'projections' || desk?.dataset.mode === 'board') return;
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
    picks?.record ?? null,
    panelCalibration(view.game.date),
  );
  applyHiddenSections(panelBody);
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
  const title = `Away ${away} at Home ${home}`;
  const screen = document.createElement('div');
  screen.className = 'sim-screen';
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-modal', 'true');
  screen.setAttribute('aria-labelledby', 'sim-clock-title');
  screen.innerHTML = `<div class="sim-clock" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${escapeHtml(title)}"><svg viewBox="0 0 200 200" aria-hidden="true"><circle class="sim-face" cx="100" cy="100" r="96"></circle><g class="sim-ticks">${clockTicks()}</g><circle class="sim-track" cx="100" cy="100" r="${CLOCK_RADIUS}"></circle><circle class="sim-arc" cx="100" cy="100" r="${CLOCK_RADIUS}" transform="rotate(-90 100 100)"></circle><g class="sim-hand" transform="rotate(0 100 100)"><line class="sim-hand-tail" x1="100" y1="100" x2="100" y2="118"></line><line class="sim-hand-arm" x1="100" y1="100" x2="100" y2="40"></line><circle class="sim-hub" cx="100" cy="100" r="5"></circle></g></svg></div><p id="sim-clock-title" class="sim-clock-title">${escapeHtml(title)}</p><p class="sim-clock-note">Simulating</p><button type="button" class="ghost" data-cancel>Cancel</button>`;
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

function drawSimulation(
  rates: RateGame,
  eventId: string,
  screen: HTMLElement | null,
  epoch: number,
  onProgress?: (progress: number) => void,
): Promise<Simulation> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker | null = null;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (result: Simulation) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const finish = () => {
      worker?.terminate();
      if (worker && activeWorker === worker) activeWorker = null;
      if (cancelRun === cancel) cancelRun = null;
    };
    const cancel = () => {
      finish();
      fail(new Error('Simulation cancelled'));
    };
    cancelRun = cancel;
    setTimeout(() => {
      if (settled || epoch !== simulationEpoch) {
        finish();
        fail(new Error('Simulation cancelled'));
        return;
      }
      worker = new Worker(new URL('./simulation-worker.ts', import.meta.url), { type: 'module' });
      activeWorker = worker;
      worker.onmessage = (event: MessageEvent<{ result?: Simulation; error?: string; progress?: number }>) => {
        if (epoch !== simulationEpoch) {
          finish();
          fail(new Error('Simulation cancelled'));
          return;
        }
        if (event.data.progress !== undefined) {
          if (screen) paintSimClock(screen, event.data.progress);
          onProgress?.(event.data.progress);
          return;
        }
        finish();
        if (event.data.result) succeed(event.data.result);
        else fail(new Error(event.data.error ?? 'Simulation failed'));
      };
      worker.onerror = () => {
        finish();
        fail(new Error('Simulation worker failed'));
      };
      worker.postMessage({ game: rates, seed: fnv1a(`${eventId}:${card!.generated_at ?? ''}`), iterations: ITERATIONS });
    }, 0);
  });
}

async function runSimulation(
  eventId: string,
  options: { modalClock?: boolean } = {},
): Promise<Simulation | null> {
  if (!eventId || !slate || !card) return null;
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
    if (drawingEvent === eventId) {
      drawingEvent = null;
      drawingProgress = 0;
    }
    storeCachedSimulation(key, cached);
    view = { game, rates, result: cached };
    return cached;
  }
  if (!Object.keys(overrides).length && publishedEvents.has(eventId)) {
    const epoch = simulationEpoch;
    const published = await publishedSimulation(eventId);
    if (published && epoch === simulationEpoch) {
      const stored = simulationCache.get(key) ?? published;
      if (!simulationCache.has(key)) storeCachedSimulation(key, published);
      view = { game, rates, result: stored };
      return stored;
    }
    if (published) return null;
  }
  if (running) {
    if (options.modalClock !== false || !cancelRun) return null;
    simulationEpoch += 1;
    const cancel = cancelRun;
    cancelRun = null;
    running = false;
    cancel();
  }
  const epoch = simulationEpoch;
  stopPrefetch();
  running = true;
  drawingEvent = eventId;
  drawingProgress = 0;
  const useModal = options.modalClock !== false;
  if (useModal) desk?.setAttribute('aria-busy', 'true');
  if (desk?.dataset.mode === 'projections') paintProjection();
  const screen = useModal ? openSimClock(game) : null;
  try {
    const result = await drawSimulation(
      rates,
      eventId,
      screen,
      epoch,
      useModal ? undefined : (progress) => {
        if (epoch === simulationEpoch && drawingEvent === eventId) paintProjectionProgress(progress);
      },
    );
    if (epoch !== simulationEpoch) throw new Error('Simulation cancelled');
    storeCachedSimulation(key, result);
    view = { game, rates, result };
    return result;
  } finally {
    if (epoch === simulationEpoch) {
      if (drawingEvent === eventId) {
        drawingEvent = null;
        drawingProgress = 0;
      }
      closeSimClock(screen);
      if (useModal) desk?.setAttribute('aria-busy', 'false');
      running = false;
      if (desk?.dataset.mode === 'projections') scheduleNextPrefetch();
    } else {
      closeSimClock(screen);
    }
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
    const result = await runSimulation(eventId, { modalClock: false });
    if (drawingEvent === eventId) {
      drawingEvent = null;
      drawingProgress = 0;
    }
    if (desk?.dataset.mode !== 'projections') return;
    if (result && projectionAthlete && (propForm.line.trim() === '' || projectionAutoLine)) {
      applyDefaultLine(propForm.market, result.playerDraws.get(projectionAthlete) ?? null, projectionEvent, projectionAthlete);
      projectionAutoLine = false;
    }
    paintProjection();
    if (result) return;
  } catch (error) {
    if (error instanceof Error && error.message === 'Simulation cancelled') return;
    if (drawingEvent === eventId) {
      drawingEvent = null;
      drawingProgress = 0;
    }
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
  stopPrefetch();
  cancelRun?.();
  drawingEvent = null;
  drawingProgress = 0;
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
  unmountBoard();
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

function readHiddenSections(): Set<string> {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set();
  }
}

function writeHiddenSections(hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SECTION_KEY, JSON.stringify([...hidden]));
  } catch {
    // The section still follows the click when storage is blocked.
  }
}

function applyHiddenSections(root: ParentNode): void {
  const hidden = readHiddenSections();
  for (const block of root.querySelectorAll<HTMLElement>('[data-block]')) {
    const id = block.getAttribute('data-block') ?? '';
    if (id && hidden.has(id)) block.setAttribute('hidden', '');
    else block.removeAttribute('hidden');
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-block-toggle]')) {
    const id = button.dataset.blockToggle ?? '';
    button.setAttribute('aria-pressed', id && hidden.has(id) ? 'false' : 'true');
  }
}

function onSectionToggle(button: HTMLButtonElement): void {
  const root = button.closest('.box-view, .projection-page, .panel-sheet');
  const id = button.dataset.blockToggle ?? '';
  if (!root || !id) return;
  const hidden = readHiddenSections();
  const show = button.getAttribute('aria-pressed') === 'false';
  if (show) hidden.delete(id);
  else hidden.add(id);
  writeHiddenSections(hidden);
  button.setAttribute('aria-pressed', show ? 'true' : 'false');
  for (const block of root.querySelectorAll<HTMLElement>(`[data-block="${CSS.escape(id)}"]`)) {
    if (show) block.removeAttribute('hidden');
    else block.setAttribute('hidden', '');
  }
}

function onDeskClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const sectionToggle = target.closest('button[data-block-toggle]');
  if (sectionToggle instanceof HTMLButtonElement) {
    onSectionToggle(sectionToggle);
    return;
  }
  if (target.closest('[data-retry]')) {
    const selected = currentSport();
    if (selected === 'nba') {
      nbaFailed = false;
      void load();
    } else if (selected === 'esports') void showEsports();
    else void showNfl();
    return;
  }
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
  const boardSortBtn = target.closest('button[data-board-sort]');
  const boardSort = boardSortBtn instanceof HTMLButtonElement ? boardSortBtn.dataset.boardSort ?? '' : '';
  if (boardSortBtn instanceof HTMLButtonElement && isBoardSort(boardSort)) {
    projectionBoardSort = boardSort;
    paintProjection();
    projectionsRoot?.querySelector<HTMLButtonElement>(`[data-board-sort="${projectionBoardSort}"]`)?.focus();
    return;
  }
  const projectionMarket = target.closest('button[data-projection-market]');
  if (projectionMarket instanceof HTMLButtonElement && isPropMarket(projectionMarket.dataset.projectionMarket ?? '')) {
    const market = projectionMarket.dataset.projectionMarket as typeof propForm.market;
    const sample = projectionEvent && projectionAthlete ? cachedSimulation(projectionEvent)?.playerDraws.get(projectionAthlete) ?? null : null;
    projectionSelectedBar = null;
    applyDefaultLine(market, sample, projectionEvent, projectionAthlete);
    paintProjection();
    projectionsRoot?.querySelector<HTMLButtonElement>(`[data-projection-market="${CSS.escape(market)}"]`)?.focus();
    return;
  }
  if (target.closest('button[data-use-posted]')) {
    const sample = projectionEvent && projectionAthlete ? cachedSimulation(projectionEvent)?.playerDraws.get(projectionAthlete) ?? null : null;
    applyDefaultLine(propForm.market, sample, projectionEvent, projectionAthlete);
    paintProjection();
    projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-line]')?.focus();
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
    if (!eventId) return;
    if (cachedSimulation(eventId)) {
      paintProjection();
      return;
    }
    drawingEvent = eventId;
    drawingProgress = 0;
    paintProjection();
    void simulateProjection(eventId);
    return;
  }
  const projectionPlayer = target.closest('button[data-projection-player]');
  if (projectionPlayer instanceof HTMLButtonElement) {
    const eventId = projectionPlayer.dataset.projectionEvent ?? '';
    const athleteId = projectionPlayer.dataset.projectionPlayer ?? '';
    if (!eventId || !athleteId) return;
    if (projectionPlayer.closest('[data-projection-hits]')) projectionQuery = '';
    projectionEvent = eventId;
    projectionAthlete = athleteId;
    projectionSelectedBar = null;
    projectionTeammate = null;
    projectionDefenseSlot = null;
    // A lean row opens its own stat and side, so the form shows the same comparison the row did.
    const leanMarket = projectionPlayer.dataset.leanMarket ?? '';
    const leanSideChoice = projectionPlayer.dataset.leanSide;
    if (isPropMarket(leanMarket)) propForm = { ...propForm, market: leanMarket, side: leanSideChoice === 'under' ? 'under' : 'over' };
    const cached = cachedSimulation(eventId);
    applyDefaultLine(propForm.market, cached?.playerDraws.get(athleteId) ?? null, eventId, athleteId);
    if (cached) {
      if (drawingEvent === eventId) {
        drawingEvent = null;
        drawingProgress = 0;
      }
      paintProjection();
      reveal('.projection-detail');
      return;
    }
    if (running && drawingEvent === eventId) {
      paintProjection();
      reveal('.projection-detail');
      return;
    }
    drawingEvent = eventId;
    drawingProgress = 0;
    paintProjection();
    reveal('.projection-detail');
    void simulateProjection(eventId);
    return;
  }
  const projectionGame = target.closest('button[data-projection-game]');
  if (projectionGame instanceof HTMLButtonElement) {
    const eventId = projectionGame.dataset.projectionGame ?? '';
    if (!eventId) return;
    projectionQuery = '';
    projectionEvent = eventId;
    projectionAthlete = null;
    paintProjection();
    reveal('.projection-board');
    if (!cachedSimulation(eventId) && !(running && drawingEvent === eventId)) {
      drawingEvent = eventId;
      drawingProgress = 0;
      paintProjection();
      void simulateProjection(eventId);
    }
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
  results.innerHTML = renderPropResults(view.result, panelAthlete, propForm, player, picks?.record ?? null, panelCalibration(view.game.date));
  const details = results.querySelector('details.prop-advanced');
  if (keepOpen && details instanceof HTMLDetailsElement) details.open = true;
}

function onPropEdit(event: Event): void {
  if(event.target instanceof HTMLInputElement&&event.target.matches('[data-game-line]')&&view){
    const kind=event.target.dataset.gameLine,values=kind==='total'?view.result.combinedTotals:marginsOf(view.result);
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
    if (target instanceof HTMLInputElement && (target.matches('[data-prop-odds]') || target.matches('[data-prop-opposite]'))) projectionAutoPrice = false;
    if (target instanceof HTMLSelectElement && target.matches('[data-prop-style]')) projectionAutoPrice = false;
    if (propForm.market === 'dd' || propForm.market === 'td') propForm = { ...propForm, line: '0.5' };
    if (target instanceof HTMLInputElement && target.matches('[data-prop-side]') && projectionAutoPrice) {
      // The boxes hold the posted price, so the other side brings its own price with it.
      const posted = postedLine(projectionEvent, projectionAthlete, propForm.market);
      if (posted) {
        const over = propForm.side !== 'under';
        propForm = { ...propForm, odds: String(over ? posted.over_odds : posted.under_odds), opposite: String(over ? posted.under_odds : posted.over_odds) };
        const odds = projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-odds]');
        const opposite = projectionsRoot?.querySelector<HTMLInputElement>('[data-prop-opposite]');
        if (odds) odds.value = propForm.odds;
        if (opposite) opposite.value = propForm.opposite;
      }
    }
    const structural = target instanceof HTMLSelectElement && (target.matches('[data-prop-market]') || target.matches('[data-prop-style]'));
    if (structural) {
      if (target.matches('[data-prop-market]')) {
        const sample = projectionEvent && projectionAthlete ? cachedSimulation(projectionEvent)?.playerDraws.get(projectionAthlete) ?? null : null;
        projectionSelectedBar = null;
        applyDefaultLine(propForm.market, sample, projectionEvent, projectionAthlete);
      }
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
  if (event.target instanceof Element && event.target.matches('[data-sport]') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End')) {
    event.preventDefault();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-sport]')];
    const current = buttons.findIndex((button) => button === event.target);
    if (current < 0) return;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : event.key === 'ArrowRight'
          ? (current + 1) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
    const next = buttons[nextIndex];
    const value = next?.dataset.sport;
    if (value === 'nba' || value === 'nfl' || value === 'esports') applySport(value);
    next?.focus();
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

/** Posted lines, published leans and the graded record. The page still simulates and projects when this is missing. */
async function loadPropCalibration(): Promise<void> {
  propCalibration = null;
  try {
    const response = await fetch(`${DATA_BASE}prop-calibration.json`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    propCalibration = parsePublishedPropCalibration(await response.text());
  } catch {
    propCalibration = null;
  }
}

async function loadPicks(): Promise<void> {
  picks = null;
  bookLines = new Map();
  localLeans = new WeakMap();
  try {
    const response = await fetch(`${DATA_BASE}picks.json`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    picks = parsePicksFile(await response.text());
    bookLines = linesByKey(picks);
  } catch {
    picks = null;
    bookLines = new Map();
  }
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
    await loadPicks();
    await loadPropCalibration();
    await loadPublishedIndex();
    lineupEdits=readStoredLineups(storedLineups(),slate.games.map(g=>g.event_id));
    bind();
    await hydrateSimulationCache(generationKey(), simulationCache);
    if (currentSport() === 'nba') {
      const hash = readHash();
      if (hash === '#projections') showProjections();
      else if (hash === '#board') showBoard();
      else showSlate();
    }
  } catch {
    nbaFailed = true;
    bind();
    if (currentSport() !== 'nba') return;
    showNbaError();
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

function storedSport(): Sport {
  try {
    return sportFromStorage(() => sessionStorage.getItem(SPORT_KEY));
  } catch {
    return 'nba';
  }
}

function currentSport(): Sport {
  return sport;
}

function showNbaError(): void {
  if (!slateRoot) return;
  unmountBoard();
  slateRoot.innerHTML = '<p class="state" role="alert">Slate could not be loaded or validated. <button data-retry>Retry</button></p>';
  if (desk) desk.dataset.mode = 'error';
  markDeskTabs();
}

function restoreNbaChrome(): void {
  const sub = document.querySelector<HTMLElement>('.brand .sub');
  if (sub) sub.textContent = 'Today and yesterday, Chicago time';
  const tabs = document.querySelector<HTMLElement>('.desk-tabs');
  if (tabs) tabs.hidden = false;
  if (foot) foot.textContent = nbaFoot;
  paintFreshness();
}

function parkNbaViews(): void {
  stopPrefetch();
  simulationEpoch += 1;
  running = false;
  drawingEvent = null;
  drawingProgress = 0;
  if (desk) desk.setAttribute('aria-busy', 'false');
  cancelRun?.();
  view = null;
  panelAthlete = null;
  lineupEvent = null;
  panelBody?.replaceChildren();
  desk?.classList.remove('panel-open');
  const games = gamesFrame();
  if (games) games.hidden = false;
  if (stageFrame) stageFrame.hidden = true;
  if (playerFrame) playerFrame.hidden = true;
  unmountProjections();
  unmountBoard();
  boxRoot?.replaceChildren();
}

function openFeed(label: string): number | null {
  const token = ++feedToken;
  const sub = document.querySelector<HTMLElement>('.brand .sub');
  if (sub) sub.textContent = 'Today and yesterday, Chicago time';
  const tabs = document.querySelector<HTMLElement>('.desk-tabs');
  if (tabs) tabs.hidden = true;
  const pill = document.querySelector<HTMLElement>('[data-fresh]');
  if (pill) pill.hidden = true;
  if (foot) foot.textContent = FEED_FOOT;
  if (desk) desk.dataset.mode = 'sport';
  parkNbaViews();
  if (!slateRoot) return null;
  slateRoot.innerHTML = `<p class="state" role="status">Loading ${label}…</p>`;
  return token;
}

async function showNfl(): Promise<void> {
  const token = openFeed('NFL');
  if (token === null) return;
  let text: string | null = null;
  try {
    text = await getData('nfl.json');
  } catch {
    text = null;
  }
  if (token !== feedToken || currentSport() !== 'nfl' || !slateRoot) return;
  const parsed = text ? parseFeedSlate(text, 'nfl') : null;
  if (!parsed) {
    slateRoot.innerHTML = '<p class="state" role="alert">NFL slate could not be loaded. <button data-retry>Retry</button></p>';
    if (desk) desk.dataset.mode = 'sport';
    return;
  }
  slateRoot.innerHTML = renderFeedSlate(parsed, new Date());
  if (desk) desk.dataset.mode = 'sport';
}

async function showEsports(): Promise<void> {
  const token = openFeed('Esports');
  if (token === null) return;
  let text: string | null = null;
  try {
    text = await getData('esports.json');
  } catch {
    text = null;
  }
  if (token !== feedToken || currentSport() !== 'esports' || !slateRoot) return;
  const parsed = text ? parseEsportsDocument(text) : null;
  if (!parsed) {
    slateRoot.innerHTML = '<p class="state" role="alert">Esports slate could not be loaded. <button data-retry>Retry</button></p>';
    if (desk) desk.dataset.mode = 'sport';
    return;
  }
  slateRoot.innerHTML = renderEsports(parsed, new Date());
  if (desk) desk.dataset.mode = 'sport';
}

function applySport(next: Sport): void {
  const changed = next !== sport;
  sport = next;
  try {
    sessionStorage.setItem(SPORT_KEY, next);
  } catch {
    // The switch still follows the click when storage is blocked.
  }
  document.querySelectorAll<HTMLButtonElement>('[data-sport]').forEach((button) => {
    const on = button.dataset.sport === next;
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    button.setAttribute('tabindex', on ? '0' : '-1');
  });
  if (!changed) return;
  if (next === 'nba') {
    feedToken += 1;
    restoreNbaChrome();
    if (slate && card) {
      const hash = readHash();
      if (hash === '#projections') showProjections();
      else if (hash === '#board') showBoard();
      else showSlate();
    } else if (nbaFailed) showNbaError();
    else if (slateRoot) slateRoot.innerHTML = '<p class="state" role="status">Loading slate…</p>';
    return;
  }
  if (next === 'esports') {
    void showEsports();
    return;
  }
  void showNfl();
}

function readHash(): string {
  try {
    return location.hash;
  } catch {
    return '';
  }
}

function boardQuotes(): OddsQuote[] {
  const names = new Map<string, string>();
  for (const game of card?.games ?? []) {
    for (const player of game.players) {
      if (player.name && !names.has(player.athlete_id)) names.set(player.athlete_id, player.name);
    }
  }
  const labels = new Map<string, string>();
  for (const game of slate?.games ?? []) {
    const away = game.away.abbreviation.trim() || game.away.name.trim();
    const home = game.home.abbreviation.trim() || game.home.name.trim();
    if (away && home) labels.set(game.event_id, `${away} at ${home}`);
  }
  return [...bookLines.values()].map((line) => ({
    event: labels.get(line.event_id) ?? line.event_id,
    player: names.get(line.athlete_id) ?? line.athlete_id,
    stat: line.market,
    line: line.line,
    period: 'full',
    book: line.book,
    over: line.over_odds,
    under: line.under_odds,
    capturedAt: line.priced_at,
    status: 'active',
  }));
}

function paintBoard(): void {
  if (!boardRoot) return;
  boardRoot.innerHTML = renderOddsBoard(buildOddsScreen(boardQuotes(), new Date()));
}

function showBoard(): void {
  if (currentSport() !== 'nba') return;
  if (!slate || !card || !desk || !boardRoot) return;
  const entering = desk.dataset.mode !== 'board';
  if (entering) {
    cancelRun?.();
    drawingEvent = null;
    drawingProgress = 0;
  }
  stopPrefetch();
  unmountSheet();
  const games = gamesFrame();
  if (games) games.hidden = true;
  if (stageFrame) stageFrame.hidden = true;
  if (entering) {
    lineupEvent = null;
    boxRoot?.replaceChildren();
  }
  unmountProjections();
  if (boardFrame) boardFrame.hidden = false;
  desk.dataset.mode = 'board';
  paintBoard();
  markDeskTabs();
}

function navigateDesk(mode: 'games' | 'projections' | 'board'): void {
  if (currentSport() !== 'nba') return;
  const next = mode === 'projections' ? '#projections' : mode === 'board' ? '#board' : '';
  try {
    if (location.hash !== next) {
      location.hash = next;
      return;
    }
  } catch {
    // Some hosts have no location object. The click still changes the surface.
  }
  if (mode === 'projections') showProjections();
  else if (mode === 'board') showBoard();
  else showSlate();
}

document.querySelectorAll<HTMLButtonElement>('[data-desk-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.deskTab;
    navigateDesk(tab === 'projections' ? 'projections' : tab === 'board' ? 'board' : 'games');
  });
});

window.addEventListener('hashchange', () => {
  if (currentSport() !== 'nba') return;
  if (!slate || !card) {
    markDeskTabs();
    return;
  }
  const hash = readHash();
  if (hash === '#projections') showProjections();
  else if (hash === '#board') showBoard();
  else showSlate();
});

document.querySelectorAll<HTMLButtonElement>('[data-sport]').forEach((button) => {
  button.addEventListener('click', () => {
    const value = button.dataset.sport;
    if (value === 'nba' || value === 'nfl' || value === 'esports') applySport(value);
  });
});

applyTheme(themeFromStorage(storedTheme(), window.matchMedia('(prefers-color-scheme: light)').matches));
bindTheme();
applySport(storedSport());
void load();

function recheckFreshness(): void {
  paintFreshness();
  if (currentSport() !== 'nba') return;
  if(slate && card && freshnessIssue(slate,card,new Date(),health)){stopPrefetch();activeWorker?.terminate();cancelRun?.();showSlate();}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)recheckFreshness();});
setInterval(recheckFreshness,60000);
