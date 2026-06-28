/**
 * Side-effect listeners for brain:updated.
 *
 * When recalculateBrainState finishes, it emits `brain:updated`. Everything
 * that should happen on top of a recalculation — broadcasting to the user,
 * broadcasting to friends, re-evaluating the streak — hangs off this
 * listener. Adding a new side effect is just another callback here; nothing in
 * brain-engine.ts or the queue handlers changes.
 *
 * Call `registerBrainStateListeners()` once at startup. Idempotent: registering
 * twice throws (EventEmitter default for `newListener` doesn't help, so we
 * track state explicitly).
 */

import { appEvents } from './events.js';
import type { BrainStateUpdate } from './brain-engine.js';
import { emitToUser } from './websocket/socket.js';
import { broadcastToFriends } from './brain-engine.js';
import { evaluateStreak } from '../modules/users/streak.service.js';
import { logger } from '../config/logger.js';

let registered = false;

/**
 * Subscribees the side-effect handlers to brain:updated. Idempotent: calling
 * after the first time is a no-op.
 */
export function registerBrainStateListeners(): void {
  if (registered) return;
  registered = true;

  appEvents.on('brain:updated', async (update) => {
    try {
      // 1. Push the fresh tier/health to the user's own connected devices.
      emitToUser(update.userId, 'brain:state_update', update);
    } catch (err) {
      // Never let a broadcast failure break the chain — streak eval runs next.
      logger.error({ err, userId: update.userId }, 'brain:state_update emit failed');
    }

    try {
      // 2. Broadcast to online friends so they see the tier change.
      await broadcastToFriends(update.userId, update);
    } catch (err) {
      logger.error({ err, userId: update.userId }, 'friend:brain_update broadcast failed');
    }

    try {
      // 3. Re-evaluate the streak based on the new tier.
      await evaluateStreak(update.userId);
    } catch (err) {
      // Streak not critical — don't fail the recalculation.
      logger.error({ err, userId: update.userId }, 'Streak evaluation failed');
    }
  });
}

/**
 * Test/utility helper: removes all registered listeners (so tests can register
 * their own). Not used in production.
 */
export function resetBrainStateListeners(): void {
  appEvents.removeAllListeners('brain:updated');
  registered = false;
}
