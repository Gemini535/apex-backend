import { body, query } from 'express-validator';
import type { AppCategory } from '@prisma/client';

const VALID_CATEGORIES: AppCategory[] = [
  'SOCIAL',
  'GAMES',
  'ENTERTAINMENT',
  'PRODUCTIVITY',
  'UTILITIES',
  'PHOTO_VIDEO',
  'LIFESTYLE',
  'OTHER',
];

/** Upper bound on how many entries a single upload can contain. */
const MAX_ENTRIES_PER_BATCH = 500;

/** No single entry may claim more screen time than a full day. */
const MAX_DURATION_SECONDS = 24 * 60 * 60;

/** Tolerance for client clock drift when rejecting future-dated entries. */
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface RawEntry {
  startedAt?: string;
  endedAt?: string;
  duration?: number;
}

export const batchUpload = [
  // No `min` here — an empty array is a valid attested quiet-day check-in
  // (see the attestationNonce rule below), which upstream's plain
  // non-empty-array check didn't anticipate. `max` is still enforced.
  body('entries')
    .isArray({ max: MAX_ENTRIES_PER_BATCH })
    .withMessage(`entries must be an array of at most ${MAX_ENTRIES_PER_BATCH} items`),
  body('entries.*.appName')
    .notEmpty()
    .withMessage('appName is required'),
  body('entries.*.category')
    .isIn(VALID_CATEGORIES)
    .withMessage(`category must be one of: ${VALID_CATEGORIES.join(', ')}`),
  body('entries.*.duration')
    .isInt({ min: 1, max: MAX_DURATION_SECONDS })
    .withMessage(`duration must be a positive integer no greater than ${MAX_DURATION_SECONDS} seconds (24h)`),
  body('entries.*.startedAt')
    .isISO8601()
    .withMessage('startedAt must be an ISO 8601 date')
    .custom((value: string) => {
      if (new Date(value).getTime() > Date.now() + FUTURE_CLOCK_SKEW_MS) {
        throw new Error('startedAt cannot be in the future');
      }
      return true;
    }),
  body('entries.*.endedAt')
    .optional()
    .isISO8601()
    .withMessage('endedAt must be an ISO 8601 date'),

  // Screen time is entirely self-reported by the client and directly feeds
  // brain tier/health, streaks, pool focus scores, and commitment-contract
  // completion (real token stakes) — so beyond per-field format checks, we
  // also sanity-check each entry as a whole: `endedAt` can't precede
  // `startedAt`, and the claimed `duration` can't wildly exceed the
  // wall-clock window the entry claims to span. This closes the "report a
  // single absurd PRODUCTIVITY entry to instantly win a contract" gap
  // (CODE_REVIEW.md #3). The bound is deliberately generous (2x + 1 minute
  // slack) to tolerate overlapping/background sessions rather than reject
  // legitimate client behavior.
  body('entries').custom((entries: RawEntry[]) => {
    if (!Array.isArray(entries)) return true;
    for (const entry of entries) {
      if (!entry.startedAt || !entry.endedAt) continue;
      const startedAt = new Date(entry.startedAt).getTime();
      const endedAt = new Date(entry.endedAt).getTime();
      if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) continue;

      if (endedAt < startedAt) {
        throw new Error('endedAt cannot be before startedAt');
      }
      if (typeof entry.duration === 'number') {
        const wallClockSeconds = (endedAt - startedAt) / 1000;
        if (entry.duration > wallClockSeconds * 2 + 60) {
          throw new Error('duration is not plausible for the given startedAt/endedAt window');
        }
      }
    }
    return true;
  }),
  // A quiet-day check-in (zero usage) is sent as an empty entries array plus
  // an attestationNonce — proving a genuine device checked in that day
  // without fabricating a placeholder entry. An empty, unattested batch has
  // nothing to store and nothing to verify, so it's rejected.
  body('entries').custom((entries, { req }) => {
    if (Array.isArray(entries) && entries.length === 0 && !req.body.attestationNonce) {
      throw new Error('An empty entries array requires an attestationNonce check-in');
    }
    return true;
  }),
  body('attestationNonce')
    .optional()
    .isString()
    .notEmpty()
    .withMessage('attestationNonce must be a non-empty string'),
];

export const dateRange = [
  query('from')
    .isISO8601()
    .withMessage('from must be an ISO 8601 date'),
  query('to')
    .isISO8601()
    .withMessage('to must be an ISO 8601 date'),
];

export const optionalDateRange = [
  query('from')
    .optional()
    .isISO8601()
    .withMessage('from must be an ISO 8601 date'),
  query('to')
    .optional()
    .isISO8601()
    .withMessage('to must be an ISO 8601 date'),
];
