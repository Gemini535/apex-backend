import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import {
  spinWheel,
  getUserPowerUps,
  activatePowerUp,
  getUserCosmetics,
  equipCosmetic,
  createContract,
  getUserContracts,
  cancelContract,
} from './powerups.service.js';

// ─── Token Wheel ──────────────────────────────────────────────────────────────

export async function spinWheelHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await spinWheel(req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Power-Ups ────────────────────────────────────────────────────────────────

export async function getPowerUpsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const powerUps = await getUserPowerUps(req.user!.userId);
    res.json({ powerUps });
  } catch (err) {
    next(err);
  }
}

export async function activatePowerUpHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { powerUpType, targetPoolId, targetUserId } = req.body;
    if (!powerUpType) throw new AppError('powerUpType is required', 400);

    const result = await activatePowerUp(req.user!.userId, powerUpType, targetPoolId, targetUserId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Cosmetics ────────────────────────────────────────────────────────────────

export async function getCosmeticsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cosmetics = await getUserCosmetics(req.user!.userId);
    res.json({ cosmetics });
  } catch (err) {
    next(err);
  }
}

export async function equipCosmeticHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userCosmeticId } = req.body;
    if (!userCosmeticId) throw new AppError('userCosmeticId is required', 400);

    const result = await equipCosmetic(req.user!.userId, userCosmeticId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ─── Commitment Contracts ─────────────────────────────────────────────────────

export async function createContractHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, description, pledgeAmountCents, targetScreenTime, startDate, endDate, charityName } = req.body;
    if (!name) throw new AppError('name is required', 400);
    if (!pledgeAmountCents) throw new AppError('pledgeAmountCents is required', 400);
    if (!targetScreenTime) throw new AppError('targetScreenTime is required', 400);
    if (!startDate) throw new AppError('startDate is required', 400);
    if (!endDate) throw new AppError('endDate is required', 400);

    const contract = await createContract(req.user!.userId, {
      name,
      description,
      pledgeAmountCents,
      targetScreenTime,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      charityName,
    });
    res.status(201).json(contract);
  } catch (err) {
    next(err);
  }
}

export async function getContractsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const contracts = await getUserContracts(req.user!.userId);
    res.json({ contracts });
  } catch (err) {
    next(err);
  }
}

export async function cancelContractHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await cancelContract(req.user!.userId, req.params.contractId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
