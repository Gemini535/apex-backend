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
   * One-shot job: evaluate a single user's commitment contracts and flip any
   * ACTIVE past-deadline row to FAILED.
   */
  DEADLINE_EVAL: 'contract-deadline-eval',

  /**
   * Batch job: sweep every active contract and transition those past deadline.
   */
  DEADLINE_EVAL_ALL: 'contract-deadline-eval-all',

  /** Re-evaluate one user's streak from their recent brain state history. */
  STREAK_DECAY: 'streak-decay',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface BrainRecalcPayload {
  userId: string;
}

export interface ContractDeadlineEvalPayload {
  /** When provided, only this user's contracts are evaluated; otherwise sweep everyone. */
  userId?: string;
}

export interface StreakDecayPayload {
  userId: string;
}
