-- CreateEnum
CREATE TYPE "AttestationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EntryAttestation" AS ENUM ('UNATTESTED', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChallengePurpose" AS ENUM ('KEY_ATTESTATION', 'UPLOAD_ASSERTION');

-- AlterTable
ALTER TABLE "ScreenTimeEntry" ADD COLUMN     "attestationStatus" "EntryAttestation" NOT NULL DEFAULT 'UNATTESTED',
ADD COLUMN     "attestationVerificationId" TEXT;

-- CreateTable
CREATE TABLE "attested_devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "publicKeyPem" TEXT NOT NULL,
    "attestationStatus" "AttestationStatus" NOT NULL DEFAULT 'VERIFIED',
    "signCount" INTEGER NOT NULL DEFAULT 0,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attested_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attestation_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "purpose" "ChallengePurpose" NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestation_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attestation_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attestedDeviceId" TEXT NOT NULL,
    "signCount" INTEGER NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "attestation_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attested_devices_keyId_key" ON "attested_devices"("keyId");

-- CreateIndex
CREATE INDEX "attested_devices_userId_idx" ON "attested_devices"("userId");

-- CreateIndex
CREATE INDEX "attested_devices_userId_attestationStatus_idx" ON "attested_devices"("userId", "attestationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "attestation_challenges_nonce_key" ON "attestation_challenges"("nonce");

-- CreateIndex
CREATE INDEX "attestation_challenges_userId_purpose_idx" ON "attestation_challenges"("userId", "purpose");

-- CreateIndex
CREATE INDEX "attestation_challenges_expiresAt_idx" ON "attestation_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX "attestation_verifications_userId_verifiedAt_idx" ON "attestation_verifications"("userId", "verifiedAt");

-- CreateIndex
CREATE INDEX "ScreenTimeEntry_userId_attestationStatus_idx" ON "ScreenTimeEntry"("userId", "attestationStatus");

-- AddForeignKey
ALTER TABLE "ScreenTimeEntry" ADD CONSTRAINT "ScreenTimeEntry_attestationVerificationId_fkey" FOREIGN KEY ("attestationVerificationId") REFERENCES "attestation_verifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attested_devices" ADD CONSTRAINT "attested_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestation_challenges" ADD CONSTRAINT "attestation_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestation_verifications" ADD CONSTRAINT "attestation_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attestation_verifications" ADD CONSTRAINT "attestation_verifications_attestedDeviceId_fkey" FOREIGN KEY ("attestedDeviceId") REFERENCES "attested_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
