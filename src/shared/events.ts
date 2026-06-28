/**
 * Lightweight typed internal event emitter.
 *
 * Decouples the brain-state engine from its downstream consumers (WebSocket
 * broadcasts, streak evaluation, logging, …). The engine only knows about
 * this emitter; consumers subscribe elsewhere. Adding a new side effect means
 * registering a listener — no changes to brain-engine.ts.
 *
 * Backed by Node's built-in EventEmitter with a thin typed layer so TypeScript
 * catches event-name and payload mismatches at compile time.
 */

import { EventEmitter } from 'node:events';
import type { BrainStateUpdate } from './brain-engine.js';

// ─── Event map ────────────────────────────────────────────────────────────────

export type AppEvents = {
  'brain:updated': [update: BrainStateUpdate];
};

/**
 * Typed wrapper. The generic <K extends keyof AppEvents> ensures emit and
 * on/once all agree on the event name and its payload tuple.
 */
export class AppEventEmitter extends EventEmitter {
  emit<K extends keyof AppEvents>(event: K, ...args: AppEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof AppEvents>(
    event: K,
    listener: (...args: AppEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof AppEvents>(
    event: K,
    listener: (...args: AppEvents[K]) => void,
  ): this {
    return super.once(event, listener);
  }
}

/**
 * Single shared instance. Import this everywhere — it's intentionally a
 * singleton so multiple modules registering listeners all see the same
 * emitter and receive the same events.
 */
export const appEvents = new AppEventEmitter();

// Brain state broadcasts can fire frequently (every screen-time upload). Lift
// the default 10-listener cap so we never get Node's MaxListenersExceededWarning.
appEvents.setMaxListeners(0);
