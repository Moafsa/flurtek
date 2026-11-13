// Configuração da IA feita no painel do admin. A chave do OpenRouter fica criptografada no banco
// (AES-256-GCM, chave APP_ENCRYPTION_KEY) e nunca volta para a tela: só um resumo ("sk-or-…ab12").
// Valores do painel valem acima do .env; o .env continua como plano B.
import { writeAudit } from "@/server/audit";
import { db } from "@/lib/db";
import { open, seal, type Sealed } from "@/server/crypto";
import { can } from "@/server/rbac";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { getSetting } from "@/server/settings";
import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_OWNER_MODEL, llmFromEnv, providerFromEnv } from "@/server/agent/llm";

export const AI_CONFIG_KEY = "ai.config";
export const PROVIDERS = ["auto", "openrouter", "anthropic", "mock"] as const;
export type ProviderChoice = (typeof PROVIDERS)[number];

type Stored = {
  provider: ProviderChoice;
  key: Sealed | null;
  keyHint: string | null;
  model: string;
  ownerModel: string;
  dataCollection: "allow" | "deny";
  updatedAt: string;
  updatedBy: string;
};

export type AiConfigView = {
  provider: ProviderChoice;
  hasKey: boolean;
  keyHint: string | null;
  keySource: "painel" | "env" | "nenhuma";
  model: string;
  ownerModel: string;
  dataCollection: "allow" | "deny";
  updatedAt: Date | null;
  effective: { provider: "openrouter" | "anthropic" | "mock"; model: string | null; ownerModel: string | null };
  keyError: string | null;
};

const MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

function need(actor: Actor) {
  if (!can(actor.role, "agent:configure")) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
}

// "sk-or-v1-abcdef...wxyz" -> "sk-or-v1-…wxyz"
export function hintOf(key: string): string {
  return `${key.slice(0, Math.min(9, key.length - 4))}…${key.slice(-4)}`;
}

const stored = () => getSetting<Stored | null>(AI_CONFIG_KEY, null);

export type SaveInput = { provider: string; apiKey?: string; model?: string; ownerModel?: string; dataCollection?: string };

export async function saveAiConfig(actor: Actor, input: SaveInput): Promise<void> {
  need(actor);
  if (!(PROVIDERS as readonly string[]).includes(input.provider)) throw new ServiceError("INVALIDO", "Escolha um provedor válido.");
  const model = (input.model ?? "").trim();
  const ownerModel = (input.ownerModel ?? "").trim();
  for (const [label, m] of [["do atendimento", model], ["do dono", ownerModel]] as const) {
    if (m && !MODEL_RE.test(m)) throw new ServiceError("INVALIDO", `Modelo ${label} inválido. Use o formato do OpenRouter, como anthropic/claude-sonnet-4.5.`);
  }
  const apiKey = (input.apiKey ?? "").trim();
  if (apiKey && (!apiKey.startsWith("sk-or-") || apiKey.length < 24 || /\s/.test(apiKey))) {
    throw new ServiceError("INVALIDO", "Essa não parece uma chave do OpenRouter (ela começa com sk-or-).");
  }
  const before = await stored();
  const key = apiKey ? seal(apiKey) : (before?.key ?? null);
  const next: Stored = {
    provider: input.provider as ProviderChoice,
    key,
    keyHint: apiKey ? hintOf(apiKey) : (before?.keyHint ?? null),
    model,
    ownerModel,
    dataCollection: input.dataCollection === "allow" ? "allow" : "deny",
    updatedAt: new Date().toISOString(),
    updatedBy: actor.id,
  };
  await db.setting.upsert({ where: { key: AI_CONFIG_KEY }, update: { value: next as never, updatedById: actor.id }, create: { key: AI_CONFIG_KEY, value: next as never, updatedById: actor.id } });
  await writeAudit({
    action: "agente.ia_configurada",
    actorId: actor.id,
    entity: "Setting",
    entityId: AI_CONFIG_KEY,
    meta: { provedor: next.provider, chaveNova: Boolean(apiKey), modelo: model || null, modeloDono: ownerModel || null, coletaDeDados: next.dataCollection },
  });
}

export async function removeAiKey(actor: Actor): Promise<void> {
  need(actor);
  const before = await stored();
  if (!before) return;
  await db.setting.update({ where: { key: AI_CONFIG_KEY }, data: { value: { ...before, key: null, keyHint: null, updatedAt: new Date().toISOString(), updatedBy: actor.id } as never, updatedById: actor.id } });
  await writeAudit({ action: "agente.ia_chave_removida", actorId: actor.id, entity: "Setting", entityId: AI_CONFIG_KEY });
}

type EnvLike = Record<string, string | undefined>;

// Variáveis efetivas: o que está no painel vence o .env.
export async function resolveAiEnv(base: EnvLike = process.env): Promise<EnvLike> {
  const s = await stored();
  if (!s) return base;
  const env: EnvLike = { ...base, LLM_PROVIDER: s.provider };
  if (s.key) env.OPENROUTER_API_KEY = open(s.key).toString("utf8");
  if (s.model) env.OPENROUTER_MODEL = s.model;
  if (s.ownerModel) env.OPENROUTER_OWNER_MODEL = s.ownerModel;
  env.OPENROUTER_DATA_COLLECTION = s.dataCollection;
  return env;
}

export async function getAiConfig(base: EnvLike = process.env): Promise<AiConfigView> {
  const s = await stored();
  let env: EnvLike = base;
  let keyError: string | null = null;
  try {
    env = await resolveAiEnv(base);
  } catch (e) {
    keyError = e instanceof Error ? e.message : "Não foi possível abrir a chave guardada.";
    env = { ...base, LLM_PROVIDER: s?.provider ?? "auto" };
  }
  const provider = providerFromEnv(env);
  const hasPanelKey = Boolean(s?.key);
  return {
    provider: s?.provider ?? "auto",
    hasKey: hasPanelKey || Boolean(base.OPENROUTER_API_KEY),
    keyHint: s?.keyHint ?? (base.OPENROUTER_API_KEY ? hintOf(base.OPENROUTER_API_KEY) : null),
    keySource: hasPanelKey ? "painel" : base.OPENROUTER_API_KEY ? "env" : "nenhuma",
    model: s?.model ?? "",
    ownerModel: s?.ownerModel ?? "",
    dataCollection: s?.dataCollection ?? (base.OPENROUTER_DATA_COLLECTION === "allow" ? "allow" : "deny"),
    updatedAt: s ? new Date(s.updatedAt) : null,
    effective: {
      provider,
      model: provider === "openrouter" ? env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL : null,
      ownerModel: provider === "openrouter" ? env.OPENROUTER_OWNER_MODEL || DEFAULT_OPENROUTER_OWNER_MODEL : null,
    },
    keyError,
  };
}

export type AiTestResult = { ok: boolean; message: string; provider: string; model?: string; ms?: number };

// Faz uma chamada mínima (sem dados de cliente) para provar que a chave e o modelo funcionam.
export async function testAiConnection(actor: Actor, base: EnvLike = process.env): Promise<AiTestResult> {
  need(actor);
  let result: AiTestResult;
  try {
    const env = await resolveAiEnv(base);
    const llm = llmFromEnv("agent", env);
    if (!llm) {
      result = { ok: false, provider: "mock", message: "Modo simulado: nenhuma chave de IA configurada. O agente está usando regras simples." };
    } else {
      const t0 = Date.now();
      const res = await llm.client.messages.create({
        model: llm.model,
        max_tokens: 60,
        system: "Responda chamando a ferramenta ping com ok verdadeiro.",
        messages: [{ role: "user", content: "teste de conexão" }],
        tools: [{ name: "ping", description: "Confirma a conexão.", input_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }],
        tool_choice: { type: "tool", name: "ping" },
      } as never);
      const ms = Date.now() - t0;
      const used = (res as { content: { type: string }[] }).content.some((b) => b.type === "tool_use");
      result = used
        ? { ok: true, provider: llm.label, model: llm.model, ms, message: `Conexão ok com ${llm.label} (${llm.model}) em ${ms} ms.` }
        : { ok: false, provider: llm.label, model: llm.model, ms, message: "A chave funciona, mas o modelo não respondeu no formato de ferramentas. Escolha outro modelo." };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro desconhecido";
    result = { ok: false, provider: "erro", message: `Falha no teste: ${msg}`.replace(/sk-or-[\w-]+/g, "[chave]").slice(0, 300) };
  }
  await writeAudit({ action: "agente.ia_testada", actorId: actor.id, meta: { ok: result.ok, provedor: result.provider, modelo: result.model ?? null, ms: result.ms ?? null } });
  return result;
}
