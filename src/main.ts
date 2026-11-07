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
  type BoxScenario,
  type PanelTab,
  type PropFormState,
  type SideSorts,
} from './boxscore.ts';
import { nextPanelAthlete, probabilityColorsOn, themeFromStorage } from './display.ts';
import { renderLineupEditor } from './lineup-editor.ts';
import { applyLineupOverrides, cleanOverrides, isLineupChoice, LINEUP_STORAGE_KEY, overridesKey, readStoredLineups, summarizeOverrides, type LineupOverrides } from './lineup-overrides.ts';
import { healthyCheck } from './generation.ts';
import { fnv1a } from './rng.ts';
import { renderSlate } from './slate.ts';
import { ITERATIONS, type Simulation } from './simulate.ts';
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
let health:RefreshHealth|null=null;
let bound = false;
let running = false;
let activeWorker: Worker | null = null;
let cancelRun: (()=>void) | null = null;
const simulationCache = new Map<string, Simulation>();
let panelAthlete: string | null = null;
let view: { game: SlateGame; rates: RateGame; result: Simulation } | null = null;
let sideSorts: SideSorts = DEFAULT_SIDE_SORTS;
let upsideOn = false;
let panelTab: PanelTab = 'forecast';
let propForm: PropFormState = { ...DEFAULT_PROP_FORM };
let lineupEdits: Record<string, LineupOverrides> = {};
let lineupEvent: string | null = null;

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

function scenario(): BoxScenario {
  return upsideOn ? 'upside' : 'median';
}

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
  cancelRun?.();
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
  slateRoot.innerHTML = renderSlate(slate, card, new Date(), health, editCounts());
  paintFreshness();
}

function paintScore(): void {
  if (!boxRoot || !view) return;
  const scrollY = window.scrollY;
  const base = rateGame(view.game.event_id);
  const note = base ? summarizeOverrides(base, editsFor(view.game.event_id)) : undefined;
  boxRoot.innerHTML = renderBoxScore(view.game, view.rates, view.result, new Date(), sideSorts, scenario(), note);
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
  panelBody.innerHTML = renderPlayerPanel(
    view.game,
    view.rates,
    view.result,
    panelAthlete,
    scenario(),
    panelTab,
    propForm,
  );
}

async function onSimulate(button: HTMLButtonElement): Promise<void> {
  const eventId = button.dataset.event;
  if (running || !eventId || !slate || !card || !boxRoot) return;
  if(freshnessIssue(slate,card,new Date(),health)) {showSlate();return;}
  const game = slate.games.find((item) => item.event_id === eventId);
  const base = rateGame(eventId);
  if (!game || !base) return;
  const overrides = editsFor(eventId);
  const rates = applyLineupOverrides(base, overrides);
  const label = button.textContent ?? 'Simulate';
  running = true;
  desk?.setAttribute('aria-busy','true');
  button.disabled = true;
  button.textContent = 'Simulating…';
  const progressStatus=document.createElement('span');progressStatus.setAttribute('role','status');progressStatus.textContent='Simulating…';button.after(progressStatus);
  const cancel=document.createElement('button');cancel.dataset.cancel='';cancel.textContent='Cancel';button.after(cancel);
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  try {
    const key=`${eventId}:${card.input_hash??card.generated_at}:${card.model_hash??card.model_version ?? 'legacy'}:${overridesKey(overrides)}`;
    const result = simulationCache.get(key) ?? await new Promise<Simulation>((resolve,reject)=>{
      const worker=new Worker(new URL('./simulation-worker.ts',import.meta.url),{type:'module'});
      activeWorker=worker;
      const finish=()=>{worker.terminate();activeWorker=null;cancelRun=null;};
      cancelRun=()=>{finish();reject(new Error('Simulation cancelled'));};
      worker.onmessage=(event:MessageEvent<{result?:Simulation;error?:string;progress?:number}>)=>{
        if(event.data.progress!==undefined){button.textContent=`Simulating… ${Math.round(event.data.progress*100)}%`;progressStatus.textContent=button.textContent;return;}
        finish();if(event.data.result)resolve(event.data.result);else reject(new Error(event.data.error??'Simulation failed'));
      };
      worker.onerror=()=>{finish();reject(new Error('Simulation worker failed'));};
      worker.postMessage({game:rates,seed:fnv1a(`${eventId}:${card!.generated_at ?? ''}`),iterations:ITERATIONS});
    });
    simulationCache.set(key,result);
    if(simulationCache.size>12)simulationCache.delete(simulationCache.keys().next().value!);
    upsideOn = false;
    view = { game, rates, result };
    panelAthlete = null;
    panelBody?.replaceChildren();
    paintScore();
    showScore();
    boxRoot.querySelector<HTMLButtonElement>('[data-back]')?.focus();
  } catch (error) {
    const status=document.createElement('p');status.setAttribute('role','alert');status.textContent=error instanceof Error?error.message:'Simulation failed. Retry.';
    button.after(status);
    button.disabled = false;
    button.textContent = label;
  } finally {
    desk?.setAttribute('aria-busy','false');
    progressStatus.remove();
    cancel.remove();
    running = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function showLineups(eventId: string, focusSelector?: string): void {
  if (!boxRoot || !slate) return;
  const game = slate.games.find((item) => item.event_id === eventId);
  const base = rateGame(eventId);
  if (!game || !base) return;
  cancelRun?.();
  lineupEvent = eventId;
  panelAthlete = null;
  panelBody?.replaceChildren();
  desk?.classList.remove('panel-open');
  boxRoot.innerHTML = renderLineupEditor(game, base, editsFor(eventId));
  const games = gamesFrame();
  if (games) games.hidden = true;
  if (stageFrame) stageFrame.hidden = false;
  if (playerFrame) playerFrame.hidden = true;
  if (desk) desk.dataset.mode = 'lineups';
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
    if (id && !running) showLineups(id);
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
  const simulateButton = target.closest('button[data-event]');
  if (simulateButton instanceof HTMLButtonElement) {
    if (simulateButton.disabled) return;
    void onSimulate(simulateButton);
    return;
  }
  if (target.closest('[data-back]')) {
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
  if (!view || !panelAthlete) return;
  const results = document.querySelector<HTMLElement>('[data-prop-results]');
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
  if (!(target instanceof Element) || !target.closest('[data-prop-form]')) return;
  readPropForm();
  if (target instanceof HTMLSelectElement && target.matches('[data-prop-style]')) {
    syncPanel();
    return;
  }
  paintPropResults();
}

function onProbabilityColors(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.matches('input[data-lineup-choice]')) {
    onLineupChoice(target);
    return;
  }
  if (target.matches('[data-upside-scenario]')) {
    upsideOn = target.checked;
    paintScore();
    syncPanel();
    return;
  }
  if (!target.matches('[data-probability-colors]')) return;
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
  if(event.target instanceof Element && event.target.matches('[role=tab]') && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();panelTab=event.key==='Home'?'forecast':event.key==='End'?'props':panelTab==='forecast'?'props':'forecast';syncPanel();document.getElementById(`${panelTab}-tab`)?.focus();return;
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
  desk.addEventListener('change', onProbabilityColors);
  desk.addEventListener('input', onPropEdit);
  desk.addEventListener('change', onPropEdit);
  desk.addEventListener('error', onImageError, true);
  document.addEventListener('keydown', onKey);
  applyProbabilityColors();
}

async function load(): Promise<void> {
  if (!slateRoot) return;
  try {
    const loaded=await loadGeneration(async name=>{
      const response=await fetch(`${DATA_BASE}${name}`,{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(response.status===404&&['manifest.json','health.json'].includes(name))return null;
      if(!response.ok)throw new Error('Data fetch failed');
      return response.text();
    },async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join(''));
    slate=loaded.slate;card=loaded.card;health=loaded.health;
    lineupEdits=readStoredLineups(storedLineups(),slate.games.map(g=>g.event_id));
    bind();
    showSlate();
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

applyTheme(themeFromStorage(storedTheme(), window.matchMedia('(prefers-color-scheme: light)').matches));
bindTheme();
void load();

function recheckFreshness(): void {
  paintFreshness();
  if(slate && card && freshnessIssue(slate,card,new Date(),health)){activeWorker?.terminate();cancelRun?.();showSlate();}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)recheckFreshness();});
setInterval(recheckFreshness,60000);
