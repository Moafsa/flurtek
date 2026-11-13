-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('ABERTO', 'FATURADO', 'PAGO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "ChargeStatus" AS ENUM ('PENDENTE', 'PAGA', 'VENCIDA', 'CANCELADA', 'ESTORNADA');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('PENDENTE', 'EMITIDA', 'ERRO', 'CANCELADA');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "address" JSONB,
ADD COLUMN     "ie" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "status" "OrderStatus" NOT NULL DEFAULT 'ABERTO';

-- CreateTable
CREATE TABLE "Charge" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "billingType" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "ChargeStatus" NOT NULL DEFAULT 'PENDENTE',
    "paymentUrl" TEXT,
    "pixPayload" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidValue" DECIMAL(12,2),
    "createdById" TEXT,
    "remindedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalDoc" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "chargeId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "number" TEXT,
    "series" TEXT,
    "accessKey" TEXT,
    "status" "FiscalStatus" NOT NULL DEFAULT 'PENDENTE',
    "pdfUrl" TEXT,
    "xmlUrl" TEXT,
    "error" TEXT,
    "emittedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalDoc_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Charge_externalId_key" ON "Charge"("externalId");

-- CreateIndex
CREATE INDEX "Charge_status_dueDate_idx" ON "Charge"("status", "dueDate");

-- CreateIndex
CREATE INDEX "Charge_orderId_idx" ON "Charge"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalDoc_externalId_key" ON "FiscalDoc"("externalId");

-- CreateIndex
CREATE INDEX "FiscalDoc_orderId_idx" ON "FiscalDoc"("orderId");

-- CreateIndex
CREATE INDEX "FiscalDoc_status_idx" ON "FiscalDoc"("status");

-- AddForeignKey
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalDoc" ADD CONSTRAINT "FiscalDoc_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalDoc" ADD CONSTRAINT "FiscalDoc_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "Charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

