import { formatTip } from './date.ts';
import { escapeHtml, statusLabel } from './slate.ts';
import type { SimulatedPlayer, SimulatedTeam, Simulation } from './simulate.ts';
import type { ColumnKey, SlateGame } from './types.ts';

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'min', label: 'MIN' },
  { key: 'fgm', label: 'FGM' },
  { key: 'fga', label: 'FGA' },
  { key: 'tpm', label: '3PM' },
  { key: 'tpa', label: '3PA' },
  { key: 'ftm', label: 'FTM' },
  { key: 'fta', label: 'FTA' },
  { key: 'pts', label: 'PTS' },
  { key: 'reb', label: 'REB' },
  { key: 'ast', label: 'AST' },
];

type Counting = Pick<SimulatedPlayer, ColumnKey>;

export function columnSums(players: Counting[]): Record<ColumnKey, number> {
  const sums: Record<ColumnKey, number> = {
    min: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
    pts: 0,
    reb: 0,
    ast: 0,
  };
  for (const player of players) {
    for (const column of COLUMNS) sums[column.key] += player[column.key];
  }
  return sums;
}

function byName(a: SimulatedPlayer, b: SimulatedPlayer): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.athlete_id < b.athlete_id) return -1;
  if (a.athlete_id > b.athlete_id) return 1;
  return 0;
}

function displayPlayers(players: SimulatedPlayer[]): SimulatedPlayer[] {
  const active = players.filter((player) => player.minutes_weight !== 0);
  const inactive = players.filter((player) => player.minutes_weight === 0);
  active.sort((a, b) => b.min - a.min || byName(a, b));
  inactive.sort(byName);
  return [...active, ...inactive];
}

function sampleText(player: SimulatedPlayer): string {
  const games = player.thin_sample ? `thin sample · ${player.games} games` : `${player.games} games`;
  if (player.shooting_games !== player.games) return `${games} · shooting sample ${player.shooting_games}`;
  return games;
}

function pointsCell(points: number, band: string): string {
  return `<td data-col="pts"><span class="pts">${points}</span><span class="band">${band}</span></td>`;
}

function playerRow(player: SimulatedPlayer): string {
  const cells = COLUMNS.map((column) => {
    if (column.key === 'pts') {
      const band =
        player.minutes_weight === 0
          ? escapeHtml(player.injury_status)
          : `${player.band.p10}–${player.band.p90}`;
      return pointsCell(player.pts, band);
    }
    return `<td data-col="${column.key}">${player[column.key]}</td>`;
  }).join('');
  return `<tr>
    <th scope="row">
      <span class="player-name">${escapeHtml(player.name)}</span>
      <span class="sample">${escapeHtml(sampleText(player))}</span>
    </th>
    ${cells}
  </tr>`;
}

function footerRow(side: string, team: SimulatedTeam): string {
  const sums = columnSums(team.players);
  const cells = COLUMNS.map((column) => {
    if (column.key === 'pts') return pointsCell(sums.pts, `${team.band.p10}–${team.band.p90}`);
    return `<td data-col="${column.key}">${sums[column.key]}</td>`;
  }).join('');
  return `<tr data-footer="${side}"><th scope="row">Total</th>${cells}</tr>`;
}

function teamBlock(side: string, name: string, team: SimulatedTeam): string {
  const head = COLUMNS.map((column) => `<th>${column.label}</th>`).join('');
  const rows = displayPlayers(team.players).map(playerRow).join('');
  return `<section class="team-block">
    <h3>${escapeHtml(name)}</h3>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Player</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>${footerRow(side, team)}</tfoot>
      </table>
    </div>
  </section>`;
}

export function renderBoxScore(game: SlateGame, score: Simulation, now: Date): string {
  const ot = score.overtime ? '<p class="ot-line"><span class="ot">OT</span> <span>265 minutes</span></p>' : '';
  return `<article class="score-card">
    <button type="button" data-back>Back to slate</button>
    <header class="score-head">
      <h2>${escapeHtml(game.away.name)} @ ${escapeHtml(game.home.name)}</h2>
      <p class="tip">${escapeHtml(formatTip(game.start_time))}</p>
      <p class="status">${escapeHtml(statusLabel(game, now))}</p>
      ${ot}
    </header>
    ${teamBlock('away', game.away.name, score.away)}
    ${teamBlock('home', game.home.name, score.home)}
    <p class="note">10,000 simulated games. This table is one of them. The range under points is the 10th to 90th percentile.</p>
    <p class="note">Minutes are a rotation draw, not a five-man lineup.</p>
  </article>`;
}
