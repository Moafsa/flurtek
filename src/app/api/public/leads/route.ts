import { timingSafeEqual } from "node:crypto";
import { intakeSchema } from "@/server/intake/schema";
import { processIntake } from "@/server/intake/service";
import { allow } from "@/server/ratelimit";

export const dynamic = "force-dynamic";

const MAX_BODY = 20_000;

function allowedOrigins(): string[] {
  return (process.env.INTAKE_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function cors(origin: string | null): Record<string, string> {
  const ok = origin && allowedOrigins().includes(origin);
  return ok
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-site-key",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
    : { Vary: "Origin" };
}

function json(body: unknown, status: number, origin: string | null) {
  return Response.json(body, { status, headers: { ...cors(origin), "Cache-Control": "no-store" } });
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: origin && allowedOrigins().includes(origin) ? 204 : 403, headers: cors(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) return json({ ok: false, error: "origem_nao_permitida" }, 403, null);

  const siteKey = process.env.INTAKE_SITE_KEY;
  const given = req.headers.get("x-site-key") ?? "";
  if (!siteKey || !sameKey(given, siteKey)) return json({ ok: false, error: "chave_invalida" }, 401, origin);

  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "desconhecido").trim();
  if (!allow(`intake:min:${ip}`, 8, 60_000) || !allow(`intake:hour:${ip}`, 60, 3_600_000)) {
    return json({ ok: false, error: "muitas_requisicoes" }, 429, origin);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "corpo_grande_demais" }, 413, origin);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "json_invalido" }, 400, origin);
  }

  // Campo-isca preenchido: é robô. Respondemos como se tivesse dado certo e não gravamos nada.
  if (typeof data === "object" && data !== null && "website" in data && String((data as { website: unknown }).website ?? "").trim() !== "") {
    return json({ ok: true, reference: "00000000" }, 201, origin);
  }

  const parsed = intakeSchema.safeParse(data);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[String(i.path[0] ?? "form")] ??= i.message;
    return json({ ok: false, error: "dados_invalidos", fields }, 422, origin);
  }

  try {
    const result = await processIntake(parsed.data, { ip });
    return json(result, result.created ? 201 : 200, origin);
  } catch (error) {
    console.error("[intake]", error);
    return json({ ok: false, error: "erro_interno" }, 500, origin);
  }
}
