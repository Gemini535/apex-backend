declare namespace Express {
  interface Request {
    user?: {
      userId: string;
      email: string;
      username: string;
    };
    /** Unique id for correlating logs across a single request. */
    requestId?: string;
    /** Raw request body bytes, captured before sanitizeInput mutates req.body. Used to bind attestation assertions to the exact payload sent. */
    rawBody?: Buffer;
  }
}
