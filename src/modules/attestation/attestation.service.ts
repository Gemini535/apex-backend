import crypto from 'crypto';
import { prisma } from '../../config/database.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logger } from '../../config/logger.js';
import type { ChallengePurpose } from '@prisma/client';
import {
  verifyAttestationObject,
  verifyAssertionObject,
  AttestationCryptoError,
} from './appattest.crypto.js';
import type { ChallengeResult, AssertionOutcome } from './attestation.types.js';

export function getEnforcementMode(): 'off' | 'flag' | 'strict' {
  return env.features.attestationEnforcement;
}

export async function issueChallenge(userId: string, purpose: ChallengePurpose): Promise<ChallengeResult> {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.attestation.challengeTtlMs);

  await prisma.attestationChallenge.create({
    data: { userId, nonce, purpose, expiresAt },
  });

  return { nonce, purpose, expiresAt };
}

export async function registerKey(
  userId: string,
  input: { keyId: string; attestationObjectB64: string; nonce: string },
): Promise<{ deviceId: string; keyId: string }> {
  const challenge = await prisma.attestationChallenge.findUnique({ where: { nonce: input.nonce } });

  if (
    !challenge ||
    challenge.userId !== userId ||
    challenge.purpose !== 'KEY_ATTESTATION' ||
    challenge.consumedAt ||
    challenge.expiresAt < new Date()
  ) {
    throw new AppError('Invalid or expired attestation challenge', 400);
  }

  await prisma.attestationChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  let verified: { keyId: string; publicKeyPem: string };
  try {
    verified = verifyAttestationObject({
      attestationObjectB64: input.attestationObjectB64,
      keyId: input.keyId,
      nonce: input.nonce,
    });
  } catch (err) {
    if (err instanceof AttestationCryptoError) {
      logger.warn({ userId, reason: err.reason }, 'Device key attestation failed');
      throw new AppError('Device attestation failed', 401);
    }
    throw err;
  }

  try {
    const device = await prisma.attestedDevice.create({
      data: {
        userId,
        keyId: verified.keyId,
        publicKeyPem: verified.publicKeyPem,
        attestationStatus: 'VERIFIED',
        signCount: 0,
      },
    });
    return { deviceId: device.id, keyId: device.keyId };
  } catch (err) {
    // keyId is @unique — a conflict means this device already registered.
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      throw new AppError('This device key is already registered', 409);
    }
    throw err;
  }
}

/**
 * Verifies a per-upload assertion. `payload` must be the exact raw bytes of
 * the request body the client signed (including the embedded nonce field).
 * Never throws for expected failure cases — callers decide what to do with
 * a FAILED outcome based on enforcement mode.
 */
export async function verifyUploadAssertion(
  userId: string,
  input: { keyId: string; assertionB64: string; nonce: string; payload: Buffer },
): Promise<AssertionOutcome> {
  const challenge = await prisma.attestationChallenge.findUnique({ where: { nonce: input.nonce } });

  if (
    !challenge ||
    challenge.userId !== userId ||
    challenge.purpose !== 'UPLOAD_ASSERTION' ||
    challenge.consumedAt ||
    challenge.expiresAt < new Date()
  ) {
    return { status: 'FAILED', reason: 'invalid_challenge' };
  }

  // Consume the nonce before the crypto check, so it's single-use even on a
  // failed attempt — prevents brute-forcing the same nonce repeatedly.
  await prisma.attestationChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });

  const device = await prisma.attestedDevice.findUnique({ where: { keyId: input.keyId } });
  if (!device || device.userId !== userId || device.attestationStatus !== 'VERIFIED') {
    return { status: 'FAILED', reason: 'unknown_device' };
  }

  let result: { signCount: number };
  try {
    result = verifyAssertionObject({
      assertionB64: input.assertionB64,
      publicKeyPem: device.publicKeyPem,
      payload: input.payload,
      previousSignCount: device.signCount,
    });
  } catch (err) {
    if (err instanceof AttestationCryptoError) {
      logger.warn({ userId, deviceId: device.id, reason: err.reason }, 'Upload assertion verification failed');
      return { status: 'FAILED', reason: err.reason };
    }
    throw err;
  }

  const verification = await prisma.$transaction(async (tx) => {
    await tx.attestedDevice.update({
      where: { id: device.id },
      data: { signCount: result.signCount, lastVerifiedAt: new Date() },
    });
    return tx.attestationVerification.create({
      data: {
        userId,
        attestedDeviceId: device.id,
        signCount: result.signCount,
        entryCount: 0,
      },
    });
  });

  return { status: 'VERIFIED', verificationId: verification.id, attestedDeviceId: device.id };
}
