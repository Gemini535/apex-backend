export interface CreatePoolBody {
  name: string;
  description?: string;
  entryFee: number;       // in tokens, must be > 0
  maxParticipants?: number;
  endsAt: string;         // ISO date string
}

export interface PoolParams {
  poolId: string;
}

export interface TokenBalanceResponse {
  balance: number;
}

export interface TokenTransactionResponse {
  id: string;
  amount: number;
  type: string;
  description: string | null;
  referenceId: string | null;
  balanceAfter: number;
  createdAt: Date;
}

export interface PoolResponse {
  id: string;
  creatorId: string;
  creatorUsername: string;
  name: string;
  description: string | null;
  entryFee: number;
  maxParticipants: number | null;
  status: string;
  potTotal: number;
  participantCount: number;
  participants: PoolParticipantResponse[];
  startedAt: Date | null;
  endsAt: Date;
  settledAt: Date | null;
  createdAt: Date;
}

export interface PoolParticipantResponse {
  userId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  entryFeePaid: number;
  tokensWon: number;
  focusScore: number | null;
  joinedAt: Date;
  leftAt: Date | null;
}

export interface PoolLedgerEntry {
  id: string;
  type: string;
  amount: number;
  description: string;
  createdAt: Date;
}

// NOTE: settling a pool takes no request body — the winner is derived
// entirely from real participant activity data rather than a
// client-supplied value (see pools.service.ts's settlePool /
// CODE_REVIEW.md #2). The `SettlePoolBody` type that used to live here has
// been removed since nothing constructs one anymore.
