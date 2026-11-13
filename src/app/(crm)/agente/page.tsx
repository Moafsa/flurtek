import type { Metadata } from "next";
import Link from "next/link";
import { ago } from "@/lib/format";
import { can } from "@/server/rbac";
import { requirePermission } from "@/server/session";
import { listPendingActions, listPolicies, listRecentActions } from "@/server/agent/service";
import { isAgentEnabled } from "@/server/settings";
import { ApprovalCard, PolicySelect } from "./controls";

export const metadata: Metadata = { title: "Agente IA" };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "aprovacoes", label: "Aprovações" },
  { key: "autonomia", label: "Autonomia" },
  { key: "registro", label: "Registro" },
] as const;

const STATUS: Record<string, { label: string; cls: string }> = {
  APROVADA: { label: "aprovada", cls: "bg-ok-bg text-ok" },
  REJEITADA: { label: "rejeitada", cls: "bg-bad-bg text-bad" },
  EXECUTADA: { label: "enviada", cls: "bg-ok-bg text-ok" },
  FALHOU: { label: "falhou", cls: "bg-bad-bg text-bad" },
};

export default async function AgentePage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const user = await requirePermission("agent:review");
  const { aba } = await searchParams;
  const tab = TABS.some((t) => t.key === aba) ? aba! : "aprovacoes";
  const [pending, enabled] = await Promise.all([listPendingActions(user), isAgentEnabled()]);

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Agente IA</h1>
      <p className="mb-4 mt-1 text-sm text-muted">O que o agente propõe, o que ele pode fazer sozinho e tudo o que já fez.</p>

      {!enabled ? (
        <p role="status" className="mb-4 rounded-lg bg-bad-bg px-4 py-3 text-sm text-bad">
          O agente está pausado pela chave geral. Nenhuma ação automática será executada até ele ser retomado.
        </p>
      ) : null}

      <nav aria-label="Seções" className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/agente?aba=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={`min-h-10 rounded-full border px-4 py-2 text-sm font-semibold ${tab === t.key ? "border-graphite bg-graphite text-white" : "border-line bg-white"}`}
          >
            {t.label}
            {t.key === "aprovacoes" && pending.length ? <span className="ml-2 rounded-full bg-lime px-2 text-xs text-on-lime">{pending.length}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "aprovacoes" ? (
        pending.length ? (
          <ul className="grid gap-3">
            {pending.map((a) => (
              <ApprovalCard key={a.id} id={a.id} kind={a.kind} leadTitle={a.lead?.title ?? "—"} confidence={a.confidence} reason={a.reason} draft={a.draft ?? ""} needsTemplate={Boolean((a.output as { needsTemplate?: boolean } | null)?.needsTemplate)} />
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border-2 border-dashed border-line p-10 text-center text-muted">
            <b>Nada aguardando aprovação.</b>
            <br />O agente continua trabalhando nas tarefas automáticas.
          </p>
        )
      ) : null}

      {tab === "aprovacoes" && pending.length ? (
        <p className="mt-3 text-xs text-muted">Aprovar marca a mensagem como pronta para envio. O envio real passa a acontecer quando o canal de WhatsApp for conectado.</p>
      ) : null}

      {tab === "autonomia" ? <Autonomia canEdit={can(user.role, "agent:configure")} user={user} /> : null}
      {tab === "registro" ? <Registro user={user} /> : null}
    </main>
  );
}

async function Autonomia({ canEdit, user }: { canEdit: boolean; user: Parameters<typeof listPolicies>[0] }) {
  const policies = await listPolicies(user);
  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <h2 className="font-display text-base font-bold">O que o agente pode fazer sozinho</h2>
      <p className="mb-2 text-sm text-muted">
        Defina o nível de cada tarefa. Preço e desconto nunca podem ser automáticos. {canEdit ? "" : "Só o administrador altera."}
      </p>
      {policies.map((p) => (
        <PolicySelect key={p.task} task={p.task} label={p.label} level={p.level} editable={canEdit} />
      ))}
    </section>
  );
}

async function Registro({ user }: { user: Parameters<typeof listRecentActions>[0] }) {
  const rows = await listRecentActions(user);
  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <h2 className="font-display text-base font-bold">Registro do agente</h2>
      <p className="mb-2 text-sm text-muted">Cada sugestão decidida, com quem decidiu e quando.</p>
      {rows.length ? (
        <ul>
          {rows.map((a) => {
            const s = STATUS[a.status] ?? { label: a.status.toLowerCase(), cls: "bg-soft" };
            return (
              <li key={a.id} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 border-t border-line py-3 text-sm first:border-t-0">
                <time className="text-xs text-muted">{ago(a.decidedAt ?? a.createdAt)}</time>
                <div>
                  <p>
                    <b>{a.kind.replaceAll("_", " ")}</b> · {a.lead?.title ?? "—"} <span className={`ml-1 rounded-full px-2 py-0.5 font-display text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
                  </p>
                  <p className="text-xs text-muted">{a.decidedBy ? `Decidido por ${a.decidedBy.name}` : a.status === "APROVADA" || a.status === "EXECUTADA" || a.status === "FALHOU" ? "Automático, pela política de autonomia" : "Sem decisão registrada"}{a.error ? ` · ${a.error.slice(0, 120)}` : ""}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nenhuma sugestão decidida ainda.</p>
      )}
    </section>
  );
}
