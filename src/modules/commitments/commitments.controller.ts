import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler.js';
import { createContract, getUserContracts, cancelContract } from './commitments.service.js';

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
