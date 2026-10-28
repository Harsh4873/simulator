import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { winCounts, type WinCounts } from '../src/display.ts';
import { legacyDrawGame } from '../src/legacy.ts';
import { fnv1a, iterationSeed, mulberry32, type Rng } from '../src/rng.ts';
import { drawGame, quantile } from '../src/simulate.ts';
import type { RateCard, RateGame, RatePlayer } from '../src/types.ts';
import type { Slate } from '../src/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRAWS = 1000;
const EXPECTED_WINS: Record<string, WinCounts> = {
  '401909877': { away: 609, tie: 18, home: 373 },
  '401909878': { away: 446, tie: 13, home: 541 },
  '401909879': { away: 353, tie: 16, home: 631 },
  '401909880': { away: 410, tie: 20, home: 570 },
};

interface WatchedPlayer {
  label: string;
  test: (name: string) => boolean;
}

const WATCHED: WatchedPlayer[] = [
  { label: 'Moritz Wagner', test: (name) => name === 'Moritz Wagner' },
  { label: 'Chris Cenac Jr.', test: (name) => name.includes('Cenac') },
  { label: 'Jayson Tatum', test: (name) => name === 'Jayson Tatum' },
  {
    label: 'Nolan Traoré',
    test: (name) => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().includes('traore'),
  },
  { label: 'Karl-Anthony Towns', test: (name) => name === 'Karl-Anthony Towns' },
];

interface TeamRow {
  eventId: string;
  label: string;
  model: 'Legacy' | 'Revised';
  awayMean: number;
  awayMedian: number;
  homeMean: number;
  homeMedian: number;
  wins: WinCounts;
}

interface PlayerRow {
  label: string;
  eventId: string;
  model: 'Legacy' | 'Revised';
  minutes: number;
  points: number;
  zeroShare: number;
  missing: boolean;
}

type Sampler = (game: RateGame, rng: Rng) => {
  away: { athlete_id: string; min: number; pts: number }[];
  home: { athlete_id: string; min: number; pts: number }[];
};

function baseSeed(eventId: string, generatedAt: string): number {
  return fnv1a(`${eventId}:${generatedAt}`) >>> 0;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  return quantile(values.slice().sort((a, b) => a - b), 0.5);
}

function sample(game: RateGame, generatedAt: string, sampler: Sampler, players: RatePlayer[]): {
  team: Omit<TeamRow, 'label' | 'model'>;
  players: Omit<PlayerRow, 'eventId' | 'model'>[];
} {
  const seed = baseSeed(game.event_id, generatedAt);
  const away: number[] = [];
  const home: number[] = [];
  const watched = players
    .map((player) => {
      const spec = WATCHED.find((item) => item.test(player.name));
      return spec ? { spec, player } : null;
    })
    .filter((item): item is { spec: WatchedPlayer; player: RatePlayer } => item !== null);
  const buckets = watched.map(() => ({ minutes: 0, points: 0, zeros: 0 }));
  for (let index = 0; index < DRAWS; index += 1) {
    const draw = sampler(game, mulberry32(iterationSeed(seed, index)));
    const awayPts = draw.away.reduce((sum, line) => sum + line.pts, 0);
    const homePts = draw.home.reduce((sum, line) => sum + line.pts, 0);
    away.push(awayPts);
    home.push(homePts);
    const lines = [...draw.away, ...draw.home];
    watched.forEach((item, slot) => {
      const line = lines.find((entry) => entry.athlete_id === item.player.athlete_id);
      const minutes = line?.min ?? 0;
      buckets[slot].minutes += minutes;
      buckets[slot].points += line?.pts ?? 0;
      if (minutes === 0) buckets[slot].zeros += 1;
    });
  }
  return {
    team: {
      eventId: game.event_id,
      awayMean: mean(away),
      awayMedian: median(away),
      homeMean: mean(home),
      homeMedian: median(home),
      wins: winCounts(away, home),
    },
    players: watched.map((item, slot) => ({
      label: item.spec.label,
      minutes: buckets[slot].minutes / DRAWS,
      points: buckets[slot].points / DRAWS,
      zeroShare: buckets[slot].zeros / DRAWS,
      missing: item.player.shooting_games === 0,
    })),
  };
}

function gameLabel(slate: Slate, eventId: string): string {
  const game = slate.games.find((item) => item.event_id === eventId);
  if (!game) return eventId;
  return `${eventId} ${game.away.name} at ${game.home.name}`;
}

function num(value: number): string {
  return value.toFixed(2);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function teamTable(rows: TeamRow[]): string {
  const header = '| Game | Model | Away mean | Away median | Home mean | Home median | Away wins | Ties | Home wins |';
  const rule = '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const body = rows.map((row) =>
    `| ${row.label} | ${row.model} | ${num(row.awayMean)} | ${row.awayMedian} | ${num(row.homeMean)} | ${row.homeMedian} | ${row.wins.away} | ${row.wins.tie} | ${row.wins.home} |`,
  );
  return [header, rule, ...body].join('\n');
}

function playerTable(rows: PlayerRow[], labels: Map<string, string>): string {
  const header = '| Player | Game | Model | Expected minutes | Expected points | Share at 0 minutes | Missing shooting |';
  const rule = '| --- | --- | --- | ---: | ---: | ---: | --- |';
  const body = rows.map((row) =>
    `| ${row.label} | ${labels.get(row.eventId) ?? row.eventId} | ${row.model} | ${num(row.minutes)} | ${num(row.points)} | ${pct(row.zeroShare)} | ${row.missing ? 'yes' : 'no'} |`,
  );
  return [header, rule, ...body].join('\n');
}

function main(): void {
  const card = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/rate-card-2026-10-27.json'), 'utf8')) as RateCard;
  const slate = JSON.parse(readFileSync(join(ROOT, 'public/data/slate.json'), 'utf8')) as Slate;
  assert.equal(card.generated_at, '2026-10-27T21:31:55Z');
  const generatedAt = card.generated_at ?? '';
  const labels = new Map(card.games.map((game) => [game.event_id, gameLabel(slate, game.event_id)]));
  const legacyTeams: TeamRow[] = [];
  const legacyPlayers: PlayerRow[] = [];
  for (const game of card.games) {
    const sampled = sample(game, generatedAt, legacyDrawGame, game.players);
    const expected = EXPECTED_WINS[game.event_id];
    assert.ok(expected, game.event_id);
    assert.deepEqual(sampled.team.wins, expected, `${game.event_id} legacy wins ${JSON.stringify(sampled.team.wins)}`);
    legacyTeams.push({ ...sampled.team, label: labels.get(game.event_id) ?? game.event_id, model: 'Legacy' });
    for (const player of sampled.players) {
      legacyPlayers.push({ ...player, eventId: game.event_id, model: 'Legacy' });
    }
  }

  const revisedTeams: TeamRow[] = [];
  const revisedPlayers: PlayerRow[] = [];
  for (const game of card.games) {
    const sampled = sample(game, generatedAt, drawGame, game.players);
    revisedTeams.push({ ...sampled.team, label: labels.get(game.event_id) ?? game.event_id, model: 'Revised' });
    for (const player of sampled.players) {
      revisedPlayers.push({ ...player, eventId: game.event_id, model: 'Revised' });
    }
  }

  const teams = card.games.flatMap((game) => {
    const legacy = legacyTeams.find((row) => row.eventId === game.event_id);
    const revised = revisedTeams.find((row) => row.eventId === game.event_id);
    assert.ok(legacy && revised);
    return [legacy, revised];
  });
  const playerOrder = WATCHED.map((item) => item.label);
  const players = playerOrder.flatMap((label) => {
    const legacy = legacyPlayers.find((row) => row.label === label);
    const revised = revisedPlayers.find((row) => row.label === label);
    assert.ok(legacy && revised, label);
    return [legacy, revised];
  });

  const markdown = `# Model audit before and after

The frozen rate card is \`tests/fixtures/rate-card-2026-10-27.json\` (\`generated_at\` ${card.generated_at}). Each row is ${DRAWS.toLocaleString('en-US')} paired draws. Legacy and revised use the same seed, \`iterationSeed(fnv1a(event id + ":" + generated_at), index)\`.

Market odds were not an input. The sampler does not read a spread, a price, or a side the card should beat. A Nets result above a Celtics result is a legal draw.

## Team scores

${teamTable(teams)}

## Players

Shot rates on the frozen card were not rewritten. Missing shooting means \`shooting_games === 0\`, which the sampler treats as missing even when the card has no \`missing_shooting\` field.

${playerTable(players, labels)}

## What moved

Unobserved players leave the 240-minute pool. A player with no shooting games and fewer than 3 games draws one uniform and plays only when it is below 0.2. The minutes they used to absorb go to teammates who are playing. Chris Cenac Jr. is that profile: expected minutes are about 0.2 times a draw under a 12-minute cap, so the mean stays under 5 and most draws are 0. Players with a shooting sample, including Moritz Wagner, keep the shrunk shot rates already on the card and stay in the minutes draw. Overtime is not a coin. Both teams are drawn at 240 first. Extra 25-minute periods are added only when the regulation totals tie, on the same participants and the same team shock. A returned game has different final scores.

Team totals and win counts move because those minute and overtime rules change who is on the floor. The table is that reallocation.
`;
  writeFileSync(join(ROOT, 'MODEL_AUDIT_BEFORE_AFTER.md'), markdown);
  process.stdout.write(`wrote MODEL_AUDIT_BEFORE_AFTER.md\n`);
}

main();
