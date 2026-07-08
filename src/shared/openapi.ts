/**
 * OpenAPI 3.0 specification for the Apex backend.
 *
 * This is the single source of truth for the API contract. It's served as JSON
 * at /api/docs.json and rendered as an interactive Swagger UI at /api/docs.
 *
 * When you add or change a route, update the matching path/item here so the
 * frontend developer always has accurate documentation.
 */
export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Apex API',
    version: '1.0.0',
    description:
      'Backend for Apex — the hyper-gamified social-accountability digital wellbeing app. ' +
      'Covers auth, friends, tokens/payments, screen time, power-ups, cosmetics, ' +
      'commitment contracts, and the token wheel.',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
    { url: '/', description: 'Current host' },
  ],
  tags: [
    { name: 'Auth', description: 'Registration, login, OAuth, sessions, password reset' },
    { name: 'Users', description: 'Profiles, brain state, stats, search' },
    { name: 'Friends', description: 'Friend requests, blocking, presence' },
    { name: 'Tokens & Payments', description: 'Balance, transactions, Stripe deposits/withdrawals' },
    { name: 'Pools', description: 'Cash pools — create, join, settle' },
    { name: 'Screen Time', description: 'Upload and query device screen time' },
    { name: 'Attestation', description: 'Apple App Attest device-integrity verification' },
    { name: 'Power-Ups & Cosmetics', description: 'Token wheel, power-ups, Cortex Vault' },
    { name: 'Commitment Contracts', description: 'Self-imposed goal contracts with stakes' },
    { name: 'System', description: 'Health and docs' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token obtained from POST /api/auth/login or /api/auth/refresh',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Invalid email or password' },
          requestId: { type: 'string', example: 'lxq2k1-a3f9c2' },
        },
        required: ['error'],
      },
      ValidationError: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Validation failed' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string', example: 'email' },
                message: { type: 'string', example: 'A valid email address is required' },
              },
            },
          },
        },
      },
      SafeUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          username: { type: 'string' },
          displayName: { type: 'string', nullable: true },
          avatarUrl: { type: 'string', nullable: true },
          brainHealth: { type: 'integer', minimum: 0, maximum: 100 },
          brainTier: { type: 'string', enum: ['PRISTINE', 'FOG', 'SLIME', 'GRAY_VOID'] },
          currentStreak: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          requires2FA: { type: 'boolean' },
        },
      },
      AuthResponse: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
          user: { $ref: '#/components/schemas/SafeUser' },
        },
      },
      RefreshResponse: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          refreshToken: { type: 'string' },
        },
      },
      Balance: {
        type: 'object',
        properties: { balance: { type: 'integer', example: 1500 } },
      },
      WheelSpinResult: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['CREDITS', 'POWER_UP', 'COSMETIC'] },
          credits: { type: 'integer', nullable: true },
          powerUp: { type: 'string', nullable: true, example: 'DOUBLE_DOWN' },
          cosmetic: { type: 'string', nullable: true, example: 'neon_aura' },
          message: { type: 'string' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    // ─── System ─────────────────────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        description:
          'Returns 200 if the app and database are reachable, 503 otherwise. ' +
          'Use this for load balancer health probes.',
        security: [],
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                example: {
                  status: 'ok',
                  timestamp: '2026-06-25T12:00:00.000Z',
                  checks: { database: { status: 'up', responseTimeMs: 3 } },
                },
              },
            },
          },
          '503': { description: 'Database is unreachable' },
        },
      },
    },

    // ─── Auth ───────────────────────────────────────────────────────────────
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new account',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'username', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  username: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$' },
                  password: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Account created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
          '409': { description: 'Email or username already taken' },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in with email and password',
        description: 'Rate limited to 5 attempts per 15 minutes per IP.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Login successful, or 2FA required',
            content: {
              'application/json': {
                examples: {
                  direct: {
                    summary: 'No 2FA',
                    value: { accessToken: '...', refreshToken: '...', user: {} },
                  },
                  requires2fa: {
                    summary: '2FA required',
                    value: { requires2FA: true, tempToken: '...' },
                  },
                },
              },
            },
          },
          '401': { description: 'Invalid credentials' },
          '429': { description: 'Too many attempts' },
        },
      },
    },
    '/api/auth/login/2fa': {
      post: {
        tags: ['Auth'],
        summary: 'Complete login with a 2FA code',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tempToken', 'code'],
                properties: {
                  tempToken: { type: 'string', description: 'From POST /api/auth/login when requires2FA is true' },
                  code: { type: 'string', pattern: '^[0-9]{6}$' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Login complete', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
          '401': { description: 'Invalid code or expired session' },
        },
      },
    },
    '/api/auth/apple': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with Apple',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['token'], properties: { token: { type: 'string', description: 'Apple identity token (JWT)' } } },
            },
          },
        },
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
          '401': { description: 'Invalid Apple token' },
        },
      },
    },
    '/api/auth/google': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with Google',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['token'], properties: { token: { type: 'string', description: 'Google ID token' } } },
            },
          },
        },
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
          '401': { description: 'Invalid Google token' },
        },
      },
    },
    '/api/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Refresh an access token',
        description: 'Rotates the refresh token — the old one is invalidated.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/RefreshResponse' } } } },
          '401': { description: 'Invalid or expired refresh token' },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Log out',
        description: 'Pass a refreshToken to revoke one session; omit to revoke all sessions.',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { refreshToken: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Logged out' } },
      },
    },
    '/api/auth/password/forgot': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password reset link',
        description: 'Always returns 200 to prevent email enumeration. Rate limited.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
            },
          },
        },
        responses: { '200': { description: 'If the account exists, a reset link was sent' } },
      },
    },
    '/api/auth/password/reset': {
      post: {
        tags: ['Auth'],
        summary: 'Reset a password using a token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'password'],
                properties: {
                  token: { type: 'string' },
                  password: { type: 'string', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Password reset; all sessions invalidated' },
          '400': { description: 'Invalid or expired token' },
        },
      },
    },
    '/api/auth/verify-email': {
      post: {
        tags: ['Auth'],
        summary: 'Verify an email address from a token',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': { description: 'Email verified' },
          '400': { description: 'Invalid or expired token' },
        },
      },
    },
    '/api/auth/verify-email/send': {
      post: {
        tags: ['Auth'],
        summary: 'Resend the verification email',
        responses: { '200': { description: 'Verification email sent' } },
      },
    },
    '/api/auth/2fa/setup/totp': {
      post: {
        tags: ['Auth'],
        summary: 'Begin TOTP setup — returns secret + QR code',
        responses: {
          '200': {
            content: {
              'application/json': {
                example: { secret: 'JBSWY3DPEHPK3PXP', qrCodeDataUrl: 'data:image/png;base64,...', backupCodes: ['12345678', '...'] },
              },
            },
          },
        },
      },
    },
    '/api/auth/2fa/verify/totp': {
      post: {
        tags: ['Auth'],
        summary: 'Verify a TOTP code and enable TOTP 2FA',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } } },
            },
          },
        },
        responses: { '200': { description: 'TOTP enabled' }, '400': { description: 'Invalid code' } },
      },
    },
    '/api/auth/2fa/setup/sms': {
      post: {
        tags: ['Auth'],
        summary: 'Set up SMS 2FA — sends a code to the given number',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['phoneNumber'], properties: { phoneNumber: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Code sent' } },
      },
    },
    '/api/auth/2fa/verify/sms': {
      post: {
        tags: ['Auth'],
        summary: 'Verify an SMS code and enable SMS 2FA',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } } },
            },
          },
        },
        responses: { '200': { description: 'SMS 2FA enabled' }, '400': { description: 'Invalid code' } },
      },
    },
    '/api/auth/2fa/setup/email': {
      post: {
        tags: ['Auth'],
        summary: 'Set up email 2FA — sends a code to your email',
        responses: { '200': { description: 'Code sent' } },
      },
    },
    '/api/auth/2fa/verify/email': {
      post: {
        tags: ['Auth'],
        summary: 'Verify an email code and enable email 2FA',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } } },
            },
          },
        },
        responses: { '200': { description: 'Email 2FA enabled' }, '400': { description: 'Invalid code' } },
      },
    },
    '/api/auth/2fa': {
      delete: {
        tags: ['Auth'],
        summary: 'Disable all 2FA methods',
        description: 'Requires a valid TOTP code. Invalidates all sessions.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } } },
            },
          },
        },
        responses: { '200': { description: '2FA disabled' }, '400': { description: 'Invalid code' } },
      },
    },
    '/api/auth/sessions': {
      get: {
        tags: ['Auth'],
        summary: 'List active sessions',
        responses: { '200': { description: 'List of sessions' } },
      },
    },
    '/api/auth/sessions/revoke': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke a specific session',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Session revoked' } },
      },
    },
    '/api/auth/sessions/revoke-all': {
      post: {
        tags: ['Auth'],
        summary: 'Revoke all sessions (optionally keep the current one)',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { currentSessionId: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Sessions revoked' } },
      },
    },

    // ─── Users ──────────────────────────────────────────────────────────────
    '/api/users/me': {
      get: {
        tags: ['Users'],
        summary: 'Get the current user\'s profile',
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/SafeUser' } } } } },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update the current user\'s profile',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  displayName: { type: 'string' },
                  bio: { type: 'string' },
                  avatarUrl: { type: 'string' },
                  timezone: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/SafeUser' } } } } },
      },
    },
    '/api/users/search': {
      get: {
        tags: ['Users'],
        summary: 'Search users by username',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Matching users' } },
      },
    },
    '/api/users/me/brain-state': {
      get: {
        tags: ['Users'],
        summary: 'Get today\'s brain state (tier, health, screen time)',
        responses: { '200': { description: 'Current brain state' } },
      },
    },
    '/api/users/me/stats': {
      get: {
        tags: ['Users'],
        summary: 'Get aggregated screen time stats for a date range',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: 'Aggregated stats' } },
      },
    },
    '/api/users/{username}': {
      get: {
        tags: ['Users'],
        summary: 'Get a user\'s public profile',
        parameters: [{ name: 'username', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Public profile' }, '404': { description: 'User not found' } },
      },
    },

    // ─── Friends ────────────────────────────────────────────────────────────
    '/api/friends/request': {
      post: {
        tags: ['Friends'],
        summary: 'Send a friend request',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['username'], properties: { username: { type: 'string' } } },
            },
          },
        },
        responses: { '201': { description: 'Request sent' }, '404': { description: 'User not found' }, '409': { description: 'Already friends or request pending' } },
      },
    },
    '/api/friends/accept': {
      post: {
        tags: ['Friends'],
        summary: 'Accept a friend request',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string', format: 'uuid' } } },
            },
          },
        },
        responses: { '200': { description: 'Request accepted' }, '404': { description: 'Request not found' } },
      },
    },
    '/api/friends/decline': {
      post: {
        tags: ['Friends'],
        summary: 'Decline a friend request',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['requestId'], properties: { requestId: { type: 'string', format: 'uuid' } } },
            },
          },
        },
        responses: { '200': { description: 'Request declined' } },
      },
    },
    '/api/friends/{userId}': {
      delete: {
        tags: ['Friends'],
        summary: 'Remove a friend',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Friend removed' } },
      },
    },
    '/api/friends/block': {
      post: {
        tags: ['Friends'],
        summary: 'Block a user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', format: 'uuid' } } },
            },
          },
        },
        responses: { '200': { description: 'User blocked' } },
      },
    },
    '/api/friends/block/{userId}': {
      delete: {
        tags: ['Friends'],
        summary: 'Unblock a user',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'User unblocked' } },
      },
    },
    '/api/friends': {
      get: {
        tags: ['Friends'],
        summary: 'List friends (with online status)',
        responses: { '200': { description: 'Friends list' } },
      },
    },
    '/api/friends/requests/pending': {
      get: {
        tags: ['Friends'],
        summary: 'List pending incoming friend requests',
        responses: { '200': { description: 'Pending requests' } },
      },
    },
    '/api/friends/requests/sent': {
      get: {
        tags: ['Friends'],
        summary: 'List sent friend requests',
        responses: { '200': { description: 'Sent requests' } },
      },
    },

    // ─── Tokens & Payments ──────────────────────────────────────────────────
    '/api/tokens/balance': {
      get: {
        tags: ['Tokens & Payments'],
        summary: 'Get token balance',
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Balance' } } } } },
      },
    },
    '/api/tokens/transactions': {
      get: {
        tags: ['Tokens & Payments'],
        summary: 'Get transaction history (paginated)',
        parameters: [
          { name: 'skip', in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'take', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'Transaction list' } },
      },
    },
    '/api/payments/deposit': {
      post: {
        tags: ['Tokens & Payments'],
        summary: 'Create a Stripe deposit (PaymentIntent)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer', description: 'Amount in cents. 1 cent = 1 token.' } } },
            },
          },
        },
        responses: { '200': { description: 'Returns Stripe clientSecret' } },
      },
    },
    '/api/payments/withdraw': {
      post: {
        tags: ['Tokens & Payments'],
        summary: 'Withdraw tokens to a bank card (Stripe payout)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer', description: 'Amount in tokens.' } } },
            },
          },
        },
        responses: { '200': { description: 'Withdrawal initiated' } },
      },
    },
    '/api/payments/customer': {
      get: {
        tags: ['Tokens & Payments'],
        summary: 'Get the Stripe customer record',
        responses: { '200': { description: 'Customer details' } },
      },
    },

    // ─── Pools ──────────────────────────────────────────────────────────────
    '/api/pools': {
      get: {
        tags: ['Pools'],
        summary: 'List active pools',
        responses: { '200': { description: 'Pool list' } },
      },
      post: {
        tags: ['Pools'],
        summary: 'Create a new pool',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'entryFee', 'endsAt'],
                properties: {
                  name: { type: 'string', maxLength: 100 },
                  entryFee: { type: 'integer', minimum: 1, maximum: 10000 },
                  maxParticipants: { type: 'integer', minimum: 2 },
                  endsAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Pool created' } },
      },
    },
    '/api/pools/{poolId}': {
      get: {
        tags: ['Pools'],
        summary: 'Get pool details with participants',
        parameters: [{ name: 'poolId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Pool details' }, '404': { description: 'Pool not found' } },
      },
    },
    '/api/pools/{poolId}/join': {
      post: {
        tags: ['Pools'],
        summary: 'Join a pool (deducts entry fee)',
        parameters: [{ name: 'poolId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Joined' }, '400': { description: 'Pool full or already started' }, '409': { description: 'Already joined' } },
      },
    },
    '/api/pools/{poolId}/leave': {
      post: {
        tags: ['Pools'],
        summary: 'Leave a pool before it starts (refund)',
        parameters: [{ name: 'poolId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Left and refunded' } },
      },
    },
    '/api/pools/{poolId}/settle': {
      post: {
        tags: ['Pools'],
        summary: 'Settle a pool (distribute winnings)',
        description:
          "Only the pool creator or a participant can trigger settlement, and only after the pool " +
          "ends. The winner is derived entirely from each participant's real screen-time/focus data " +
          "over the pool's shared settlement window — this endpoint takes no body and does not " +
          "accept a client-supplied winner. If no participant has any verifiable activity data, " +
          "every entry fee is refunded in full and the pool is cancelled instead of an arbitrary payout.",
        parameters: [{ name: 'poolId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Pool settled or cancelled-and-refunded' },
          '403': { description: 'Not the creator or a participant' },
          '409': { description: 'Pool is already being settled (concurrent settle attempt)' },
        },
      },
    },
    '/api/pools/{poolId}/ledger': {
      get: {
        tags: ['Pools'],
        summary: 'Get the pool\'s audit ledger',
        parameters: [{ name: 'poolId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Ledger entries' } },
      },
    },

    // ─── Screen Time ────────────────────────────────────────────────────────
    '/api/screentime/batch': {
      post: {
        tags: ['Screen Time'],
        summary: 'Bulk upload screen time entries from the device',
        description:
          'Accepts an optional `attestationNonce` field plus an `x-attestation` request header ' +
          '(base64 JSON: `{ keyId, assertion }`) to prove the upload came from a genuine, unmodified ' +
          'app instance — see the Attestation endpoints. The assertion is signed over the exact raw ' +
          'bytes of this request body, so it cannot also live inside the body it is attesting to. ' +
          '`entries` may be empty when `attestationNonce` is present, to register an attested ' +
          'zero-usage "quiet day" check-in without fabricating a placeholder entry; an empty, ' +
          'unattested batch is rejected. Depending on ATTESTATION_ENFORCEMENT, an upload without a ' +
          'valid attestation is either accepted-and-flagged (`off`/`flag`) or rejected outright ' +
          '(`strict`).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['entries'],
                properties: {
                  entries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['appName', 'category', 'duration', 'startedAt'],
                      properties: {
                        appName: { type: 'string' },
                        appBundleId: { type: 'string' },
                        category: { type: 'string', enum: ['SOCIAL', 'GAMES', 'ENTERTAINMENT', 'PRODUCTIVITY', 'UTILITIES', 'PHOTO_VIDEO', 'LIFESTYLE', 'OTHER'] },
                        duration: { type: 'integer', description: 'Seconds' },
                        startedAt: { type: 'string', format: 'date-time' },
                        endedAt: { type: 'string', format: 'date-time' },
                        isBlacklisted: { type: 'boolean' },
                      },
                    },
                  },
                  attestationNonce: {
                    type: 'string',
                    description: 'Nonce from POST /api/attestation/challenge (purpose=UPLOAD_ASSERTION). Required when entries is empty.',
                  },
                },
              },
            },
          },
        },
        parameters: [{
          name: 'x-attestation',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'base64 JSON { keyId, assertion } — required alongside attestationNonce to verify the upload.',
        }],
        responses: {
          '201': { description: 'Entries stored, response includes attestationStatus: VERIFIED | FAILED | UNATTESTED' },
          '401': { description: 'Valid attestation required (ATTESTATION_ENFORCEMENT=strict only)' },
        },
      },
    },
    '/api/screentime/today': {
      get: {
        tags: ['Screen Time'],
        summary: 'Get today\'s screen time summary',
        responses: { '200': { description: 'Today\'s summary with brain tier/health' } },
      },
    },
    '/api/screentime/range': {
      get: {
        tags: ['Screen Time'],
        summary: 'Get daily summaries for a date range',
        parameters: [
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'Daily summaries' } },
      },
    },
    '/api/screentime/apps': {
      get: {
        tags: ['Screen Time'],
        summary: 'Get per-app breakdown for a date range',
        parameters: [
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'App breakdown' } },
      },
    },
    '/api/screentime/categories': {
      get: {
        tags: ['Screen Time'],
        summary: 'Get per-category breakdown for a date range',
        parameters: [
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'Category breakdown' } },
      },
    },
    '/api/screentime/active': {
      get: {
        tags: ['Screen Time'],
        summary: 'Get the currently active app session',
        responses: { '200': { description: 'Active session or null' } },
      },
    },

    // ─── Attestation ────────────────────────────────────────────────────────
    '/api/attestation/challenge': {
      post: {
        tags: ['Attestation'],
        summary: 'Issue a single-use nonce for App Attest key registration or upload assertion',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['purpose'],
                properties: { purpose: { type: 'string', enum: ['KEY_ATTESTATION', 'UPLOAD_ASSERTION'] } },
              },
            },
          },
        },
        responses: { '201': { description: 'Challenge issued: { nonce, purpose, expiresAt }' } },
      },
    },
    '/api/attestation/register-key': {
      post: {
        tags: ['Attestation'],
        summary: 'Register a device\'s App Attest key after key generation + attestation',
        description:
          'Verifies the attestation object against Apple\'s App Attest root of trust and the ' +
          'previously-issued challenge nonce, then stores the device\'s public key for verifying ' +
          'future upload assertions.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['keyId', 'attestationObject', 'nonce'],
                properties: {
                  keyId: { type: 'string' },
                  attestationObject: { type: 'string', description: 'base64-encoded CBOR attestation object' },
                  nonce: { type: 'string', description: 'Nonce from a KEY_ATTESTATION challenge' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Device registered: { deviceId, keyId }' },
          '400': { description: 'Invalid or expired challenge' },
          '401': { description: 'Attestation verification failed' },
          '409': { description: 'This device key is already registered' },
        },
      },
    },

    // ─── Power-Ups & Cosmetics ──────────────────────────────────────────────
    '/api/wheel/spin': {
      post: {
        tags: ['Power-Ups & Cosmetics'],
        summary: 'Spin the token wheel',
        description:
          'Costs tokens and drops a weighted random reward: 70% credits, ' +
          '20% power-up, 10% cosmetic. Rate limited to 10 spins/minute per user.',
        responses: {
          '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/WheelSpinResult' } } } },
          '402': { description: 'Insufficient tokens' },
          '429': { description: 'Too many spins' },
        },
      },
    },
    '/api/power-ups': {
      get: {
        tags: ['Power-Ups & Cosmetics'],
        summary: 'List the current user\'s power-ups',
        responses: { '200': { description: 'Power-up inventory' } },
      },
    },
    '/api/power-ups/activate': {
      post: {
        tags: ['Power-Ups & Cosmetics'],
        summary: 'Activate a power-up',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['powerUpId'], properties: { powerUpId: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Power-up activated' } },
      },
    },
    '/api/cosmetics': {
      get: {
        tags: ['Power-Ups & Cosmetics'],
        summary: 'List cosmetics owned by the user (Cortex Vault)',
        responses: { '200': { description: 'Owned cosmetics' } },
      },
    },
    '/api/cosmetics/equip': {
      post: {
        tags: ['Power-Ups & Cosmetics'],
        summary: 'Equip a cosmetic',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['cosmeticId'], properties: { cosmeticId: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'Cosmetic equipped' } },
      },
    },

    // ─── Commitment Contracts ───────────────────────────────────────────────
    '/api/commitments': {
      get: {
        tags: ['Commitment Contracts'],
        summary: 'List the current user\'s commitment contracts',
        responses: { '200': { description: 'Contract list' } },
      },
      post: {
        tags: ['Commitment Contracts'],
        summary: 'Create a commitment contract with a token stake',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'stake', 'deadline'],
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  stake: { type: 'integer', description: 'Tokens risked' },
                  deadline: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Contract created' } },
      },
    },
    '/api/commitments/{contractId}/cancel': {
      post: {
        tags: ['Commitment Contracts'],
        summary: 'Cancel a commitment contract',
        parameters: [{ name: 'contractId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Contract cancelled' } },
      },
    },
  },
} as const;
