import test from 'node:test';
import assert from 'node:assert/strict';
import { getCalendarWindow, normalizeCalendar, renderActivity } from './activity.mjs';

const TODAY = '2026-01-15';
const START = '2025-02-01';
const LEVELS = new Set([
  'NONE',
  'FIRST_QUARTILE',
  'SECOND_QUARTILE',
  'THIRD_QUARTILE',
  'FOURTH_QUARTILE',
]);

function datesBetween(start, end) {
  const dates = [];
  for (const date = new Date(`${start}T00:00:00Z`); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function fixture({ start = START, end = TODAY, count = (index) => index % 9 } = {}) {
  const days = datesBetween(start, end).map((date, index) => ({ date, contributionCount: count(index) }));
  const weeks = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push({ contributionDays: days.slice(index, index + 7) });
  }
  return { totalContributions: 999999, weeks };
}

function sourceDays(calendar) {
  return calendar.weeks.flatMap((week) => week.contributionDays);
}

function dayMarkers(svg) {
  return [...svg.matchAll(/<circle\b[^>]*>/g)].flatMap(([tag]) => {
    const date = /\bdata-date=(['"])(.*?)\1/.exec(tag)?.[2];
    if (date === undefined) return [];
    const count = /\bdata-count=(['"])(.*?)\1/.exec(tag)?.[2];
    assert.notEqual(count, undefined, `Day ${date} needs a data-count attribute`);
    return [{ date, count: Number(count) }];
  });
}

test('the calendar window covers twelve natural months across a year boundary', () => {
  const window = getCalendarWindow(TODAY);
  assert.equal(window.start, START);
  assert.equal(window.end, TODAY);
  assert.deepEqual(window.months.map(({ key }) => key), [
    '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
    '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01',
  ]);
  assert.deepEqual(window.months.map(({ days }) => days), [28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31, 31]);
  assert.equal(window.months[0].label, 'Feb 2025');
  assert.equal(window.months.at(-1).label, 'Jan 2026');
});

test('leap February includes the 29th and the window has 366 dates', () => {
  const today = '2024-02-29';
  const window = getCalendarWindow(today);
  assert.equal(window.start, '2023-03-01');
  assert.equal(window.end, today);
  assert.equal(window.months.length, 12);
  assert.deepEqual(window.months.at(-1), { key: '2024-02', label: 'Feb 2024', days: 29 });

  const calendar = normalizeCalendar(fixture({ start: '2023-03-01', end: today }), today);
  assert.equal(calendar.days.length, 366);
  assert.equal(calendar.days.at(-1).date, today);
});

test('normalization accepts direct, user, and GraphQL data envelope shapes', async (t) => {
  const wrappers = {
    direct: (calendar) => calendar,
    user: (calendar) => ({ user: { contributionsCollection: { contributionCalendar: calendar } } }),
    data: (calendar) => ({ data: { user: { contributionsCollection: { contributionCalendar: calendar } } } }),
  };
  for (const [name, wrap] of Object.entries(wrappers)) {
    await t.test(name, () => {
      const input = fixture();
      const result = normalizeCalendar(wrap(input), TODAY);
      assert.equal(result.start, START);
      assert.equal(result.end, TODAY);
      assert.deepEqual(result.days.map(({ date }) => date), datesBetween(START, TODAY));
      assert.equal(result.months.length, 12);
    });
  }
});

test('normalization filters upstream padding, sorts dates, and computes totals from the window', () => {
  const input = fixture({ start: '2025-01-31', end: '2026-01-16' });
  const expectedDays = sourceDays(input).filter(({ date }) => date >= START && date <= TODAY);
  const expectedTotal = expectedDays.reduce((total, day) => total + day.contributionCount, 0);
  const expectedActive = expectedDays.filter(({ contributionCount }) => contributionCount > 0).length;
  input.weeks.reverse();
  for (const week of input.weeks) week.contributionDays.reverse();

  const result = normalizeCalendar(input, TODAY);
  assert.deepEqual(result.days.map(({ date }) => date), datesBetween(START, TODAY));
  assert.equal(result.totalContributions, expectedTotal);
  assert.equal(result.activeDays, expectedActive);
  assert.notEqual(result.totalContributions, input.totalContributions);
  assert.ok(result.days.some(({ contributionCount }) => contributionCount === 0));
  assert.ok(result.days.every(({ date }) => date <= TODAY));
});

test('an all-zero year keeps every date and reports no active days', () => {
  const result = normalizeCalendar(fixture({ count: () => 0 }), TODAY);
  assert.equal(result.days.length, datesBetween(START, TODAY).length);
  assert.equal(result.totalContributions, 0);
  assert.equal(result.activeDays, 0);
  assert.ok(result.days.every(({ contributionCount, contributionLevel }) => contributionCount === 0 && contributionLevel === 'NONE'));
});

test('missing contribution levels are derived and explicit GitHub levels are retained', () => {
  const input = fixture();
  const explicit = sourceDays(input)[1];
  explicit.contributionLevel = 'FOURTH_QUARTILE';
  const result = normalizeCalendar(input, TODAY);
  assert.ok(result.days.every(({ contributionLevel }) => LEVELS.has(contributionLevel)));
  assert.ok(result.days.filter(({ contributionCount }) => contributionCount > 0).every(({ contributionLevel }) => contributionLevel !== 'NONE'));
  assert.equal(result.days.find(({ date }) => date === explicit.date).contributionLevel, 'FOURTH_QUARTILE');
});

test('a missing date or duplicate date in the selected window is rejected', async (t) => {
  await t.test('missing date', () => {
    const input = fixture();
    input.weeks[0].contributionDays.splice(3, 1);
    assert.throws(() => normalizeCalendar(input, TODAY));
  });
  await t.test('duplicate date', () => {
    const input = fixture();
    input.weeks[0].contributionDays.push({ ...input.weeks[0].contributionDays[0] });
    assert.throws(() => normalizeCalendar(input, TODAY));
  });
});

test('malformed, impossible, and SVG-injection date values are rejected', async (t) => {
  for (const date of ['2025-02-29', '2026-13-01', '2026-01-32', '2025-2-01', '2025-02-01T00:00:00Z', '2025-02-01" onload="alert(1)', null]) {
    await t.test(String(date), () => {
      const input = fixture();
      input.weeks[0].contributionDays.push({ date, contributionCount: 1 });
      assert.throws(() => normalizeCalendar(input, TODAY));
    });
  }
});

test('contribution counts must be finite nonnegative integers', async (t) => {
  for (const count of [-1, 0.5, '1', null, undefined, NaN, Infinity]) {
    await t.test(String(count), () => {
      const input = fixture();
      input.weeks[0].contributionDays[0].contributionCount = count;
      assert.throws(() => normalizeCalendar(input, TODAY));
    });
  }
});

test('missing calendar data, malformed weeks, and GraphQL errors are rejected', async (t) => {
  const cases = [
    null,
    {},
    { weeks: null },
    { weeks: {} },
    { weeks: [{ contributionDays: null }] },
    { user: null },
    { data: { user: { contributionsCollection: {} } } },
    { errors: [{ message: 'Rate limit exceeded' }] },
    { data: { user: { contributionsCollection: { contributionCalendar: fixture() } } }, errors: [{ message: 'Partial response' }] },
  ];
  for (const [index, input] of cases.entries()) {
    await t.test(`invalid payload ${index + 1}`, () => assert.throws(() => normalizeCalendar(input, TODAY)));
  }
});

test('each SVG theme renders every date exactly once with its contribution count', async (t) => {
  const calendar = normalizeCalendar(fixture(), TODAY);
  for (const [theme, compact] of [['light', false], ['dark', false], ['light', true], ['dark', true]]) {
    await t.test(`${theme}${compact ? ' mobile' : ''}`, () => {
      const svg = renderActivity(calendar, { theme, compact });
      assert.equal(typeof svg, 'string');
      assert.match(svg, /<svg\b[^>]*xmlns=['"]http:\/\/www\.w3\.org\/2000\/svg['"]/);
      assert.match(svg, /<\/svg>\s*$/);
      const markers = dayMarkers(svg);
      assert.equal(markers.length, calendar.days.length);
      assert.equal(new Set(markers.map(({ date }) => date)).size, calendar.days.length);
      const actual = new Map(markers.map(({ date, count }) => [date, count]));
      for (const { date, contributionCount } of calendar.days) {
        assert.equal(actual.get(date), contributionCount, `Incorrect marker for ${date}`);
      }
      assert.ok(!actual.has('2026-01-16'), 'Future days must not be rendered');
    });
  }
});
