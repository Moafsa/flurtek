import { AsaasProvider } from "@/server/finance/asaas";
import { MockFiscal, MockPayment } from "@/server/finance/mock";
import type { FiscalProvider, PaymentProvider } from "@/server/finance/types";

let payment: PaymentProvider | null = null;
let fiscal: FiscalProvider | null = null;

// Cobra de verdade só com PAYMENT_MODE=sandbox|live E chave. Qualquer outra coisa é simulado.
export function getPayment(): PaymentProvider {
  if (payment) return payment;
  const mode = process.env.PAYMENT_MODE;
  const key = process.env.ASAAS_API_KEY;
  if ((mode === "sandbox" || mode === "live") && key) {
    const base = mode === "live" ? "https://api.asaas.com/v3" : "https://sandbox.asaas.com/api/v3";
    payment = new AsaasProvider(process.env.ASAAS_BASE_URL ?? base, key);
  } else payment = new MockPayment();
  return payment;
}

// O Asaas só emite NFS-e (serviço). Água e fluido são produto (NF-e), então a emissão real precisa de
// um provedor de NF-e (ex.: Focus NFe, eNotas) ou do contador. Por ora a emissão é simulada.
export function getFiscal(): FiscalProvider {
  return (fiscal ??= new MockFiscal());
}

export function resetFinanceForTests(p?: PaymentProvider, f?: FiscalProvider) {
  payment = p ?? null;
  fiscal = f ?? null;
}
