-- The initial migration (20260616232820_init) was generated before several
-- models were added to schema.prisma (Device, PowerUp, CosmeticItem,
-- UserCosmetic, CommitmentContract, CacheEntry, WheelSpin) and before three
-- TransactionType enum values used by the commitment-contracts feature
-- (CONTRACT_STAKE, CONTRACT_PAYOUT, CONTRACT_FORFEIT). Those models/values
-- were never captured in a migration, so any database created purely from
-- `prisma migrate deploy` is missing these tables even though `prisma
-- generate` and the application code assume they exist. This migration
-- brings the database in line with the current schema.

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'CONTRACT_STAKE';
ALTER TYPE "TransactionType" ADD VALUE 'CONTRACT_PAYOUT';
ALTER TYPE "TransactionType" ADD VALUE 'CONTRACT_FORFEIT';

-- CreateEnum
CREATE TYPE "PowerUpType" AS ENUM ('BOUNTY', 'BS', 'BS_PLUS', 'DOUBLE_DOWN', 'SLIME_SHIELD', 'INHALE_ASSIST');

-- CreateEnum
CREATE TYPE "CosmeticType" AS ENUM ('HAT', 'GLASSES', 'HEADPHONES', 'COFFEE_CUP', 'BACKGROUND', 'SKIN', 'ACCESSORY');

-- CreateEnum
CREATE TYPE "CosmeticRarity" AS ENUM ('COMMON', 'RARE', 'EPIC', 'LEGENDARY', 'SEASONAL');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'FORFEITED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'ios',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PowerUp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PowerUpType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "targetPoolId" TEXT,
    "targetUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PowerUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CosmeticItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "CosmeticType" NOT NULL,
    "rarity" "CosmeticRarity" NOT NULL DEFAULT 'COMMON',
    "price" INTEGER NOT NULL DEFAULT 0,
    "assetUrl" TEXT,
    "seasonalTag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CosmeticItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCosmetic" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cosmeticId" TEXT NOT NULL,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCosmetic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommitmentContract" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pledgeAmount" INTEGER NOT NULL,
    "stripePaymentId" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'ACTIVE',
    "targetScreenTime" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "charityName" TEXT,
    "charityStripeId" TEXT,
    "completedAt" TIMESTAMP(3),
    "forfeitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitmentContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cache_entries" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_entries_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "WheelSpin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 10,
    "rewardType" TEXT NOT NULL,
    "rewardId" TEXT,
    "rewardAmount" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WheelSpin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_token_key" ON "Device"("token");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE INDEX "PowerUp_userId_type_idx" ON "PowerUp"("userId", "type");

-- CreateIndex
CREATE INDEX "PowerUp_userId_activatedAt_idx" ON "PowerUp"("userId", "activatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CosmeticItem_name_key" ON "CosmeticItem"("name");

-- CreateIndex
CREATE UNIQUE INDEX "UserCosmetic_userId_cosmeticId_key" ON "UserCosmetic"("userId", "cosmeticId");

-- CreateIndex
CREATE INDEX "UserCosmetic_userId_equipped_idx" ON "UserCosmetic"("userId", "equipped");

-- CreateIndex
CREATE UNIQUE INDEX "CommitmentContract_stripePaymentId_key" ON "CommitmentContract"("stripePaymentId");

-- CreateIndex
CREATE INDEX "CommitmentContract_userId_status_idx" ON "CommitmentContract"("userId", "status");

-- CreateIndex
CREATE INDEX "cache_entries_expiresAt_idx" ON "cache_entries"("expiresAt");

-- CreateIndex
CREATE INDEX "WheelSpin_userId_createdAt_idx" ON "WheelSpin"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PowerUp" ADD CONSTRAINT "PowerUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCosmetic" ADD CONSTRAINT "UserCosmetic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCosmetic" ADD CONSTRAINT "UserCosmetic_cosmeticId_fkey" FOREIGN KEY ("cosmeticId") REFERENCES "CosmeticItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitmentContract" ADD CONSTRAINT "CommitmentContract_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WheelSpin" ADD CONSTRAINT "WheelSpin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
