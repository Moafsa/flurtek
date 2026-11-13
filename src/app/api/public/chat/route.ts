import { timingSafeEqual } from "node:crypto";
import { ChatError, chatState, sendVisitorMessage } from "@/server/chat/service";
import { allow } from "@/server/ratelimit";

export const dynamic = "force-dynamic";

const MAX_BODY = 8_000;

function allowedOrigins(): string[] {
  return (process.env.INTAKE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function cors(origin: string | null): Record<string, string> {
  return origin && allowedOrigins().includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, x-site-key", "Access-Control-Max-Age": "600", Vary: "Origin" }
    : { Vary: "Origin" };
}

function json(body: unknown, status: number, origin: string | null) {
  return Response.json(body, { status, headers: { ...cors(origin), "Cache-Control": "no-store" } });
}

const sameKey = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const clientIp = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "desconhecido").trim();

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: origin && allowedOrigins().includes(origin) ? 204 : 403, headers: cors(origin) });
}

// Busca novas mensagens. O token da sessão (128 bits) é a credencial; não há dado de outras conversas.
export async function GET(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && !allowedOrigins().includes(origin)) return json({ ok: false, error: "origem_nao_permitida" }, 403, null);
  if (!allow(`chat:poll:${clientIp(req)}`, 90, 60_000)) return json({ ok: false, error: "muitas_requisicoes" }, 429, origin);
  const url = new URL(req.url);
  try {
    const state = await chatState(url.searchParams.get("s") ?? "", url.searchParams.get("after") ?? undefined);
    return json({ ok: true, ...state }, 200, origin);
  } catch (e) {
    if (e instanceof ChatError) return json({ ok: false, error: "sessao_nao_encontrada" }, 404, origin);
    console.error("[chat] poll", e);
    return json({ ok: false, error: "erro_interno" }, 500, origin);
  }
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) return json({ ok: false, error: "origem_nao_permitida" }, 403, null);
  const siteKey = process.env.INTAKE_SITE_KEY;
  if (!siteKey || !sameKey(req.headers.get("x-site-key") ?? "", siteKey)) return json({ ok: false, error: "chave_invalida" }, 401, origin);

  const ip = clientIp(req);
  if (!allow(`chat:min:${ip}`, 14, 60_000) || !allow(`chat:hour:${ip}`, 150, 3_600_000)) return json({ ok: false, error: "muitas_requisicoes" }, 429, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "corpo_grande_demais" }, 413, origin);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "json_invalido" }, 400, origin);
  }
  // Sessões novas por IP têm limite próprio (evita encher o CRM de leads falsos).
  const isNew = typeof data === "object" && data !== null && !("sessionId" in data && (data as { sessionId?: unknown }).sessionId);
  if (isNew && !allow(`chat:new:${ip}`, 6, 3_600_000)) return json({ ok: false, error: "muitas_requisicoes" }, 429, origin);

  try {
    const r = await sendVisitorMessage(data);
    return json({ ok: true, sessionId: r.sessionId, ...r.state }, 200, origin);
  } catch (e) {
    if (e instanceof ChatError) {
      const status = e.code === "LIMITE" ? 429 : e.code === "NAO_ENCONTRADO" ? 404 : e.code === "CONSENTIMENTO" ? 422 : 400;
      return json({ ok: false, error: e.code.toLowerCase(), message: e.message }, status, origin);
    }
    console.error("[chat] send", e);
    return json({ ok: false, error: "erro_interno" }, 500, origin);
  }
}
