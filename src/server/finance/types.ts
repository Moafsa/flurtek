// Contratos do financeiro. O gateway (Asaas) cobra; o provedor fiscal emite a nota. Ambos têm modo simulado.
export type BillingType = "PIX" | "BOLETO" | "CREDIT_CARD" | "UNDEFINED";

export interface PayerInfo {
  externalReference: string; // id do cliente no CRM
  name: string;
  cnpj?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ChargeRequest {
  payer: PayerInfo;
  billingType: BillingType;
  value: number;
  dueDate: Date;
  description: string;
  externalReference: string; // id da cobrança no CRM
}

export interface ChargeResult {
  externalId: string;
  paymentUrl?: string;
  pixPayload?: string;
}

export interface PaymentProvider {
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  cancelCharge(externalId: string): Promise<void>;
}

export interface FiscalRequest {
  kind: "NFE" | "NFSE";
  orderId: string;
  customerName: string;
  cnpj?: string | null;
  items: { description: string; quantity: string | null; value: number }[];
  total: number;
  // Regime e códigos fiscais vigentes no momento da emissão (para o provedor montar os impostos).
  fiscal?: { regime: string | null; crt: number | null; environment: "HOMOLOGACAO" | "PRODUCAO"; series: number; number: number; taxCode: string; cfop: string; ncm: string };
}

export interface FiscalResult {
  externalId: string;
  number?: string;
  series?: string;
  accessKey?: string;
  pdfUrl?: string;
  xmlUrl?: string;
  // Provedores assíncronos devolvem PENDENTE e confirmam depois.
  status: "EMITIDA" | "PENDENTE";
}

export interface FiscalProvider {
  readonly name: string;
  emit(req: FiscalRequest): Promise<FiscalResult>;
  cancel(externalId: string, reason: string): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
