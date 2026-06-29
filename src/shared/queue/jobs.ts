/**
 * Canonical job queue names and payload contracts.
 *
 * Each name maps to a single handler in `/handlers.ts`. Keeping them as
 * string constants means callers never typo a queue and handler code stays
 * greppable.
 */

export const JOBS = {
  /** Recalculate brain tier + health for one user after a screen time upload. */
  BRAIN_RECALC: 'brain-recalc',

  /**
   * Hourly batch job: sweep every ACTIVE contract whose deadline has passed,
   * evaluate whether the user met their screen-time goal, and resolve the
   * contract (COMPLETED → credit pledge back; FORFEITED → debit stands).
   */
  CONTRACT_RESOLVE_ALL: 'contract-resolve-all',

  /** Re-evaluate one user's streak from their recent brain state history. */
  STREAK_DECAY: 'streak-decay',

  /**
   * Periodic maintenance: delete expired rows from the `cache_entries` table so
   * it doesn't grow unbounded.
   */
  CACHE_CLEANUP: 'cache-cleanup',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface BrainRecalcPayload {
  userId: string;
}

export interface StreakDecayPayload {
  userId: string;
}
