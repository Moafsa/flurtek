import type { Metadata } from "next";
import Link from "next/link";
import { brl } from "@/lib/format";
import { SOURCE_LABEL, type SourceName } from "@/lib/crm-constants";
import { requirePermission } from "@/server/session";
import { buildReport, PERIODS, type Period } from "@/server/owner/report";

export const metadata: Metadata = { title: "Relatórios" };
export const dynamic = "force-dynamic";

const LABEL: Record<Period, string> = { hoje: "Hoje", ontem: "Ontem", semana: "7 dias", mes: "Mês" };

export default async function RelatoriosPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  await requirePermission("report:read");
  const { p } = await searchParams;
  const period: Period = (PERIODS as readonly string[]).includes(p ?? "") ? (p as Period) : "hoje";
  const r = await buildReport(period);

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Relatórios</h1>
      <p className="mb-4 mt-1 text-sm text-muted">Os mesmos números que o agente envia ao dono pelo WhatsApp. Período: {r.label}.</p>

      <nav aria-label="Período" className="mb-5 flex flex-wrap gap-1.5">
        {PERIODS.map((x) => (
          <Link key={x} href={`/relatorios?p=${x}`} aria-current={x === period ? "page" : undefined} className={`min-h-10 rounded-full border px-4 py-2 text-sm font-semibold ${x === period ? "border-graphite bg-graphite text-white" : "border-line bg-white"}`}>
            {LABEL[x]}
          </Link>
        ))}
      </nav>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Resumo">
        <Card label="Leads novos" value={String(r.newLeads)} sub={r.bySource.map((s) => `${SOURCE_LABEL[s.source as SourceName] ?? s.source} ${s.n}`).join(" · ") || "—"} />
        <Card label="Cotações enviadas" value={String(r.quotes)} sub="leads que entraram em cotação" />
        <Card label="Fechados" value={String(r.won.n)} sub={r.won.n ? `${brl(r.won.value)} por mês` : "—"} />
        <Card label="Perdidos" value={String(r.lost)} sub="no período" />
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="rounded-2xl border border-line bg-card p-5" aria-label="Funil agora">
          <h2 className="font-display text-base font-bold">Funil agora</h2>
          <p className="mt-2 text-sm">
            <b className="font-display text-2xl">{r.pipeline.n}</b> leads em aberto · <b>{brl(r.pipeline.value)}</b> por mês
          </p>
          <p className="mt-3 text-sm text-muted">
            {r.stuck.n ? (
              <>
                Parados há 3+ dias: <b className="text-ink">{r.stuck.n}</b> ({r.stuck.names.join(", ")}
                {r.stuck.n > r.stuck.names.length ? "…" : ""})
              </>
            ) : (
              "Nenhum lead parado há 3+ dias."
            )}
          </p>
          {r.byUf.length ? <p className="mt-3 text-sm text-muted">Estados com mais leads novos: {r.byUf.map((u) => `${u.uf} (${u.n})`).join(", ")}</p> : null}
        </section>

        <section className="rounded-2xl border border-line bg-card p-5" aria-label="Agente">
          <h2 className="font-display text-base font-bold">Agente de IA</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <Stat label="Mensagens enviadas" value={r.agent.sent} />
            <Stat label="Enviadas sozinho" value={r.agent.autoSent} />
            <Stat label="Escaladas para pessoas" value={r.agent.escalations} />
            <Stat label="Rejeitadas" value={r.agent.rejected} />
            <Stat label="Falharam" value={r.agent.failed} />
            <Stat label="Aguardando aprovação agora" value={r.agent.pendingNow} />
          </dl>
        </section>
      </div>
    </main>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-display text-3xl font-extrabold tracking-tight">{value}</p>
      <p className="mt-1 text-xs text-muted">{sub}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-display text-xl font-bold">{value}</dd>
    </div>
  );
}
