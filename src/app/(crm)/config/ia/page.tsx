import type { Metadata } from "next";
import { dateTime } from "@/lib/format";
import { requirePermission } from "@/server/session";
import { getAiConfig } from "@/server/agent/ai-config";
import { DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_OWNER_MODEL } from "@/server/agent/llm";
import { IaForm } from "./ia-form";

export const metadata: Metadata = { title: "Inteligência artificial" };
export const dynamic = "force-dynamic";

const PROVIDER_LABEL = { openrouter: "OpenRouter", anthropic: "Anthropic", mock: "Desligada (regras simples)" } as const;

export default async function IaPage() {
  await requirePermission("agent:configure");
  const c = await getAiConfig();

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Inteligência artificial</h1>
      <p className="mb-4 mt-1 text-sm text-muted">A IA que atende no chat do site e no WhatsApp e entende as ordens do dono. Ela só propõe: preço, desconto e assuntos sensíveis continuam indo para uma pessoa.</p>

      <section className="mb-5 rounded-2xl border border-line bg-card p-4 text-sm" aria-label="Situação">
        <p>
          <b>Em uso agora:</b> {PROVIDER_LABEL[c.effective.provider]}
          {c.effective.model ? ` · atendimento: ${c.effective.model} · dono: ${c.effective.ownerModel}` : ""}
        </p>
        <p className="mt-1 text-muted">
          Chave: {c.hasKey ? `${c.keyHint} (${c.keySource === "painel" ? "guardada pelo painel" : "do arquivo .env"})` : "nenhuma"}
          {c.updatedAt ? ` · última alteração ${dateTime(c.updatedAt)}` : ""}
        </p>
        {c.keyError ? <p className="mt-1 text-bad">{c.keyError}</p> : null}
        {c.effective.provider === "mock" ? <p className="mt-1 text-warn">Sem chave de IA, o agente responde só com regras simples.</p> : null}
      </section>

      <section className="rounded-2xl border border-line bg-card p-5" aria-label="Configuração da IA">
        <IaForm
          v={{
            provider: c.provider,
            hasKey: c.hasKey,
            keyHint: c.keyHint,
            keySource: c.keySource,
            model: c.model,
            ownerModel: c.ownerModel,
            dataCollection: c.dataCollection,
            defaults: { model: DEFAULT_OPENROUTER_MODEL, ownerModel: DEFAULT_OPENROUTER_OWNER_MODEL },
          }}
        />
      </section>
    </main>
  );
}
