import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import * as service from './screentime.service.js';
import type { AppCategory } from '@prisma/client';
import { assertValidRange } from '../../shared/dateRange.js';

export async function uploadBatch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { entries } = req.body as {
      entries: Array<{
        appName: string;
        appBundleId?: string;
        category: AppCategory;
        duration: number;
        startedAt: string;
        endedAt?: string;
        isBlacklisted?: boolean;
      }>;
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
    const result = await service.uploadBatch(req.user!.userId, parsed);
    res.status(201).json({ message: 'Screen time entries uploaded', count: result.count });
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
