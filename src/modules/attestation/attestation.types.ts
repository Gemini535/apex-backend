import type { ChallengePurpose } from '@prisma/client';

export interface ChallengeResult {
  nonce: string;
  purpose: ChallengePurpose;
  expiresAt: Date;
}

export type AssertionOutcome =
  | { status: 'VERIFIED'; verificationId: string; attestedDeviceId: string }
  | { status: 'FAILED'; reason: string };
