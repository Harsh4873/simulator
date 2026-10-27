import './styles.css';
import { renderBoxScore } from './boxscore.ts';
import { fnv1a } from './rng.ts';
import { renderSlate } from './slate.ts';
import { ITERATIONS, simulate } from './simulate.ts';
import type { RateCard, RateGame, Slate, SlateGame } from './types.ts';

const DATA_BASE = '/simulator/data/';

const slateRoot = document.querySelector<HTMLElement>('#slate');
const boxRoot = document.querySelector<HTMLElement>('#boxscore');

let slate: Slate | null = null;
let card: RateCard | null = null;
let bound = false;

function rateGame(eventId: string): RateGame | null {
  return card?.games.find((game) => game.event_id === eventId) ?? null;
}

function showSlate(): void {
  if (!slateRoot || !boxRoot || !slate || !card) return;
  slateRoot.hidden = false;
  boxRoot.hidden = true;
  boxRoot.replaceChildren();
  slateRoot.innerHTML = renderSlate(slate, card, new Date());
}

async function onSimulate(button: HTMLButtonElement): Promise<void> {
  const eventId = button.dataset.event;
  if (!eventId || !slate || !card || !slateRoot || !boxRoot) return;
  const game = slate.games.find((item) => item.event_id === eventId);
  const rates = rateGame(eventId);
  if (!game || !rates) return;
  button.disabled = true;
  button.textContent = 'Simulating…';
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  try {
    const result = simulate(rates, fnv1a(`${eventId}:${card.generated_at ?? ''}`), ITERATIONS);
    paintBox(game, result);
  } catch {
    button.disabled = false;
    button.textContent = 'Simulate';
  }
}

function paintBox(game: SlateGame, result: ReturnType<typeof simulate>): void {
  if (!slateRoot || !boxRoot) return;
  slateRoot.hidden = true;
  boxRoot.hidden = false;
  boxRoot.innerHTML = renderBoxScore(game, result, new Date());
  boxRoot.querySelector<HTMLButtonElement>('[data-back]')?.addEventListener('click', () => {
    showSlate();
  });
}

function bind(): void {
  if (bound || !slateRoot) return;
  bound = true;
  slateRoot.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !target.dataset.event || target.disabled) return;
    void onSimulate(target);
  });
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
  }
}

void load();
