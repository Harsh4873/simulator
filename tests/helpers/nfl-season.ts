import type { NflBoxGame, NflLine } from '../../src/nfl/boxscore.ts';
import { mulberry32 } from '../../src/rng.ts';

export function line(id: string, name: string, patch: Partial<NflLine>): NflLine {
  return { id, name, pass_cmp: 0, pass_att: 0, pass_yds: 0, pass_td: 0, int: 0, car: 0, rush_yds: 0, rush_td: 0, tgt: 0, rec: 0, rec_yds: 0, rec_td: 0, ...patch };
}

/** A season of synthetic games among four teams, each with a passer, two backs and three receivers. */
export function season(weeks: number, seed = 3): NflBoxGame[] {
  const rng = mulberry32(seed);
  const teams = ['AAA', 'BBB', 'CCC', 'DDD'];
  const strength: Record<string, number> = { AAA: 6, BBB: 2, CCC: -2, DDD: -6 };
  const games: NflBoxGame[] = [];
  const side = (abbr: string, points: number) => {
    const att = 30 + Math.round(rng() * 8);
    const car = 24 + Math.round(rng() * 6);
    const shares = [0.32, 0.26, 0.18];
    const receivers = shares.map((share, index) => {
      const tgt = Math.round(att * share);
      const rec = Math.round(tgt * 0.66);
      return line(`${abbr}-wr${index}`, `${abbr} Receiver ${index}`, { tgt, rec, rec_yds: rec * 12, rec_td: rng() < 0.3 ? 1 : 0 });
    });
    const yards = receivers.reduce((sum, item) => sum + item.rec_yds, 0);
    return {
      id: abbr,
      abbr,
      points,
      drives: 11,
      pass_att: att,
      rush_att: car,
      pass_yds: yards,
      rush_yds: car * 4,
      fg: 2,
      players: [
        line(`${abbr}-qb`, `${abbr} Passer`, { pass_att: att, pass_cmp: receivers.reduce((sum, item) => sum + item.rec, 0), pass_yds: yards, pass_td: 1, int: 1, car: 3, rush_yds: 12 }),
        line(`${abbr}-rb1`, `${abbr} Back 1`, { car: Math.round(car * 0.65), rush_yds: Math.round(car * 0.65) * 4, rush_td: rng() < 0.4 ? 1 : 0, tgt: 3, rec: 2, rec_yds: 14 }),
        line(`${abbr}-rb2`, `${abbr} Back 2`, { car: Math.round(car * 0.25), rush_yds: Math.round(car * 0.25) * 4 }),
        ...receivers,
      ],
    };
  };
  for (let week = 1; week <= weeks; week += 1) {
    for (const [home, away] of [[teams[(week) % 4]!, teams[(week + 1) % 4]!], [teams[(week + 2) % 4]!, teams[(week + 3) % 4]!]]) {
      const homePoints = Math.max(0, Math.round(22 + strength[home]! - strength[away]! / 2 + 2 + (rng() - 0.5) * 20));
      const awayPoints = Math.max(0, Math.round(22 + strength[away]! - strength[home]! / 2 + (rng() - 0.5) * 20));
      games.push({ id: `${week}${home}${away}`, start_time: new Date(Date.UTC(2026, 8, 7 + week * 7)).toISOString(), season: 2026, season_type: 2, week, neutral: false, home: side(home, homePoints), away: side(away, awayPoints) });
    }
  }
  return games;
}
