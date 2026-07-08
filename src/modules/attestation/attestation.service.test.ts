import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '../../config/database.js';

const verifyAttestationObjectMock = vi.fn();
const verifyAssertionObjectMock = vi.fn();

vi.mock('./appattest.crypto.js', () => ({
  verifyAttestationObject: (...args: unknown[]) => verifyAttestationObjectMock(...args),
  verifyAssertionObject: (...args: unknown[]) => verifyAssertionObjectMock(...args),
  AttestationCryptoError: class AttestationCryptoError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
    }
  },
}));

describe('attestation.service', () => {
  let userId: string;
  let issueChallenge: typeof import('./attestation.service.js').issueChallenge;
  let registerKey: typeof import('./attestation.service.js').registerKey;
  let verifyUploadAssertion: typeof import('./attestation.service.js').verifyUploadAssertion;
  let AttestationCryptoError: typeof import('./appattest.crypto.js').AttestationCryptoError;

  beforeAll(async () => {
    ({ issueChallenge, registerKey, verifyUploadAssertion } = await import('./attestation.service.js'));
    ({ AttestationCryptoError } = await import('./appattest.crypto.js'));

    const user = await prisma.user.create({
      data: {
        email: `attest-${Date.now()}@test.app`,
        username: `attest-${Date.now()}`,
        passwordHash: 'fake',
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.attestationVerification.deleteMany({ where: { userId } });
    await prisma.attestedDevice.deleteMany({ where: { userId } });
    await prisma.attestationChallenge.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  async function registerVerifiedDevice(keyId: string): Promise<void> {
    const challenge = await issueChallenge(userId, 'KEY_ATTESTATION');
    verifyAttestationObjectMock.mockReturnValueOnce({ keyId, publicKeyPem: `pem-${keyId}` });
    await registerKey(userId, { keyId, attestationObjectB64: 'base64attestation', nonce: challenge.nonce });
  }

  describe('registerKey', () => {
    it('persists an AttestedDevice with VERIFIED status on success', async () => {
      await registerVerifiedDevice('key-register-1');
      const device = await prisma.attestedDevice.findUnique({ where: { keyId: 'key-register-1' } });
      expect(device).toBeDefined();
      expect(device!.attestationStatus).toBe('VERIFIED');
      expect(device!.userId).toBe(userId);
    });

    it('rejects with AppError(401) when crypto verification fails', async () => {
      const challenge = await issueChallenge(userId, 'KEY_ATTESTATION');
      verifyAttestationObjectMock.mockImplementationOnce(() => {
        throw new AttestationCryptoError('bad attestation', 'invalid_signature');
      });

      await expect(
        registerKey(userId, { keyId: 'key-register-fail', attestationObjectB64: 'x', nonce: challenge.nonce }),
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('rejects an invalid or already-expired challenge before touching crypto', async () => {
      verifyAttestationObjectMock.mockClear();
      await expect(
        registerKey(userId, { keyId: 'key-bad-nonce', attestationObjectB64: 'x', nonce: 'nonce-that-does-not-exist' }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(verifyAttestationObjectMock).not.toHaveBeenCalled();
    });
  });

  describe('verifyUploadAssertion', () => {
    it('returns FAILED for an unknown/expired/already-consumed challenge — no crypto call at all', async () => {
      const outcome = await verifyUploadAssertion(userId, {
        keyId: 'any-key',
        assertionB64: 'x',
        nonce: 'nonce-that-does-not-exist',
        payload: Buffer.from('{}'),
      });
      expect(outcome).toEqual({ status: 'FAILED', reason: 'invalid_challenge' });
      expect(verifyAssertionObjectMock).not.toHaveBeenCalled();
    });

    it('returns VERIFIED and advances signCount on a valid assertion', async () => {
      await registerVerifiedDevice('key-upload-1');
      const challenge = await issueChallenge(userId, 'UPLOAD_ASSERTION');
      verifyAssertionObjectMock.mockReturnValueOnce({ signCount: 1 });

      const outcome = await verifyUploadAssertion(userId, {
        keyId: 'key-upload-1',
        assertionB64: 'assertion-bytes',
        nonce: challenge.nonce,
        payload: Buffer.from(JSON.stringify({ entries: [], attestationNonce: challenge.nonce })),
      });

      expect(outcome.status).toBe('VERIFIED');
      const device = await prisma.attestedDevice.findUnique({ where: { keyId: 'key-upload-1' } });
      expect(device!.signCount).toBe(1);
      if (outcome.status === 'VERIFIED') {
        const verification = await prisma.attestationVerification.findUnique({ where: { id: outcome.verificationId } });
        expect(verification).toBeDefined();
        expect(verification!.attestedDeviceId).toBe(device!.id);
      }
    });

    it('consumes the nonce even when the crypto check subsequently fails (single-use, no brute-forcing one nonce)', async () => {
      await registerVerifiedDevice('key-upload-2');
      const challenge = await issueChallenge(userId, 'UPLOAD_ASSERTION');
      verifyAssertionObjectMock.mockImplementationOnce(() => {
        throw new AttestationCryptoError('signature mismatch', 'invalid_signature');
      });

      const first = await verifyUploadAssertion(userId, {
        keyId: 'key-upload-2',
        assertionB64: 'tampered',
        nonce: challenge.nonce,
        payload: Buffer.from('{}'),
      });
      expect(first).toEqual({ status: 'FAILED', reason: 'invalid_signature' });

      // Retrying with the same nonce must fail as invalid_challenge (already consumed),
      // even though this time we'd otherwise mock a success — proves single-use.
      verifyAssertionObjectMock.mockReturnValueOnce({ signCount: 2 });
      const retry = await verifyUploadAssertion(userId, {
        keyId: 'key-upload-2',
        assertionB64: 'retry',
        nonce: challenge.nonce,
        payload: Buffer.from('{}'),
      });
      expect(retry).toEqual({ status: 'FAILED', reason: 'invalid_challenge' });
    });

    it('returns FAILED for an unknown device keyId', async () => {
      const challenge = await issueChallenge(userId, 'UPLOAD_ASSERTION');
      const outcome = await verifyUploadAssertion(userId, {
        keyId: 'never-registered-key',
        assertionB64: 'x',
        nonce: challenge.nonce,
        payload: Buffer.from('{}'),
      });
      expect(outcome).toEqual({ status: 'FAILED', reason: 'unknown_device' });
    });
  });
});
