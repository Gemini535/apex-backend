/**
 * Side-effect listeners for application events.
 *
 * Each event emitted on `appEvents` triggers one or more downstream effects.
 * Adding a new side effect = registering a new listener. The event emitters
 * in brain-engine, evaluate-contract, screentime know nothing about
 * WebSockets, push notifications, or streaks — they only emit.
 *
 * Call `registerAllListeners()` once at startup. Idempotent.
 */

import { appEvents } from './events.js';
import type { BrainStateUpdate } from './brain-engine.js';
import { emitToUser, getOnlineFriends } from './websocket/socket.js';
import { broadcastToFriends } from './brain-engine.js';
import { evaluateStreak } from '../modules/users/streak.service.js';
import { sendPushToUser } from '../modules/notifications/notifications.service.js';
import { getDeviceTokens } from '../modules/devices/devices.service.js';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';

let registered = false;

/**
 * Registers all event listeners. Idempotent: calling after the first time is
 * a no-op.
 */
export function registerAllListeners(): void {
  if (registered) return;
  registered = true;

  registerBrainStateListeners();
  registerContractListeners();
  registerScreenTimeListeners();
}

// ─── Brain state push + WebSocket + streak ─────────────────────────────────────

function registerBrainStateListeners(): void {
  appEvents.on('brain:updated', async (update: BrainStateUpdate) => {
    try {
      // 1. Push the fresh tier/health to the user's own connected devices.
      emitToUser(update.userId, 'brain:state_update', update);
    } catch (err) {
      logger.error({ err, userId: update.userId }, 'brain:state_update emit failed');
    }

    // 2. Push notification to the user's registered iOS devices.
    try {
      const tokens = await getDeviceTokens(update.userId);
      if (tokens.length > 0) {
        await sendPushToUser(update.userId, {
          alert: {
            title: 'Brain State Update',
            body: `Your brain tier is now ${update.tier}.`,
          },
          category: 'brain',
          customData: { type: 'brain:updated', tier: update.tier, healthPercent: update.healthPercent },
        });
      }
    } catch (err) {
      logger.error({ err, userId: update.userId }, 'brain:updated push failed');
    }

    try {
      // 3. Broadcast to online friends via WebSocket.
      await broadcastToFriends(update.userId, update);
    } catch (err) {
      logger.error({ err, userId: update.userId }, 'friend:brain_update broadcast failed');
    }

    // 4. Push to friends who have a registered device but are NOT currently
    //    online via WebSocket (so they still see the update on their lock screen).
    try {
      const friendIds = await getBrainUpdateFriendIds(update.userId);
      const onlineFriendIds = new Set(getOnlineFriends(friendIds));
      const offlineFriends = friendIds.filter((id) => !onlineFriendIds.has(id));

      for (const friendId of offlineFriends) {
        const tokens = await getDeviceTokens(friendId);
        if (tokens.length > 0) {
          await sendPushToUser(friendId, {
            alert: {
              title: 'Friend Update',
              body: `Your friend's brain tier changed to ${update.tier}.`,
            },
            category: 'friend',
            customData: { type: 'friend:brain_update', userId: update.userId, tier: update.tier },
          });
        }
      }
    } catch (err) {
      logger.error({ err, userId: update.userId }, 'friend push notification failed');
    }

    try {
      // 5. Re-evaluate the streak based on the new tier.
      await evaluateStreak(update.userId);
    } catch (err) {
      logger.error({ err, userId: update.userId }, 'Streak evaluation failed');
    }
  });
}

// Finds all friend IDs for a user (lookup shared with broadcastToFriends).
async function getBrainUpdateFriendIds(userId: string): Promise<string[]> {
  const friendships = await prisma.friendship.findMany({
    where: { OR: [{ userId }, { friendId: userId }] },
    select: { userId: true, friendId: true },
  });
  return friendships.map((f) => (f.userId === userId ? f.friendId : f.userId));
}

// ─── Contract resolution push ──────────────────────────────────────────────────

function registerContractListeners(): void {
  appEvents.on('contract:resolved', async (payload) => {
    try {
      const { userId, name, status } = payload;

      await sendPushToUser(userId, {
        alert:
          status === 'COMPLETED'
            ? {
                title: 'Commitment Complete!',
                body: `You met your goal for "${name}". Your stake is returned.`,
              }
            : {
                title: 'Commitment Forfeited',
                body: `You didn't meet your goal for "${name}". Your stake is burned.`,
              },
        category: 'contract',
        customData: {
          type: 'contract:resolved',
          status,
          contractId: payload.contractId,
          pledgeAmount: payload.pledgeAmount,
          daysHit: payload.daysHit,
          daysTotal: payload.daysTotal,
        },
      });
    } catch (err) {
      logger.error({ err, payload }, 'contract:resolved push failed');
    }
  });
}

// ─── Screen time threshold push ────────────────────────────────────────────────

function registerScreenTimeListeners(): void {
  appEvents.on('screentime:threshold', async (payload) => {
    try {
      const { userId, tier, category } = payload;

      await sendPushToUser(userId, {
        alert: {
          title: `Brain Tier: ${tier}`,
          body: `You've exceeded your screen time limit in ${category}.`,
        },
        category: 'threshold',
        customData: { type: 'screentime:threshold', tier, category, percentUsed: payload.percentUsed },
      });
    } catch (err) {
      logger.error({ err, payload }, 'screentime:threshold push failed');
    }
  });
}

/**
 * Test/utility helper: removes all registered listeners so tests can register
 * their own. Not used in production.
 */
export function resetBrainStateListeners(): void {
  appEvents.removeAllListeners('brain:updated');
  appEvents.removeAllListeners('contract:resolved');
  appEvents.removeAllListeners('screentime:threshold');
  registered = false;
}
