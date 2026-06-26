import type { Request, Response, NextFunction } from 'express';
import { getBalance, getTransactions } from './tokens.service.js';

export async function getBalanceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await getBalance(req.user!.userId));
  } catch (err) {
    next(err);
  }
}

export async function getTransactionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(await getTransactions(req.user!.userId, page, limit));
  } catch (err) {
    next(err);
  }
}
