import type { Request, Response, NextFunction } from 'express';

/**
 * Field names that must never be mutated by sanitization. Stripping
 * characters like `<`, `>`, `"`, `'`, `&`, or backtick from a password
 * before it's hashed silently changes the password the user thinks they
 * set — and the password-strength validator actively *requires* several of
 * those characters (`!@#$%^&*()_+-=[]{}|;:,.<>/?`), so this used to corrupt
 * a meaningful fraction of legitimately "strong" passwords on registration
 * and password reset with no error surfaced to the user. The same problem
 * applies to tokens, secrets, and one-time codes: mutating them just
 * corrupts a value that's compared byte-for-byte later. See
 * CODE_REVIEW.md #12.
 */
const SENSITIVE_KEY_PATTERN = /password|token|secret|code|authorization|creditcard|cvv/i;

/**
 * Recursively strips HTML tags and trims whitespace from string values in an
 * object. Numbers, booleans, dates, and null pass through untouched. This runs
 * AFTER express-validator (which coerces types and checks formats) so we trust
 * the shape but still defensively encode anything that reaches the DB layer.
 *
 * `key` is the property name this value was found under (if any) — passed
 * down through recursion so sensitive fields can be left completely
 * untouched regardless of nesting depth.
 */
function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return value;
  }

  if (typeof value === 'string') {
    // Strip any HTML/XML tags then collapse whitespace. escape-html would
    // encode entities; here we drop tags entirely so stored text stays clean.
    const stripped = value
      .replace(/<[^>]*>/g, '') // remove tags
      .replace(/[<>\"'&`]/g, '') // drop leftover risky characters
      .trim();
    return stripped;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, key));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValue(val, k);
    }
    return out;
  }
  // numbers, booleans, null, undefined
  return value;
}

/**
 * Sanitizes req.query and req.params, which are read-only-ish typed records.
 * We rebuild a clean copy and assign it via type assertion — the runtime
 * values are what matter, and express-validator already parsed these.
 */
function sanitizeQueryOrParams(
  original: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(original)) {
    out[key] = sanitizeValue(val, key);
  }
  return out;
}

/**
 * Global sanitization middleware. Operates on req.body, req.query, and req.params
 * so every downstream service/controller receives clean strings regardless of
 * which validators ran on the route.
 */
export function sanitizeInput(_req: Request, _res: Response, next: NextFunction): void {
  try {
    if (_req.body && typeof _req.body === 'object') {
      _req.body = sanitizeValue(_req.body) as Record<string, unknown>;
    }
    if (_req.query && typeof _req.query === 'object') {
      // req.query is ParsedQs — assign via assertion since we're replacing values.
      Object.assign(_req.query, sanitizeQueryOrParams(_req.query as unknown as Record<string, unknown>));
    }
    if (_req.params && typeof _req.params === 'object') {
      // req.params is ParamsDictionary (string values) — rebuild cleanly.
      const clean = sanitizeQueryOrParams(_req.params as unknown as Record<string, unknown>);
      for (const key of Object.keys(_req.params)) {
        (_req.params as Record<string, string>)[key] = (clean[key] as string) ?? '';
      }
    }
  } catch {
    // Never block the request over sanitization failure — log and continue.
  }
  next();
}
