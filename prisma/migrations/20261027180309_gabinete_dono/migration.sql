-- AlterTable
ALTER TABLE "AuthorizedNumber" ADD COLUMN     "userId" TEXT,
ADD COLUMN     "verifyCodeHash" TEXT,
ADD COLUMN     "verifyExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OwnerCommand" (
    "id" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "summary" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerWatch" (
    "id" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerCommand_phoneKey_createdAt_idx" ON "OwnerCommand"("phoneKey", "createdAt");

-- CreateIndex
CREATE INDEX "OwnerWatch_leadId_active_idx" ON "OwnerWatch"("leadId", "active");

-- AddForeignKey
ALTER TABLE "AuthorizedNumber" ADD CONSTRAINT "AuthorizedNumber_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerWatch" ADD CONSTRAINT "OwnerWatch_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

