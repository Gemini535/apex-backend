declare namespace Express {
  interface Request {
    user?: {
      userId: string;
      email: string;
      username: string;
    };
    /** Unique id for correlating logs across a single request. */
    requestId?: string;
  }
}
