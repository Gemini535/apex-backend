// Runs before every test file. Ensures `.env` is loaded into process.env
// even for test files whose import graph doesn't happen to touch
// src/config/database.ts (or env.ts) before making a Prisma call.
import 'dotenv/config';
