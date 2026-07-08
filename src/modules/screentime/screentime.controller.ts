import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import * as service from './screentime.service.js';
import type { AppCategory } from '@prisma/client';
import { assertValidRange } from '../../shared/dateRange.js';

/**
 * The x-attestation header carries the assertion (keyId + signature) instead
 * of the JSON body — the assertion is generated over the body's bytes, so it
 * can't also be embedded inside the very body it's attesting to.
 */
function readAttestationHeader(req: Request): { keyId: string; assertion: string } | undefined {
  const header = req.headers['x-attestation'];
  if (typeof header !== 'string' || !header) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    if (typeof parsed?.keyId === 'string' && typeof parsed?.assertion === 'string') {
      return { keyId: parsed.keyId, assertion: parsed.assertion };
    }
    throw new Error('missing keyId/assertion');
  } catch {
    throw new AppError('Invalid x-attestation header', 400);
  }
}

export async function uploadBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { entries, attestationNonce } = req.body as {
      entries: Array<{
        appName: string;
        appBundleId?: string;
        category: AppCategory;
        duration: number;
        startedAt: string;
        endedAt?: string;
        isBlacklisted?: boolean;
      }>;
      attestationNonce?: string;
    };
    const parsed = entries.map((e) => ({
      appName: e.appName,
      appBundleId: e.appBundleId,
      category: e.category,
      duration: e.duration,
      startedAt: new Date(e.startedAt),
      endedAt: e.endedAt ? new Date(e.endedAt) : undefined,
      isBlacklisted: e.isBlacklisted,
    }));

    let attestation: service.UploadBatchAttestation | undefined;
    const headerAttestation = readAttestationHeader(req);
    if (headerAttestation && attestationNonce) {
      if (!req.rawBody) {
        throw new AppError('Raw request body unavailable for attestation binding', 500);
      }
      attestation = {
        keyId: headerAttestation.keyId,
        assertionB64: headerAttestation.assertion,
        nonce: attestationNonce,
        payload: req.rawBody,
      };
    }

    const result = await service.uploadBatch(req.user!.userId, parsed, attestation);
    res.status(201).json({
      message: 'Screen time entries uploaded',
      count: result.count,
      attestationStatus: result.attestationStatus,
    });
  } catch (error) {
    next(error);
  }
}

export async function getToday(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await service.getTodaySummary(req.user!.userId));
  } catch (error) {
    next(error);
  }
}

export async function getRange(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { from, to } = req.query;
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new AppError('from and to query parameters are required', 400);
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    assertValidRange(fromDate, toDate);
    res.json(await service.getRangeData(req.user!.userId, fromDate, toDate));
  } catch (error) {
    next(error);
  }
}

export async function getApps(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let fromDate: Date;
    let toDate: Date;
    if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
      fromDate = new Date(req.query.from);
      toDate = new Date(req.query.to);
      assertValidRange(fromDate, toDate);
    } else {
      // Default to "today" in the user's own timezone, not the server
      // process's local timezone (see getDefaultTodayRange).
      ({ from: fromDate, to: toDate } = await service.getDefaultTodayRange(req.user!.userId));
    }
    res.json(await service.getAppsBreakdown(req.user!.userId, fromDate, toDate));
  } catch (error) {
    next(error);
  }
}

export async function getCategories(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    let fromDate: Date;
    let toDate: Date;
    if (typeof req.query.from === 'string' && typeof req.query.to === 'string') {
      fromDate = new Date(req.query.from);
      toDate = new Date(req.query.to);
      assertValidRange(fromDate, toDate);
    } else {
      ({ from: fromDate, to: toDate } = await service.getDefaultTodayRange(req.user!.userId));
    }
    res.json(await service.getCategoriesBreakdown(req.user!.userId, fromDate, toDate));
  } catch (error) {
    next(error);
  }
}

export async function getActive(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await service.getActiveSession(req.user!.userId);
    if (!session) {
      res.json({ active: false, session: null });
      return;
    }
    res.json({
      active: true,
      session: {
        appName: session.appName,
        category: session.category,
        startedAt: session.startedAt.toISOString(),
        durationSoFar: session.durationSoFar,
      },
    });
  } catch (error) {
    next(error);
  }
}
