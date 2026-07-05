/**
 * Shared guard for user-supplied `from`/`to` date-range query parameters.
 *
 * Several endpoints (screen time range/apps/categories, user stats) accept
 * a caller-controlled date range and then iterate or aggregate day-by-day
 * over it. Without an upper bound, a request like `?from=0001-01-01&to=2100-01-01`
 * can force the server to synchronously build an array with hundreds of
 * thousands of entries — an easy memory/CPU DoS (CODE_REVIEW.md #14). This
 * helper centralizes the cap so every range-accepting endpoint enforces it
 * the same way.
 */

import { AppError } from '../middleware/errorHandler.js';

/** Maximum allowed span, in days, for a user-supplied date range. */
export const MAX_RANGE_DAYS = 366;

/**
 * Throws a 400 AppError if `from`/`to` are invalid or the span between them
 * exceeds `MAX_RANGE_DAYS`.
 */
export function assertValidRange(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError('Invalid date format. Use ISO 8601.', 400);
  }
  if (from > to) {
    throw new AppError('"from" date must be before "to" date.', 400);
  }
  const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new AppError(`Date range cannot exceed ${MAX_RANGE_DAYS} days.`, 400);
  }
}
