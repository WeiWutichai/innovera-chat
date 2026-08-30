-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileExtractStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "FileExtractStatus" ADD VALUE 'EXTRACTED';
ALTER TYPE "FileExtractStatus" ADD VALUE 'PARTIAL';
ALTER TYPE "FileExtractStatus" ADD VALUE 'UNSUPPORTED';
ALTER TYPE "FileExtractStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "extractAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extractLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "extractMetadata" JSONB,
ADD COLUMN     "extractReason" TEXT,
ADD COLUMN     "extractTruncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "extractUnits" JSONB,
ADD COLUMN     "extractedAt" TIMESTAMP(3),
ADD COLUMN     "extractedChars" INTEGER,
ADD COLUMN     "extractedText" TEXT,
ALTER COLUMN "extractStatus" SET DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "File_extractStatus_extractLeaseUntil_idx" ON "File"("extractStatus", "extractLeaseUntil");
