export interface FriendRequestBody {
  username: string; // target user's username
}

export interface FriendRequestIdBody {
  requestId: string;
}

export interface BlockUserBody {
  userId: string;
}

export interface FriendUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  brainHealth: number;
  brainTier: string;
  isOnline: boolean;
  currentStreak: number;
}

export interface FriendRequestResponse {
  id: string;
  sender: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  receiver: {
    id: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  status: string;
  createdAt: Date;
}
