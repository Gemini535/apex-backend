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
  // Widened per CODE_REVIEW.md #32 — these also carry credential-adjacent
  // material (2FA/verification codes, TOTP secrets, phone numbers) that
  // shouldn't land in logs verbatim either.
  'code',
  'totpsecret',
  'backupcodes',
  'phonenumber',
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

/** Client-supplied request ids must match this shape or they're discarded
 * in favor of a freshly generated one — an unbounded, unvalidated header
 * value gets echoed straight back into the response header and into every
 * log line for the request, which is an easy vector for log-formatting
 * abuse or oversized header values (CODE_REVIEW.md #30). */
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

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
  const clientSupplied = req.headers['x-request-id'];
  const id =
    typeof clientSupplied === 'string' && REQUEST_ID_PATTERN.test(clientSupplied)
      ? clientSupplied
      : generateRequestId();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}

// ─── Prisma error mapping ────────────────────────────────────────────────────

/**
 * Prisma known-request-error shape, duck-typed rather than imported from
 * `@prisma/client` to keep this middleware decoupled from the ORM.
 */
interface PrismaKnownRequestError extends Error {
  code: string;
  meta?: { target?: string[] };
}

function isPrismaKnownRequestError(err: unknown): err is PrismaKnownRequestError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('P')
  );
}

/**
 * Maps common Prisma error codes to a clean AppError instead of falling
 * through to a generic 500. Nothing in this codebase previously caught
 * P2002 (unique constraint violation) anywhere, so any legitimate race
 * (concurrent registration with the same email, a friend request racing a
 * duplicate insert, etc.) surfaced as a raw, unhelpful 500 to the loser of
 * the race instead of a clean 409 (CODE_REVIEW.md #18).
 */
function mapPrismaError(err: PrismaKnownRequestError): AppError | null {
  switch (err.code) {
    case 'P2002': {
      const fields = err.meta?.target?.join(', ') ?? 'a unique field';
      return new AppError(`A record with this ${fields} already exists.`, 409);
    }
    case 'P2025':
      return new AppError('The requested record was not found.', 404);
    default:
      return null;
  }
}

// ─── Global error handler ────────────────────────────────────────────────────

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId ?? 'unknown';

  // Translate known Prisma errors (e.g. a unique-constraint race) into a
  // proper AppError before the generic-vs-operational branch below, so
  // routes don't each need their own try/catch for P2002/P2025.
  if (isPrismaKnownRequestError(err)) {
    const mapped = mapPrismaError(err);
    if (mapped) {
      err = mapped;
    }
  }

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
