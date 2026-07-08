import { verifyAttestation, verifyAssertion } from 'node-app-attest';
import { env } from '../../config/env.js';

/**
 * node-app-attest exposes verifyAttestation/verifyAssertion as synchronous
 * functions that throw a plain Error on any validation failure. This adapter
 * is the only place in the codebase that imports the library, so a future
 * swap (e.g. to a manual cbor + @peculiar/x509 implementation) only touches
 * this file.
 */
export class AttestationCryptoError extends Error {
  constructor(message: string, public reason: string) {
    super(message);
    Object.setPrototypeOf(this, AttestationCryptoError.prototype);
  }
}

function appAttestIdentifiers() {
  return {
    bundleIdentifier: env.apple.appAttestBundleId,
    teamIdentifier: env.apple.teamId,
  };
}

/**
 * Verifies a key-registration attestation. Bound to the nonce alone (via the
 * library's `challenge` param) — there is no upload payload yet at
 * registration time.
 */
export function verifyAttestationObject(params: {
  attestationObjectB64: string;
  keyId: string;
  nonce: string;
}): { keyId: string; publicKeyPem: string } {
  try {
    const result = verifyAttestation({
      attestation: Buffer.from(params.attestationObjectB64, 'base64'),
      challenge: params.nonce,
      keyId: params.keyId,
      ...appAttestIdentifiers(),
      allowDevelopmentEnvironment: env.apple.appAttestEnvironment === 'development',
    });
    return { keyId: result.keyId, publicKeyPem: result.publicKey };
  } catch (err) {
    throw new AttestationCryptoError(
      'App Attest key attestation failed',
      err instanceof Error ? err.message : 'unknown_error',
    );
  }
}

/**
 * Verifies a per-upload assertion. `payload` must be the exact raw bytes the
 * client signed (its request body, including the embedded nonce field) — the
 * library hashes `payload` itself to derive the clientDataHash it checks the
 * signature against, so binding to the wrong bytes (e.g. a re-serialized
 * body) will fail verification even for a genuine device.
 *
 * The library itself enforces `signCount` is strictly greater than
 * `previousSignCount` (replay/clone defense) but explicitly does NOT verify
 * challenge/nonce freshness — see node_modules/node-app-attest's own comment
 * on this. Nonce freshness is the caller's responsibility: verify the nonce
 * embedded in `payload` corresponds to an unconsumed, unexpired
 * AttestationChallenge before calling this function.
 */
export function verifyAssertionObject(params: {
  assertionB64: string;
  publicKeyPem: string;
  payload: Buffer;
  previousSignCount: number;
}): { signCount: number } {
  try {
    const result = verifyAssertion({
      assertion: Buffer.from(params.assertionB64, 'base64'),
      payload: params.payload,
      publicKey: params.publicKeyPem,
      signCount: params.previousSignCount,
      ...appAttestIdentifiers(),
    });
    return { signCount: result.signCount };
  } catch (err) {
    throw new AttestationCryptoError(
      'App Attest assertion verification failed',
      err instanceof Error ? err.message : 'unknown_error',
    );
  }
}
