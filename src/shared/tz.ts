/**
 * Timezone-aware day boundaries.
 *
 * A user's "today" starts at their local midnight — which is not 00:00 UTC for
 * anyone outside UTC. Before querying screen time or brain state we convert the
 * user's local midnight to UTC so we capture the right entries for their day.
 *
 * The `timezone` field on `User` is an IANA zone identifier (e.g.
 * "America/New_York") with "UTC" as the default. If we cannot parse the value,
 * we fall back to UTC so we never silently return wrong day boundaries.
 *
 * Implementation uses date-fns + date-fns-tz's `zonedTimeToUtc`, which handles
 * DST transitions correctly. The pattern is:
 *   1. Take "now" (a UTC instant).
 *   2. Compute startOfDay / endOfDay in the user's zone (date-fns).
 *   3. Convert those zoned wall-clock Date objects back to UTC instants
 *      (zonedTimeToUtc).
 */

import { startOfDay, endOfDay } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

const DEFAULT_TZ = 'UTC';

/**
 * Resolve the user's IANA timezone. Falls back to UTC on any failure (invalid
 * zone name, null, undefined) so callers always get a usable zone.
 */
export function resolveTimezone(timezone: string | null | undefined): string {
  if (!timezone) return DEFAULT_TZ;

  try {
    // Intl.DateTimeFormat throws RangeError for unknown time zones. Use it as
    // a cheap validator so garbage like "Not/A/Real/Zone" doesn't propagate.
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_TZ;
  }
}

export interface UtcDayBoundary {
  /** Inclusive start of the user's local day, expressed in UTC. */
  dayStart: Date;
  /** Inclusive end of the user's local day, expressed in UTC. */
  dayEnd: Date;
}

/**
 * Returns the UTC day boundary for "today" (or the local day containing
 * `reference`) in the user's timezone.
 *
 * Example: for a user in America/New_York, `dayStart` is 04:00 or 05:00 UTC
 * depending on DST, which is the moment when it was midnight in New York.
 *
 * @param timezone - user's IANA zone (use `resolveTimezone` first if the value
 *   is user-supplied).
 * @param reference - a moment inside the target local day. Defaults to now.
 */
export function getUtcDayBoundary(
  timezone: string,
  reference: Date = new Date(),
): UtcDayBoundary {
  const tz = resolveTimezone(timezone);

  // startOfDay / endOfDay operate on the Date's local-time fields. Because we
  // want them in the user's zone, we first express `reference` in that zone
  // via toZonedTime, then apply startOfDay/endOfDay, then convert the result
  // back to a real UTC instant via zonedTimeToUtc.
  //
  // date-fns-tz's toZonedTime is the right helper here: it returns a Date whose
  // UTC fields represent the wall-clock time in `tz`. Feeding that to
  // startOfDay gives us "start of this wall-clock day in tz".
  // zonedTimeToUtc then converts that wall-clock Date back to the actual UTC
  // instant.

  // Step 1: reference as wall-clock in the user's zone.
  const zonedReference = toZonedTime(reference, tz);

  // Step 2: start / end of that wall-clock day (still expressed as wall-clock).
  const localStart = startOfDay(zonedReference);
  const localEnd = endOfDay(zonedReference);

  // Step 3: convert wall-clock Date objects to real UTC instants.
  return {
    dayStart: fromZonedTime(localStart, tz),
    dayEnd: fromZonedTime(localEnd, tz),
  };
}

/**
 * Returns the calendar-day key (`YYYY-MM-DD`) that `instant` falls on in the
 * given timezone. Use this instead of `instant.toISOString().slice(0, 10)`
 * whenever you're bucketing entries by "day" for a user — the raw UTC slice
 * attributes late-evening/early-morning activity to the wrong calendar day
 * for anyone outside UTC (see CODE_REVIEW.md #17, which flagged exactly this
 * mistake in `getRangeData` feeding incorrect day-hit counts into
 * commitment-contract evaluation).
 *
 * @param timezone - user's IANA zone (use `resolveTimezone` first if the
 *   value is user-supplied).
 */
export function localDayKey(instant: Date, timezone: string): string {
  const tz = resolveTimezone(timezone);
  return toZonedTime(instant, tz).toISOString().slice(0, 10);
}
