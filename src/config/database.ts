// Loads `.env` into process.env as a side effect. This module is the first
// thing most test files import (directly or via a service), and PrismaClient
// reads `process.env.DATABASE_URL` lazily on each query — so if nothing in
// the import graph has run dotenv yet, tests fail with "Environment variable
// not found: DATABASE_URL" even though `.env` exists and `npx prisma migrate
// deploy` (which loads .env itself via the Prisma CLI) works fine.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
