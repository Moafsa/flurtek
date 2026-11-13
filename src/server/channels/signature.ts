import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Assinatura opcional do webhook: aceita "sha256=<hex>" ou só o hex, calculado com o segredo sobre o corpo bruto.
export function validSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const given = header.replace(/^sha256=/i, "").trim();
  return safeEqual(given, createHmac("sha256", secret).update(raw).digest("hex"));
}
