import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 86_400_000;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LEVELS = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE'];

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Dates must use YYYY-MM-DD.');
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return timestamp;
}

function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function getCalendarWindow(today = new Date().toISOString().slice(0, 10)) {
  const timestamp = parseDate(today);
  const now = new Date(timestamp);
  const months = Array.from({ length: 12 }, (_, index) => {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + index, 1));
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    return {
      key: first.toISOString().slice(0, 7),
      label: `${MONTH_NAMES[month]} ${year}`,
      days: new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
    };
  });
  return { start: `${months[0].key}-01`, end: today, months };
}

function extractCalendar(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Missing contribution calendar.');
  }
  if (Array.isArray(input.errors) && input.errors.length) {
    throw new Error('GitHub returned GraphQL errors; the existing images were retained.');
  }
  const root = input.data ?? input;
  const calendar = root.user?.contributionsCollection?.contributionCalendar
    ?? root.contributionsCollection?.contributionCalendar
    ?? root.contributionCalendar
    ?? (Array.isArray(root.weeks) ? root : null);
  if (!calendar || !Array.isArray(calendar.weeks)) {
    throw new Error('Missing contribution calendar weeks.');
  }
  return calendar;
}

export function normalizeCalendar(input, today = new Date().toISOString().slice(0, 10)) {
  const window = getCalendarWindow(today);
  const calendar = extractCalendar(input);
  const byDate = new Map();
  for (const week of calendar.weeks) {
    if (!week || !Array.isArray(week.contributionDays)) {
      throw new Error('A contribution week is missing its days.');
    }
    for (const day of week.contributionDays) {
      if (!day || typeof day !== 'object') throw new Error('Invalid contribution day.');
      parseDate(day.date);
      if (!Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0) {
        throw new Error(`Invalid contribution count for ${day.date}.`);
      }
      if (day.contributionLevel !== undefined && !LEVELS.includes(day.contributionLevel)) {
        throw new Error(`Invalid contribution level for ${day.date}.`);
      }
      if (day.contributionLevel === 'NONE' && day.contributionCount > 0) {
        throw new Error(`Inconsistent contribution level for ${day.date}.`);
      }
      if (day.contributionCount === 0 && day.contributionLevel && day.contributionLevel !== 'NONE') {
        throw new Error(`Inconsistent contribution level for ${day.date}.`);
      }
      if (day.date < window.start || day.date > window.end) continue;
      if (byDate.has(day.date)) throw new Error(`Duplicate contribution day: ${day.date}.`);
      byDate.set(day.date, { ...day });
    }
  }

  const days = [];
  for (let date = parseDate(window.start); date <= parseDate(window.end); date += DAY_MS) {
    const key = isoDate(date);
    const day = byDate.get(key);
    if (!day) throw new Error(`Missing contribution data for ${key}; refusing to invent a zero.`);
    days.push(day);
  }
  const peak = Math.max(1, ...days.map(day => day.contributionCount));
  const normalized = days.map(day => ({
    date: day.date,
    contributionCount: day.contributionCount,
    contributionLevel: day.contributionLevel ?? LEVELS[day.contributionCount === 0 ? 0 : Math.min(4, Math.ceil(day.contributionCount / peak * 4))],
  }));
  return {
    ...window,
    days: normalized,
    totalContributions: normalized.reduce((sum, day) => sum + day.contributionCount, 0),
    activeDays: normalized.filter(day => day.contributionCount > 0).length,
  };
}

function xml(value) {
  return String(value).replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]));
}

function niceDate(value) {
  const date = new Date(parseDate(value));
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

const PALETTES = {
  light: {
    background: '#F5F8FC', ink: '#152B46', muted: '#50647D', track: '#DFE7F2',
    stars: ['#CFD9E7', '#92B4DC', '#548BD2', '#376DC9', '#A77532'],
    planet: '#D8B28A', band: '#B8865C', cream: '#EFE0C9', spot: '#AC694D',
  },
  dark: {
    background: '#101E34', ink: '#ECF2FA', muted: '#B1C0D5', track: '#263A54',
    stars: ['#344963', '#4F75A7', '#709FD9', '#8BB8FF', '#E4C49C'],
    planet: '#D8B28A', band: '#A97856', cream: '#F0DFC6', spot: '#AF6C50',
  },
};

function point(radius, angle) {
  const radians = angle * Math.PI / 180;
  return { x: 866 + radius * Math.cos(radians), y: 310 + radius * Math.sin(radians) };
}

function orbit(radius, color) {
  const start = point(radius, -60);
  const end = point(radius, 240);
  return `<path d="M${start.x.toFixed(2)} ${start.y.toFixed(2)} A${radius} ${radius} 0 1 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}" fill="none" stroke="${color}" stroke-width="1"/>`;
}

export function renderActivity(calendar, { theme = 'light', compact = false } = {}) {
  const colors = PALETTES[theme];
  if (!colors) throw new Error('Theme must be light or dark.');
  if (!calendar || !Array.isArray(calendar.days) || calendar.months?.length !== 12) {
    throw new Error('Render requires a normalized 12-month calendar.');
  }
  const title = `Jupiter's contribution orbits, ${niceDate(calendar.start)} to ${niceDate(calendar.end)}`;
  const description = `${calendar.totalContributions} contributions across ${calendar.activeDays} active days. Each orbit is one month, oldest inside and newest outside. One star represents one day; brighter and larger stars represent more contributions. Days run clockwise from the upper right. Future days are not drawn.`;
  const monthIndex = new Map(calendar.months.map((month, index) => [month.key, index]));
  const rings = calendar.months.map((month, index) => {
    const radius = 90 + index * 16;
    return `${orbit(radius, colors.track)}\n<text x="866" y="${314 - radius}" text-anchor="middle" font-size="${compact ? 16 : 13}" fill="${colors.muted}">${xml(month.label)}</text>`;
  }).join('\n');
  const stars = calendar.days.map(day => {
    const level = LEVELS.indexOf(day.contributionLevel);
    const radius = 90 + monthIndex.get(day.date.slice(0, 7)) * 16;
    const dateNumber = Number(day.date.slice(-2));
    const position = point(radius, -60 + (dateNumber - 0.5) * 300 / 31);
    const size = [1.7, 2.5, 3.2, 3.9, 4.7][level];
    return `<circle data-date="${day.date}" data-count="${day.contributionCount}" data-level="${level}" cx="${position.x.toFixed(2)}" cy="${position.y.toFixed(2)}" r="${size}" fill="${colors.stars[level]}"><title>${day.date}: ${day.contributionCount} contribution${day.contributionCount === 1 ? '' : 's'}</title></circle>`;
  }).join('\n');
  const legend = colors.stars.map((color, index) => `<circle cx="${(compact ? 50 : 64) + index * 30}" cy="${compact ? 919 : 433}" r="${[2.3, 3.1, 3.8, 4.5, 5.3][index]}" fill="${color}"/>`).join('');
  const information = compact ? `
<text x="44" y="64" font-size="38" font-weight="650">A year in orbit</text>
<text x="44" y="100" font-size="20" fill="${colors.muted}">My contribution calendar</text>
<text x="44" y="174" font-size="56" font-weight="650">${calendar.totalContributions.toLocaleString('en-US')}</text>
<text x="44" y="207" font-size="20" fill="${colors.muted}">contributions</text>
<text x="394" y="171" font-size="30" font-weight="600">${calendar.activeDays} active days</text>
<text x="44" y="253" font-size="20" fill="${colors.muted}">${xml(niceDate(calendar.start))} – ${xml(niceDate(calendar.end))}</text>
<text x="44" y="887" font-size="20" font-weight="600">One star, one day</text>
${legend}
<text x="211" y="926" font-size="18" fill="${colors.muted}">Less to more contributions</text>
<text x="44" y="967" font-size="18" fill="${colors.muted}">Oldest month inside. Days move clockwise.</text>` : `
<text x="52" y="83" font-size="36" font-weight="650">A year in orbit</text>
<text x="52" y="117" font-size="18" fill="${colors.muted}">My contribution calendar</text>
<text x="52" y="199" font-size="54" font-weight="650">${calendar.totalContributions.toLocaleString('en-US')}</text>
<text x="52" y="230" font-size="19" fill="${colors.muted}">contributions</text>
<text x="52" y="278" font-size="24" font-weight="600">${calendar.activeDays} active days</text>
<text x="52" y="313" font-size="16" fill="${colors.muted}">${xml(niceDate(calendar.start))} – ${xml(niceDate(calendar.end))}</text>
<text x="52" y="378" font-size="18" font-weight="600">One star, one day</text>
<text x="52" y="406" font-size="16" fill="${colors.muted}">Brighter stars mean more contributions.</text>
${legend}
<text x="52" y="466" font-size="14" fill="${colors.muted}">Less</text><text x="178" y="466" font-size="14" fill="${colors.muted}">More</text>
<text x="52" y="519" font-size="15" fill="${colors.muted}">Inner orbit: ${xml(calendar.months[0].label)}</text>
<text x="52" y="545" font-size="15" fill="${colors.muted}">Outer orbit: ${xml(calendar.months[11].label)}</text>
<text x="52" y="579" font-size="14" fill="${colors.muted}">Days move clockwise from the upper right.</text>`;
  const width = compact ? 720 : 1200;
  const height = compact ? 1000 : 620;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
<title id="title">${xml(title)}</title>
<desc id="desc">${xml(description)}</desc>
<defs><clipPath id="planet"><circle cx="866" cy="310" r="49"/></clipPath></defs>
<rect width="${width}" height="${height}" rx="16" fill="${colors.background}"/>
<g font-family="'Segoe UI', Arial, sans-serif" fill="${colors.ink}">
${information}
<g${compact ? ' transform="translate(-506 250)"' : ''}>
${rings}
${stars}
<g clip-path="url(#planet)">
<circle cx="866" cy="310" r="49" fill="${colors.planet}"/>
<path d="M811 276 Q858 287 922 277 L922 287 Q860 298 811 287Z M811 310 Q862 297 922 309 L922 322 Q864 315 811 325Z M811 343 Q863 332 922 344 L922 354 Q862 347 811 356Z" fill="${colors.band}"/>
<path d="M811 294 Q864 303 922 292 L922 300 Q862 309 811 304Z M811 329 Q867 319 922 330 L922 336 Q864 329 811 336Z" fill="${colors.cream}"/>
<ellipse cx="882" cy="323" rx="13" ry="7" fill="${colors.spot}"/>
<path d="M884 257 Q944 312 883 362 Q925 350 925 311 Q925 273 884 257Z" fill="${colors.background}" opacity=".16"/>
</g>
<circle cx="866" cy="310" r="49" fill="none" stroke="${colors.planet}" stroke-width="1"/>
</g>
</g>
</svg>
`;
}

export async function fetchCalendar(login, today = new Date().toISOString().slice(0, 10), token = process.env.GH_TOKEN) {
  if (typeof login !== 'string' || !/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/.test(login)) {
    throw new Error('A valid GitHub login is required.');
  }
  if (!token) throw new Error('GH_TOKEN is required for GitHub GraphQL.');
  const window = getCalendarWindow(today);
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'Jupiter363-profile-activity' },
    body: JSON.stringify({
      query: 'query ContributionOrbits($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) { contributionsCollection(from: $from, to: $to) { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount contributionLevel } } } } } }',
      variables: { login, from: `${window.start}T00:00:00Z`, to: `${window.end}T23:59:59Z` },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub contribution request failed (HTTP ${response.status}).`);
  return normalizeCalendar(await response.json(), today);
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--input', '--fetch', '--output-dir', '--today'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || options[name]) {
      throw new Error('Usage: node scripts/activity.mjs (--input calendar.json | --fetch LOGIN) [--output-dir assets] [--today YYYY-MM-DD]');
    }
    options[name] = args[index + 1];
  }
  if (Boolean(options['--input']) === Boolean(options['--fetch'])) {
    throw new Error('Provide exactly one of --input or --fetch.');
  }
  const today = options['--today'] ?? new Date().toISOString().slice(0, 10);
  const calendar = options['--fetch']
    ? await fetchCalendar(options['--fetch'], today)
    : normalizeCalendar(JSON.parse(await readFile(options['--input'], 'utf8')), today);
  const images = ['light', 'dark'].flatMap(theme => [false, true].map(compact => ({
    name: `activity-${theme}${compact ? '-mobile' : ''}.svg`,
    svg: renderActivity(calendar, { theme, compact }),
  })));
  const directory = path.resolve(options['--output-dir'] ?? 'assets');
  await mkdir(directory, { recursive: true });
  const temporaryPaths = [];
  try {
    for (const image of images) {
      image.destination = path.join(directory, image.name);
      image.temporary = `${image.destination}.${process.pid}.tmp`;
      temporaryPaths.push(image.temporary);
      await writeFile(image.temporary, image.svg, 'utf8');
    }
    for (const image of images) await rename(image.temporary, image.destination);
  } finally {
    await Promise.all(temporaryPaths.map(filename => rm(filename, { force: true })));
  }
  console.log(`Updated contribution orbits: ${calendar.totalContributions} contributions, ${calendar.activeDays} active days, ${calendar.start} through ${calendar.end}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Contribution image update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
