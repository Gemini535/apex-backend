/**
 * Cache module barrel export.
 *
 * Re-exports the three typed caches plus a `clearAllCaches` helper that's
 * useful in tests to reset state between runs.
 */

export { brainStateCache, clearBrainStateCache } from './brainState.js';
export { clearFriendsCache } from './friends.js';
export { balanceCache, clearBalanceCache } from './balance.js';
export { getCachedBrainState } from './brainState.js';
export { getFriends, getPending, getSent, setFriends, setPending, setSent, invalidateFriends } from './friends.js';
export { getCachedBalance, setCachedBalance, invalidateBalance } from './balance.js';

import { clearBrainStateCache } from './brainState.js';
import { clearFriendsCache } from './friends.js';
import { clearBalanceCache } from './balance.js';

export function clearAllCaches(): void {
  clearBrainStateCache();
  clearFriendsCache();
  clearBalanceCache();
}
