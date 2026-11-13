import { handleWebhook } from "@/server/channels/webhook-service";
import { safeEqual as same, validSignature } from "@/server/channels/signature";

export const dynamic = "force-dynamic";
const MAX_BODY = 1_000_000;

function authorized(req: Request, raw: string): boolean {
  const token = process.env.CONEXTBOT_WEBHOOK_TOKEN;
  if (!token) return false;
  const given = new URL(req.url).searchParams.get("token") ?? req.headers.get("x-webhook-token") ?? "";
  if (!same(given, token)) return false;
  const secret = process.env.CONEXTBOT_WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers.get("x-hub-signature-256") ?? req.headers.get("x-signature") ?? req.headers.get("x-conextbot-signature");
    return validSignature(raw, header, secret);
  }
  return true;
}

// Verificação de endereço (algumas plataformas chamam por GET antes de ativar o webhook).
export async function GET(req: Request) {
  if (!authorized(req, "")) {
    if (process.env.CONEXTBOT_WEBHOOK_SECRET) return new Response("ok", { status: 200 }); // sem corpo para assinar
    return new Response("não autorizado", { status: 401 });
  }
  const challenge = new URL(req.url).searchParams.get("hub.challenge");
  return new Response(challenge ?? "ok", { status: 200 });
}

export async function POST(req: Request) {
  if (!process.env.CONEXTBOT_WEBHOOK_TOKEN) return new Response("webhook não configurado", { status: 503 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new Response("corpo grande demais", { status: 413 });
  if (!authorized(req, raw)) return new Response("não autorizado", { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("json inválido", { status: 400 });
  }
  try {
    const summary = await handleWebhook(payload);
    return Response.json({ ok: true, ...summary });
  } catch (error) {
    // Respondemos 200 para o ConextBot não repetir sem parar; o erro fica gravado no WebhookEvent.
    console.error("[webhook conextbot]", error);
    return Response.json({ ok: false });
  }
}
