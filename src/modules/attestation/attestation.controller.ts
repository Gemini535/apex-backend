import type { Request, Response, NextFunction } from 'express';
import { issueChallenge, registerKey } from './attestation.service.js';

export async function issueChallengeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { purpose } = req.body as { purpose: 'KEY_ATTESTATION' | 'UPLOAD_ASSERTION' };
    const challenge = await issueChallenge(req.user!.userId, purpose);
    res.status(201).json(challenge);
  } catch (err) {
    next(err);
  }
}

export async function registerKeyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { keyId, attestationObject, nonce } = req.body as {
      keyId: string;
      attestationObject: string;
      nonce: string;
    };
    const device = await registerKey(req.user!.userId, {
      keyId,
      attestationObjectB64: attestationObject,
      nonce,
    });
    res.status(201).json(device);
  } catch (err) {
    next(err);
  }
}
