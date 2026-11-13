// Processo em segundo plano: a cada poucos segundos envia o que já foi aprovado.
// Roda como serviço separado (docker compose: worker).
import { runAgentCycle } from "@/server/agent/operation";
import { getBrain } from "@/server/agent/brain-select";
import { refreshLlm } from "@/server/agent/llm-runtime";
import { processOwnerConversations, runDailySummary } from "@/server/owner/handler";
import { runExecutor } from "@/server/channels/executor";
import { getChannel } from "@/server/channels";
import { markOverdue } from "@/server/finance/service";
import { runDunning } from "@/server/finance/dunning";

const EVERY_MS = Number(process.env.EXECUTOR_INTERVAL_MS ?? 5000);
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // A IA configurada no painel vale já neste ciclo, sem reiniciar o worker.
    const llm = await refreshLlm();
    if (llm.changed) console.log(`[ia] cérebro do agente: ${llm.brain}`);
    const a = await runAgentCycle();
    if (Object.values(a).some((v) => typeof v === "number" && v > 0)) console.log("[agente]", JSON.stringify(a));
    const o = await processOwnerConversations();
    const d = await runDailySummary();
    if (o || d) console.log("[gabinete]", JSON.stringify({ respostas: o, resumos: d }));
    const v = await markOverdue();
    const l = v ? await runDunning() : 0;
    if (v || l) console.log("[financeiro]", JSON.stringify({ vencidas: v, lembretes: l }));
    const r = await runExecutor();
    if (r.teamSent || r.teamFailed || r.actionsSent || r.actionsFailed || r.ownerSent) console.log("[executor]", JSON.stringify(r));
  } catch (e) {
    console.error("[executor] erro", e);
  } finally {
    busy = false;
  }
}

console.log(`[worker] iniciado. canal=${getChannel().name} cérebro=${getBrain().name} intervalo=${EVERY_MS}ms`);
setInterval(tick, EVERY_MS);
void tick();
