import type { ChargeRequest, ChargeResult, FiscalProvider, FiscalRequest, FiscalResult, PaymentProvider } from "@/server/finance/types";

const rid = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

// Modo simulado: não cobra nem emite nada de verdade.
export class MockPayment implements PaymentProvider {
  readonly name = "mock";
  created: ChargeRequest[] = [];
  cancelled: string[] = [];
  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    this.created.push(req);
    const id = `pay_mock_${rid()}`;
    return { externalId: id, paymentUrl: `https://sandbox.invalid/pay/${id}`, pixPayload: req.billingType === "PIX" ? `00020126MOCK${id}` : undefined };
  }
  async cancelCharge(externalId: string): Promise<void> {
    this.cancelled.push(externalId);
  }
}

export class MockFiscal implements FiscalProvider {
  readonly name = "mock";
  emitted: FiscalRequest[] = [];
  cancelled: string[] = [];
  async emit(req: FiscalRequest): Promise<FiscalResult> {
    this.emitted.push(req);
    const n = String(this.emitted.length + Math.floor(Math.random() * 100_000));
    return {
      externalId: `nf_mock_${rid()}`,
      number: n,
      series: "1",
      accessKey: req.kind === "NFE" ? n.padStart(44, "0") : undefined,
      pdfUrl: `https://sandbox.invalid/nf/${n}.pdf`,
      status: "EMITIDA",
    };
  }
  async cancel(externalId: string): Promise<void> {
    this.cancelled.push(externalId);
  }
}
