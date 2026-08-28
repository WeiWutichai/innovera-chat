-- DropIndex
DROP INDEX "Usage_userId_idx";

-- CreateIndex
CREATE INDEX "Usage_userId_createdAt_idx" ON "Usage"("userId", "createdAt");
