import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain } from 'express-validator';

export function validate(validations: ValidationChain[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    await Promise.all(validations.map((v) => v.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      next();
      return;
    }

    const extracted = errors.array().map((e) => ({
      field: e.type === 'field' ? e.path : undefined,
      message: e.msg,
    }));

    res.status(400).json({ error: 'Validation failed', details: extracted });
  };
}
