import { describe, it, expect } from 'vitest';
import { localDayKey, localDayKeysInRange, getUtcDayBoundary } from './tz.js';

describe('tz — localDayKey / localDayKeysInRange', () => {
  it('localDayKey matches naive UTC slicing for a UTC user', () => {
    const instant = new Date('2021-06-15T14:30:00.000Z');
    expect(localDayKey(instant, 'UTC')).toBe('2021-06-15');
  });

  it('localDayKey uses the local calendar day, not the UTC one, near local midnight', () => {
    // 2021-06-01T23:00:00Z is 2021-06-01T15:00 local in America/Los_Angeles
    // (UTC-8 in June... actually UTC-7 with DST) — still the same UTC day.
    // Use a zone far enough from UTC that the day genuinely flips.
    const instant = new Date('2021-06-01T20:00:00.000Z'); // late UTC evening
    // Pacific/Kiritimati is UTC+14 — this instant is 2021-06-02T10:00 local.
    expect(localDayKey(instant, 'Pacific/Kiritimati')).toBe('2021-06-02');
    // Naive UTC slicing would have said '2021-06-01' — genuinely different.
    expect(instant.toISOString().slice(0, 10)).toBe('2021-06-01');
  });

  it('localDayKeysInRange returns exactly the local days spanned by a UTC-day-boundary window', () => {
    // 2021-06-02T12:00:00Z is 2021-06-03T02:00 local in Pacific/Kiritimati (UTC+14).
    const { dayStart, dayEnd } = getUtcDayBoundary('Pacific/Kiritimati', new Date('2021-06-02T12:00:00.000Z'));
    const keys = localDayKeysInRange(dayStart, dayEnd, 'Pacific/Kiritimati');
    expect(keys).toEqual(['2021-06-03']);
  });

  it('localDayKeysInRange spans multiple days correctly for a multi-day window', () => {
    const keys = localDayKeysInRange(
      new Date('2021-06-01T00:00:00.000Z'),
      new Date('2021-06-04T20:00:00.000Z'),
      'UTC',
    );
    expect(keys).toEqual(['2021-06-01', '2021-06-02', '2021-06-03', '2021-06-04']);
  });

  it('localDayKeysInRange counts days correctly across a DST spring-forward transition', () => {
    // America/New_York springs forward on 2021-03-14. A window spanning
    // 2021-03-13 through 2021-03-15 local should still yield exactly 3 days,
    // not be thrown off by the 23-hour day in between.
    const { dayStart } = getUtcDayBoundary('America/New_York', new Date('2021-03-13T12:00:00.000Z'));
    const { dayEnd } = getUtcDayBoundary('America/New_York', new Date('2021-03-15T12:00:00.000Z'));
    const keys = localDayKeysInRange(dayStart, dayEnd, 'America/New_York');
    expect(keys).toEqual(['2021-03-13', '2021-03-14', '2021-03-15']);
  });

  it('localDayKeysInRange counts days correctly across a DST fall-back transition', () => {
    // America/New_York falls back on 2021-11-07 (25-hour day).
    const { dayStart } = getUtcDayBoundary('America/New_York', new Date('2021-11-06T12:00:00.000Z'));
    const { dayEnd } = getUtcDayBoundary('America/New_York', new Date('2021-11-08T12:00:00.000Z'));
    const keys = localDayKeysInRange(dayStart, dayEnd, 'America/New_York');
    expect(keys).toEqual(['2021-11-06', '2021-11-07', '2021-11-08']);
  });

  it('localDayKeysInRange returns a single day for a single-instant window', () => {
    const instant = new Date('2021-06-15T14:30:00.000Z');
    const keys = localDayKeysInRange(instant, instant, 'UTC');
    expect(keys).toEqual(['2021-06-15']);
  });
});
