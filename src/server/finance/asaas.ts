import { ProviderError, type ChargeRequest, type ChargeResult, type PaymentProvider } from "@/server/finance/types";

type Json = Record<string, unknown>;

// Cliente do Asaas (API v3). Sandbox: https://sandbox.asaas.com/api/v3 · Produção: https://api.asaas.com/v3
export class AsaasProvider implements PaymentProvider {
  readonly name = "asaas";
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async call(method: string, path: string, body?: Json): Promise<Json> {
    const res = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", access_token: this.apiKey, "user-agent": "flurtek-crm" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      /* corpo não era JSON */
    }
    if (!res.ok) {
      const errors = Array.isArray(json.errors) ? (json.errors as { description?: string }[]).map((e) => e.description).filter(Boolean).join("; ") : "";
      throw new ProviderError(`Asaas ${res.status}${errors ? `: ${errors}` : ""}`, res.status);
    }
    return json;
  }

  private async customerId(p: ChargeRequest["payer"]): Promise<string> {
    const found = await this.call("GET", `/customers?externalReference=${encodeURIComponent(p.externalReference)}&limit=1`);
    const first = (found.data as { id?: string }[] | undefined)?.[0];
    if (first?.id) return first.id;
    const created = await this.call("POST", "/customers", {
      name: p.name,
      cpfCnpj: p.cnpj?.replace(/\D/g, "") || undefined,
      email: p.email || undefined,
      mobilePhone: p.phone?.replace(/\D/g, "").replace(/^55/, "") || undefined,
      externalReference: p.externalReference,
      notificationDisabled: true, // quem avisa o cliente é o agente, com aprovação
    });
    return String(created.id);
  }

  async createCharge(req: ChargeRequest): Promise<ChargeResult> {
    const customer = await this.customerId(req.payer);
    const payment = await this.call("POST", "/payments", {
      customer,
      billingType: req.billingType,
      value: req.value,
      dueDate: req.dueDate.toISOString().slice(0, 10),
      description: req.description,
      externalReference: req.externalReference,
    });
    const externalId = String(payment.id);
    let pixPayload: string | undefined;
    if (req.billingType === "PIX") {
      try {
        const qr = await this.call("GET", `/payments/${externalId}/pixQrCode`);
        pixPayload = typeof qr.payload === "string" ? qr.payload : undefined;
      } catch {
        /* o link de pagamento continua valendo */
      }
    }
    return { externalId, paymentUrl: typeof payment.invoiceUrl === "string" ? payment.invoiceUrl : undefined, pixPayload };
  }

  async cancelCharge(externalId: string): Promise<void> {
    await this.call("DELETE", `/payments/${encodeURIComponent(externalId)}`);
  }
}

// Evento do webhook do Asaas que pode mudar o estado de uma cobrança.
export type AsaasEvent = { event: string; paymentId: string; value?: number; paidAt?: Date };

export function parseAsaasWebhook(payload: unknown): AsaasEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { event?: unknown; payment?: { id?: unknown; value?: unknown; confirmedDate?: unknown; paymentDate?: unknown } };
  if (typeof p.event !== "string" || !p.payment || typeof p.payment.id !== "string") return null;
  const when = (p.payment.paymentDate ?? p.payment.confirmedDate) as string | undefined;
  const date = typeof when === "string" ? new Date(`${when}T12:00:00Z`) : undefined;
  return {
    event: p.event,
    paymentId: p.payment.id,
    value: typeof p.payment.value === "number" ? p.payment.value : undefined,
    paidAt: date && !Number.isNaN(date.getTime()) ? date : undefined,
  };
}
