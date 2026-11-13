import { MockBrain, type Brain } from "@/server/agent/brain";
import { ClaudeBrain } from "@/server/agent/claude-brain";

let cached: Brain | null = null;

// Com chave de IA (.env) usa IA; sem ela, as regras simuladas. O worker troca o cérebro quando o admin
// muda a configuração no painel (veja llm-runtime.ts).
export function getBrain(): Brain {
  cached ??= ClaudeBrain.fromEnv() ?? new MockBrain();
  return cached;
}

export function setBrain(brain: Brain) {
  cached = brain;
}
