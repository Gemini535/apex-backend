/**
 * iOS push notification service (APNs).
 *
 * Wraps Apple's HTTP/2 push API with .p8 token-based auth. No external
 * dependency — uses Node's built-in `node:http2` and `node:crypto`.
 *
 * Design:
 *   - JWT signing token is cached and refreshed every 50 minutes (Apple
 *     accepts tokens up to 1 hour old).
 *   - A single http2 connection to api.push.apple.com is reused across
 *     requests (HTTP/2 multiplexing).
 *   - Callers fire-and-forget: sendPushToUser is async but the event
 *     listeners that call it do not await it.
 *   - A 410 "inactive" response from APNs triggers deletion of the stale
 *     device token from the database.
 *
 * When APN_KEY_PATH is not set (dev/test), the service is a no-op: it logs
 * the payload at debug level and returns immediately. This keeps tests and
 * local dev working without Apple credentials.
 */

import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApplePushPayload {
  alert: string | { title: string; body: string };
  sound?: string;
  badge?: number;
  category?: string;
  customData?: Record<string, unknown>;
}

// ─── JWT signing ──────────────────────────────────────────────────────────────

const JWT_TTL_SECONDS = 60 * 60; // 1 hour (Apple's max)
const JWT_REFRESH_MS = 50 * 60 * 1000; // refresh after 50 minutes

let cachedJwt: string | null = null;
let jwtExpiresAt = 0;

function readPrivateKey(): string {
  if (!env.apns.keyPath) return '';
  try {
    return fs.readFileSync(env.apns.keyPath, 'utf8');
  } catch (err) {
    logger.error({ err, keyPath: env.apns.keyPath }, 'Failed to read APNs .p8 key');
    return '';
  }
}

function signJwt(): string {
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: env.apns.keyId }),
  ).toString('base64url');

  const payload = Buffer.from(
    JSON.stringify({ iss: env.apns.teamId, iat: now }),
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;

  const privateKey = readPrivateKey();
  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(
    { key: crypto.createPrivateKey(privateKey), dsaEncoding: 'ieee-p1363' },
    'base64url',
  );

  return `${signingInput}.${signature}`;
}

function getJwt(): string {
  const now = Date.now();
  if (cachedJwt && now < jwtExpiresAt) return cachedJwt;

  cachedJwt = signJwt();
  jwtExpiresAt = now + JWT_REFRESH_MS;
  return cachedJwt;
}

// ─── HTTP/2 connection ────────────────────────────────────────────────────────

let clientSession: http2.ClientHttp2Session | null = null;

function getApnsHost(): string {
  return env.apns.production
    ? 'https://api.push.apple.com'
    : 'https://api.development.push.apple.com';
}

function getClient(): http2.ClientHttp2Session {
  if (clientSession && !clientSession.closed && !clientSession.destroyed) {
    return clientSession;
  }

  const session = http2.connect(getApnsHost());

  session.on('error', (err) => {
    logger.error({ err }, 'APNs HTTP/2 session error');
    clientSession = null;
  });

  session.on('close', () => {
    clientSession = null;
  });

  clientSession = session;
  return session;
}

// ─── Public API ────────────────────────────────────────────────────────────────

function isConfigured(): boolean {
  return Boolean(env.apns.keyId && env.apns.teamId && env.apns.keyPath);
}

/**
 * Send a push notification to a single device token. No-op when APNs is not
 * configured (dev/test). Fire-and-forget safe.
 */
export function sendPushToToken(
  token: string,
  payload: ApplePushPayload,
): void {
  if (!isConfigured()) {
    logger.debug({ token, payload }, 'APNs not configured — skipping push');
    return;
  }

  // Fire and forget — push failures must never break the request path.
  void sendPushToTokenInner(token, payload);
}

async function sendPushToTokenInner(
  token: string,
  payload: ApplePushPayload,
): Promise<void> {
  const body = JSON.stringify({
    aps: {
      alert: payload.alert,
      sound: payload.sound ?? 'default',
      badge: payload.badge,
      category: payload.category,
      ...payload.customData,
    },
  });

  const headers: http2.OutgoingHttpHeaders = {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    ':scheme': 'https',
    ':authority': new URL(getApnsHost()).host,
    'authorization': `bearer ${getJwt()}`,
    'apns-topic': env.apns.bundleId,
    'apns-push-type': 'alert',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  };

  try {
    const session = getClient();

    await new Promise<void>((resolve, reject) => {
      const req = session.request(headers);

      req.on('response', (resHeaders) => {
        const status = resHeaders[':status'] ?? 0;

        let responseBody = '';
        req.on('data', (chunk) => { responseBody += chunk; });
        req.on('end', () => {
          if (status === 200) {
            resolve();
          } else if (status === 410) {
            // Token is no longer valid — delete it from the DB.
            logger.info({ token, status }, 'APNs reports token inactive — removing');
            void removeToken(token);
            resolve();
          } else {
            logger.warn(
              { status, body: responseBody, token },
              'APNs push failed',
            );
            resolve();
          }
        });
      });

      req.on('error', (err) => {
        logger.error({ err, token }, 'APNs request error');
        resolve();
      });

      req.write(body);
      req.end();
    });
  } catch (err) {
    logger.error({ err, token }, 'APNs send failed');
  }
}

/**
 * Send a push notification to every registered device for a user. No-op when
 * APNs is not configured.
 */
export async function sendPushToUser(
  userId: string,
  payload: ApplePushPayload,
): Promise<void> {
  if (!isConfigured()) {
    logger.debug({ userId, payload }, 'APNs not configured — skipping push');
    return;
  }

  const devices = await prisma.device.findMany({
    where: { userId },
    select: { token: true },
  });

  for (const device of devices) {
    sendPushToToken(device.token, payload);
  }
}

// ─── Token cleanup ─────────────────────────────────────────────────────────────

async function removeToken(token: string): Promise<void> {
  try {
    await prisma.device.delete({ where: { token } });
  } catch (err) {
    // P2025 = record not found (already deleted). Ignore.
    if ((err as { code?: string })?.code !== 'P2025') {
      logger.error({ err, token }, 'Failed to remove stale APNs token');
    }
  }
}
