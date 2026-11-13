// Escolha do provedor de IA. O mesmo cliente serve ao agente de atendimento e ao agente do dono.
// LLM_PROVIDER = openrouter | anthropic | mock | auto (padrão): no auto, OpenRouter se houver chave, senão Anthropic.
import Anthropic from "@anthropic-ai/sdk";
import { OpenRouterClient } from "@/server/agent/openrouter";
import type { ClaudeLike } from "@/server/agent/claude-brain";

export type LlmKind = "agent" | "owner";
export type Llm = { client: ClaudeLike; model: string; label: string };

// Modelos padrão no OpenRouter. Troque por OPENROUTER_MODEL / OPENROUTER_OWNER_MODEL no .env quando quiser.
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";
export const DEFAULT_OPENROUTER_OWNER_MODEL = "anthropic/claude-haiku-4.5";

export function providerFromEnv(env: Record<string, string | undefined> = process.env): "openrouter" | "anthropic" | "mock" {
  const forced = (env.LLM_PROVIDER ?? "auto").toLowerCase();
  if (forced === "mock") return "mock";
  if (forced === "openrouter") return env.OPENROUTER_API_KEY ? "openrouter" : "mock";
  if (forced === "anthropic") return env.ANTHROPIC_API_KEY ? "anthropic" : "mock";
  if (env.OPENROUTER_API_KEY) return "openrouter";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return "mock";
}

export function llmFromEnv(kind: LlmKind, env: Record<string, string | undefined> = process.env): Llm | null {
  const provider = providerFromEnv(env);
  if (provider === "openrouter") {
    const model = (kind === "owner" ? env.OPENROUTER_OWNER_MODEL : env.OPENROUTER_MODEL) || (kind === "owner" ? DEFAULT_OPENROUTER_OWNER_MODEL : DEFAULT_OPENROUTER_MODEL);
    const client = new OpenRouterClient({
      apiKey: env.OPENROUTER_API_KEY!,
      referer: env.SITE_URL || undefined,
      dataCollection: env.OPENROUTER_DATA_COLLECTION === "allow" ? "allow" : "deny",
    });
    return { client: client as unknown as ClaudeLike, model, label: "openrouter" };
  }
  if (provider === "anthropic") {
    const model = (kind === "owner" ? env.OWNER_MODEL : env.AGENT_MODEL) || (kind === "owner" ? "claude-haiku-5-5" : "claude-sonnet-5-5");
    return { client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! }) as unknown as ClaudeLike, model, label: "claude" };
  }
  return null;
}
