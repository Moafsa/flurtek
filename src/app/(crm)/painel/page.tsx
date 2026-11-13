import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { BOARD_STAGES, STAGE_LABEL } from "@/lib/crm-constants";
import { ago, brl, daysAgo } from "@/lib/format";
import { can } from "@/server/rbac";
import { leadScope } from "@/server/leads/rules";
import { requirePermission } from "@/server/session";

export const metadata: Metadata = { title: "Painel" };
export const dynamic = "force-dynamic";

const OPEN = ["NOVO", "QUALIFICADO", "COTACAO", "NEGOCIACAO"] as const;

export default async function PainelPage({ searchParams }: { searchParams: Promise<{ negado?: string }> }) {
  const user = await requirePermission("lead:read");
  const { negado } = await searchParams;
  const scope = leadScope(user);
  const canAgent = can(user.role, "agent:review");

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);
  const staleBefore = daysAgo(3);

  const [groups, newToday, closedMonth, pending, stale, human, feed] = await Promise.all([
    db.lead.groupBy({ by: ["stage"], where: scope, _count: { _all: true }, _sum: { estimatedValue: true } }),
    db.lead.count({ where: { AND: [scope, { createdAt: { gte: startOfDay } }] } }),
    db.lead.aggregate({ where: { AND: [scope, { stage: "FECHADO", updatedAt: { gte: startOfMonth } }] }, _sum: { estimatedValue: true } }),
    canAgent ? db.agentAction.count({ where: { status: "PENDENTE" } }) : 0,
    db.lead.count({
      where: {
        AND: [
          scope,
          { stage: { in: [...OPEN] } },
          { OR: [{ lastContactAt: { lt: staleBefore } }, { lastContactAt: null, createdAt: { lt: staleBefore } }] },
        ],
      },
    }),
    can(user.role, "conversation:read") ? db.conversation.count({ where: { mode: "HUMANO" } }) : 0,
    db.leadEvent.findMany({
      where: { actorType: "AGENTE", lead: scope },
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { lead: { select: { id: true, title: true } } },
    }),
  ]);

  const by = new Map(groups.map((g) => [g.stage, g]));
  const count = (s: string) => by.get(s as never)?._count._all ?? 0;
  const sum = (s: string) => Number(by.get(s as never)?._sum.estimatedValue ?? 0);
  const open = OPEN.reduce((n, s) => n + count(s), 0);
  const pipeline = OPEN.reduce((n, s) => n + sum(s), 0);
  const max = Math.max(1, ...BOARD_STAGES.map(count));

  const attention = [
    ...(canAgent ? [{ label: "Aprovações pendentes do agente", n: pending, href: "/agente" }] : []),
    { label: "Leads parados há 3+ dias", n: stale, href: "/funil" },
    ...(can(user.role, "conversation:read") ? [{ label: "Conversas assumidas pela equipe", n: human, href: "/conversas" }] : []),
  ];

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Painel</h1>
      <p className="mt-1 text-sm text-muted">Olá, {user.name.split(" ")[0]}. Resumo da operação.</p>

      {negado ? (
        <p role="alert" className="mt-4 rounded-lg bg-warn-bg px-4 py-3 text-sm text-warn">
          Seu papel não tem permissão para abrir essa página.
        </p>
      ) : null}

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores">
        <Kpi label="Leads em aberto" value={String(open)} chip={newToday ? `+${newToday} hoje` : "nenhum novo hoje"} />
        <Kpi label="Valor no funil / mês" value={brl(pipeline)} chip="estimado" />
        <Kpi label="Aprovações do agente" value={canAgent ? String(pending) : "—"} chip={pending ? "aguardando você" : "em dia"} warn={pending > 0} />
        <Kpi label="Fechado no mês" value={brl(Number(closedMonth._sum.estimatedValue ?? 0))} chip="estimado" />
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section className="rounded-2xl border border-line bg-card p-5" aria-label="Funil">
          <h2 className="font-display text-base font-bold">Funil de vendas</h2>
          <p className="mb-4 text-sm text-muted">Leads por etapa e valor estimado mensal.</p>
          <ul className="grid gap-3">
            {BOARD_STAGES.map((s) => (
              <li key={s} className="grid grid-cols-[120px_minmax(0,1fr)_100px] items-center gap-3 text-sm">
                <span>{STAGE_LABEL[s]}</span>
                <span className="h-3 overflow-hidden rounded-full bg-soft">
                  <span className="block h-full rounded-full bg-gradient-to-r from-olive to-lime" style={{ width: `${(count(s) / max) * 100}%` }} />
                </span>
                <span className="text-right font-semibold">
                  {count(s)} · {sum(s) ? brl(sum(s)) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl border border-line bg-card p-5" aria-label="Atenção">
          <h2 className="font-display text-base font-bold">Precisa da sua atenção</h2>
          <p className="mb-2 text-sm text-muted">O agente resolve o resto sozinho.</p>
          <ul>
            {attention.map((a) => (
              <li key={a.label} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0">
                <span className="flex-1 text-sm">{a.label}</span>
                <span className={`rounded-full px-2.5 py-0.5 font-display text-xs font-bold ${a.n ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"}`}>{a.n}</span>
                <Link href={a.href} className="min-h-9 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold hover:border-olive">
                  Abrir
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-4 rounded-2xl border border-line bg-card p-5" aria-label="Atividade do agente">
        <h2 className="font-display text-base font-bold">Atividade do agente</h2>
        <p className="mb-2 text-sm text-muted">O que o agente fez, em ordem. Nada é apagado.</p>
        {feed.length ? (
          <ul>
            {feed.map((e) => (
              <li key={e.id} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 border-t border-line py-3 text-sm first:border-t-0">
                <time className="text-xs text-muted">{ago(e.createdAt)}</time>
                <div>
                  <p>{e.text}</p>
                  <Link href={`/leads/${e.lead.id}`} className="text-xs text-muted underline">
                    {e.lead.title}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Ainda não há atividade do agente.</p>
        )}
      </section>
    </main>
  );
}

function Kpi({ label, value, chip, warn }: { label: string; value: string; chip: string; warn?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-display text-3xl font-extrabold tracking-tight">{value}</p>
      <span className={`mt-2 inline-block rounded-full px-2.5 py-0.5 font-display text-xs font-semibold ${warn ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"}`}>{chip}</span>
    </div>
  );
}
