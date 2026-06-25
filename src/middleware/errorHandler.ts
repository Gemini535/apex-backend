import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

// ─── AppError ────────────────────────────────────────────────────────────────

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// ─── Sensitive field redaction ───────────────────────────────────────────────

/**
 * Fields that must never appear in logs — passwords, tokens, secrets. We
 * redact by name (case-insensitive) so accidental logging of req.body in an
 * error path doesn't leak credentials.
 */
const SENSITIVE_FIELDS = [
  'password',
  'passwordhash',
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'creditcard',
  'cvv',
  'authorization',
];

function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELDS.some((f) => key.toLowerCase().includes(f))) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redact(val);
    }
  }
  return out;
}

// ─── Request ID ──────────────────────────────────────────────────────────────

/**
 * Generates a short, sortable request id. Not cryptographically random — this
 * is for log correlation, not security. Format: <unixSeconds>-<6 hex chars>.
 * Falls back gracefully if crypto is unavailable.
 */
function generateRequestId(): string {
  const time = Math.floor(Date.now() / 1000).toString(36);
  let rand: string;
  try {
    rand = Math.random().toString(16).slice(2, 8);
  } catch {
    rand = '000000';
  }
  return `${time}-${rand}`;
}

/**
 * Attaches a unique request id to every incoming request and exposes it on the
 * response header so clients can include it in bug reports. Downstream logs
 * (via the error handler and any service that reads req.requestId) all share
 * the same id for tracing a single request.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const id = (req.headers['x-request-id'] as string) || generateRequestId();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

// ─── Global error handler ────────────────────────────────────────────────────

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId ?? 'unknown';

  if (err instanceof AppError) {
    // Operational errors are expected (validation, auth, business rules). Log at
    // warn level with full structured context for debugging.
    logger.warn({
      requestId,
      statusCode: err.statusCode,
      isOperational: err.isOperational,
      path: req.path,
      method: req.method,
      body: redact(req.body),
      query: req.query,
      err: err.message,
    }, 'Operational error');

    res.status(err.statusCode).json({
      error: err.message,
      requestId,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
    return;
  }

  // Unexpected errors — log at error level with the full stack and request
  // context so production issues are diagnosable from logs alone.
  logger.error({
    requestId,
    path: req.path,
    method: req.method,
    body: redact(req.body),
    query: req.query,
    err: {
      message: err.message,
      stack: err.stack,
      name: err.name,
    },
  }, 'Unhandled error');

  res.status(500).json({
    error: 'Internal server error',
    requestId,
    ...(process.env.NODE_ENV === 'development' && { detail: err.message }),
  });
}
