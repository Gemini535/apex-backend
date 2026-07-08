import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import cbor from 'cbor';

/**
 * Exercises the real node-app-attest verifyAssertion algorithm (not mocked)
 * by hand-constructing a valid CBOR-encoded assertion the same way a real
 * device would, using a self-generated P-256 key pair. This proves the
 * payload-binding fix (correction #4): a genuine signature over one payload
 * does not verify against a different payload, closing the gap where a
 * nonce-only binding would let tampered/fabricated content through
 * unnoticed as long as it came from a real device.
 *
 * The full Apple cert-chain path (verifyAttestationObject, i.e. key
 * registration) is hardware-rooted and not exercised here — see the plan's
 * note on a manual QA replay step with a real captured attestation object
 * before shipping 'strict' mode.
 *
 * Apple identifiers must be non-empty for the library to run at all, and env
 * vars must be set before config/env.ts is first evaluated — so imports here
 * are dynamic (see app.featureFlag.test.ts for the same pattern).
 */
describe('appattest.crypto — verifyAssertionObject', () => {
  const bundleId = 'com.test.bundle';
  const teamId = 'TESTTEAMID';

  let verifyAssertionObject: typeof import('./appattest.crypto.js').verifyAssertionObject;
  let AttestationCryptoError: typeof import('./appattest.crypto.js').AttestationCryptoError;
  let publicKeyPem: string;
  let privateKey: crypto.KeyObject;

  beforeAll(async () => {
    process.env.APPLE_APP_ATTEST_BUNDLE_ID = bundleId;
    process.env.APPLE_TEAM_ID = teamId;
    vi.resetModules();
    ({ verifyAssertionObject, AttestationCryptoError } = await import('./appattest.crypto.js'));

    const { publicKey, privateKey: priv } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateKey = priv;
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  function buildAssertion(payload: Buffer, signCount: number, opts?: { wrongTeamId?: boolean }): string {
    const appIdHash = crypto
      .createHash('sha256')
      .update(`${opts?.wrongTeamId ? 'OTHERTEAM' : teamId}.${bundleId}`)
      .digest();
    const flags = Buffer.from([0x00]);
    const signCountBuf = Buffer.alloc(4);
    signCountBuf.writeInt32BE(signCount);
    const authenticatorData = Buffer.concat([appIdHash, flags, signCountBuf]);

    const clientDataHash = crypto.createHash('sha256').update(payload).digest();
    const nonce = crypto.createHash('sha256').update(Buffer.concat([authenticatorData, clientDataHash])).digest();

    const signer = crypto.createSign('SHA256');
    signer.update(nonce);
    const signature = signer.sign(privateKey);

    return cbor.encode({ signature, authenticatorData }).toString('base64');
  }

  it('verifies a genuine assertion signed over the exact payload', () => {
    const payload = Buffer.from(JSON.stringify({ entries: [], attestationNonce: 'abc123' }));
    const assertionB64 = buildAssertion(payload, 1);

    const result = verifyAssertionObject({ assertionB64, publicKeyPem, payload, previousSignCount: 0 });
    expect(result.signCount).toBe(1);
  });

  it('rejects when the payload was altered after signing (payload-binding, not just nonce-binding)', () => {
    const originalPayload = Buffer.from(JSON.stringify({ entries: [{ duration: 60 }], attestationNonce: 'abc123' }));
    const assertionB64 = buildAssertion(originalPayload, 1);

    const tamperedPayload = Buffer.from(JSON.stringify({ entries: [{ duration: 999999 }], attestationNonce: 'abc123' }));

    expect(() =>
      verifyAssertionObject({ assertionB64, publicKeyPem, payload: tamperedPayload, previousSignCount: 0 }),
    ).toThrow(AttestationCryptoError);
  });

  it('rejects when signCount has not advanced past the stored value (replay/clone defense)', () => {
    const payload = Buffer.from('{}');
    const assertionB64 = buildAssertion(payload, 3);

    expect(() =>
      verifyAssertionObject({ assertionB64, publicKeyPem, payload, previousSignCount: 3 }),
    ).toThrow(AttestationCryptoError);
  });

  it('rejects an assertion signed for a different app ID', () => {
    const payload = Buffer.from('{}');
    const assertionB64 = buildAssertion(payload, 1, { wrongTeamId: true });

    expect(() =>
      verifyAssertionObject({ assertionB64, publicKeyPem, payload, previousSignCount: 0 }),
    ).toThrow(AttestationCryptoError);
  });

  it('rejects malformed/garbage assertion bytes', () => {
    expect(() =>
      verifyAssertionObject({
        assertionB64: Buffer.from('not a real cbor assertion').toString('base64'),
        publicKeyPem,
        payload: Buffer.from('{}'),
        previousSignCount: 0,
      }),
    ).toThrow(AttestationCryptoError);
  });
});
