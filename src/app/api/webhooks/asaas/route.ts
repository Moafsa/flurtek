import { db } from "@/lib/db";
import { parseAsaasWebhook } from "@/server/finance/asaas";
import { applyPaymentEvent } from "@/server/finance/service";
import { safeEqual } from "@/server/channels/signature";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";
const MAX_BODY = 200_000;

// O Asaas envia o token configurado no webhook no cabeçalho "asaas-access-token".
export async function POST(req: Request) {
  const token = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!token) return new Response("webhook não configurado", { status: 503 });
  if (!safeEqual(req.headers.get("asaas-access-token") ?? "", token)) return new Response("não autorizado", { status: 401 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new Response("corpo grande demais", { status: 413 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("json inválido", { status: 400 });
  }

  const eventId = typeof (payload as { id?: unknown })?.id === "string" ? `asaas:${(payload as { id: string }).id}` : null;
  let event;
  try {
    event = await db.webhookEvent.create({ data: { provider: "asaas", dedupeKey: eventId, payload: payload as Prisma.InputJsonValue } });
  } catch {
    return Response.json({ ok: true, duplicate: true }); // o Asaas reenvia; já processamos
  }
  try {
    const parsed = parseAsaasWebhook(payload);
    const result = parsed ? await applyPaymentEvent(parsed) : "ignorado";
    await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    return Response.json({ ok: true, result });
  } catch (error) {
    console.error("[webhook asaas]", error);
    await db.webhookEvent.update({ where: { id: event.id }, data: { error: error instanceof Error ? error.message.slice(0, 300) : "erro" } });
    return new Response("erro ao processar", { status: 500 }); // 500 faz o Asaas tentar de novo
  }
}
