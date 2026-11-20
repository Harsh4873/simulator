/** Earlier games required before a counting-stat mean is shown. */
export const MIN_GAMES = 8;

export const OPENDOTA_API = 'https://api.opendota.com/api';
export const LEAGUEPEDIA_API = 'https://lol.fandom.com/api.php';
export const BO3_API = 'https://api.bo3.gg/api/v1';

/** Identifying agent. Requests send no browser user agent, origin, or referer. */
export const ESPORTS_USER_AGENT = 'harsh.bet-simulator/1.0 (github.com/Harsh4873/simulator; esports reader)';

export const DOTA_STATS = ['kills', 'deaths', 'assists'] as const;
export const LOL_STATS = ['kills', 'deaths', 'assists', 'cs'] as const;
export const CS2_STATS = ['kills', 'headshots', 'deaths', 'assists'] as const;
