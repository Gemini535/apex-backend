// Shared type utilities for the Apex backend

/**
 * After authenticateToken middleware runs, req.user is guaranteed to be set.
 * Use `req.user!` (non-null assertion) in authenticated route handlers.
 * The global Express.Request type is augmented in types/express.d.ts to include `user?: {...}`.
 */
