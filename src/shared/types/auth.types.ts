export interface RegisterBody {
  email: string;
  username: string;
  password: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  user: SafeUser;
}

export interface SafeUser {
  id: string;
  email: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  brainHealth: number;
  brainTier: string;
  currentStreak: number;
  createdAt: Date;
  requires2FA: boolean;
}

export interface OAuthBody {
  token: string;        // Apple or Google ID token
  deviceId?: string;
}

export interface TwoFASetupResponse {
  secret: string;
  qrCodeDataUrl: string;
  backupCodes: string[];
}

export interface TwoFAVerifyBody {
  code: string;
}

export interface TwoFADisableBody {
  code: string;
}

export interface RefreshTokenBody {
  refreshToken: string;
}

export interface SMSSetupBody {
  phoneNumber: string;
}

export interface EmailSetupBody {
  // Uses authenticated user's email
}
