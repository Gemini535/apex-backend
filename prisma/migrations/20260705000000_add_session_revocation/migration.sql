-- Adds refresh-token-reuse detection support to Session.
-- revokedAt: set when this session's refresh token has been rotated away
-- (used once to mint a new session) instead of hard-deleted. A row with
-- revokedAt set is never treated as active.
-- replacedById: the id of the session that replaced this one, for audit trails.
ALTER TABLE "Session" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "replacedById" TEXT;
