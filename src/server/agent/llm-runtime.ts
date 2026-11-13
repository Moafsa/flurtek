// Mantém o cérebro do agente em dia com o que o admin configurou no painel, sem reiniciar nada.
// O worker chama refreshLlm() a cada ciclo: uma leitura barata, e só reconstrói quando algo mudou.
import { createHash } from "node:crypto";
import { MockBrain } from "@/server/agent/brain";
import { setBrain } from "@/server/agent/brain-select";
import { ClaudeBrain } from "@/server/agent/claude-brain";
import { resolveAiEnv } from "@/server/agent/ai-config";
import { llmFromEnv, providerFromEnv } from "@/server/agent/llm";
import { ClaudeOwnerBrain, MockOwnerBrain, setOwnerBrain } from "@/server/owner/intents";

let signature = "";

export async function refreshLlm(): Promise<{ changed: boolean; brain: string }> {
  let env;
  try {
    env = await resolveAiEnv();
  } catch (e) {
    // Chave guardada que não abre (APP_ENCRYPTION_KEY mudou): não derruba o worker, cai para o .env.
    if (signature !== "erro") console.error("[ia] configuração do painel indisponível:", e instanceof Error ? e.message : e);
    signature = "erro";
    env = process.env;
  }
  const provider = providerFromEnv(env);
  const sig = createHash("sha256")
    .update([provider, env.OPENROUTER_API_KEY ?? "", env.ANTHROPIC_API_KEY ?? "", env.OPENROUTER_MODEL ?? "", env.OPENROUTER_OWNER_MODEL ?? "", env.AGENT_MODEL ?? "", env.OWNER_MODEL ?? "", env.OPENROUTER_DATA_COLLECTION ?? ""].join("|"))
    .digest("hex");
  const agent = llmFromEnv("agent", env);
  const owner = llmFromEnv("owner", env);
  const name = agent ? `${agent.label}:${agent.model}` : "regras";
  if (sig === signature) return { changed: false, brain: name };
  signature = sig;
  setBrain(agent ? new ClaudeBrain(agent.client, agent.model, agent.label) : new MockBrain());
  setOwnerBrain(owner ? new ClaudeOwnerBrain(owner.client, owner.model, undefined, owner.label) : new MockOwnerBrain());
  return { changed: true, brain: name };
}

export function resetLlmRuntimeForTests() {
  signature = "";
}
