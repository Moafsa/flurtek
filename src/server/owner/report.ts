// Relatórios para o dono (WhatsApp e tela). Só leitura. Datas no fuso de São Paulo.
import { db } from "@/lib/db";
import { brl } from "@/lib/format";
import { SOURCE_LABEL, type SourceName } from "@/lib/crm-constants";

export const PERIODS = ["hoje", "ontem", "semana", "mes"] as const;
export type Period = (typeof PERIODS)[number];
const TZ = "America/Sao_Paulo";
const DAY = 86_400_000;

// Início do dia em São Paulo (UTC-3 o ano todo desde 2019).
function startOfDaySP(d: Date): Date {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d).split("-").map(Number);
  return new Date(Date.UTC(p[0]!, p[1]! - 1, p[2]!, 3, 0, 0));
}

export function periodRange(period: Period, now = new Date()): { from: Date; to: Date; label: string } {
  const today = startOfDaySP(now);
  const fmt = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
  switch (period) {
    case "hoje":
      return { from: today, to: now, label: `hoje (${fmt(today)})` };
    case "ontem": {
      const from = new Date(today.getTime() - DAY);
      return { from, to: today, label: `ontem (${fmt(from)})` };
    }
    case "semana": {
      const from = new Date(today.getTime() - 6 * DAY);
      return { from, to: now, label: `últimos 7 dias (${fmt(from)} a ${fmt(today)})` };
    }
    case "mes": {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(now).split("-").map(Number);
      const from = new Date(Date.UTC(p[0]!, p[1]! - 1, 1, 3, 0, 0));
      return { from, to: now, label: `mês (desde ${fmt(from)})` };
    }
  }
}

export type Report = {
  period: Period;
  label: string;
  newLeads: number;
  bySource: { source: string; n: number }[];
  byUf: { uf: string; n: number }[];
  quotes: number;
  won: { n: number; value: number };
  lost: number;
  pipeline: { n: number; value: number };
  stuck: { n: number; names: string[] };
  agent: { sent: number; autoSent: number; rejected: number; failed: number; pendingNow: number; escalations: number };
  conversations: { unread: number; withTeam: number };
};

const OPEN = ["NOVO", "QUALIFICADO", "COTACAO", "NEGOCIACAO"] as const;

export async function buildReport(period: Period, now = new Date()): Promise<Report> {
  const { from, to, label } = periodRange(period, now);
  const range = { gte: from, lt: to };
  const stuckBefore = new Date(now.getTime() - 3 * DAY);

  const [created, quoteEvents, wonEvents, lostEvents, open, stuck, actions, pendingNow, escalations, unread, withTeam] = await Promise.all([
    db.lead.findMany({ where: { createdAt: range }, select: { source: true, uf: true } }),
    db.leadEvent.findMany({ where: { kind: "etapa", createdAt: range, meta: { path: ["to"], equals: "COTACAO" } }, select: { leadId: true } }),
    db.leadEvent.findMany({ where: { kind: "etapa", createdAt: range, meta: { path: ["to"], equals: "FECHADO" } }, select: { leadId: true } }),
    db.leadEvent.findMany({ where: { kind: "etapa", createdAt: range, meta: { path: ["to"], equals: "PERDIDO" } }, select: { leadId: true } }),
    db.lead.aggregate({ where: { stage: { in: [...OPEN] } }, _count: { _all: true }, _sum: { estimatedValue: true } }),
    db.lead.findMany({
      where: { stage: { in: [...OPEN] }, OR: [{ lastContactAt: { lt: stuckBefore } }, { lastContactAt: null, createdAt: { lt: stuckBefore } }] },
      select: { title: true },
      orderBy: { estimatedValue: "desc" },
    }),
    db.agentAction.findMany({ where: { createdAt: range }, select: { status: true, decidedById: true } }),
    db.agentAction.count({ where: { status: "PENDENTE" } }),
    db.leadEvent.count({ where: { actorType: "AGENTE", kind: "agente", text: { startsWith: "Escalou" }, createdAt: range } }),
    db.conversation.aggregate({ _sum: { unread: true }, where: { kind: "CLIENTE" } }),
    db.conversation.count({ where: { kind: "CLIENTE", mode: "HUMANO" } }),
  ]);

  const tally = (rows: (string | null)[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r) m.set(r, (m.get(r) ?? 0) + 1);
    return [...m].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
  };
  const uniq = (rows: { leadId: string }[]) => [...new Set(rows.map((r) => r.leadId))];
  const wonIds = uniq(wonEvents);
  const wonValue = wonIds.length ? (await db.lead.aggregate({ where: { id: { in: wonIds } }, _sum: { estimatedValue: true } }))._sum.estimatedValue : null;

  return {
    period,
    label,
    newLeads: created.length,
    bySource: tally(created.map((l) => l.source)).slice(0, 4).map((x) => ({ source: x.k, n: x.n })),
    byUf: tally(created.map((l) => l.uf)).slice(0, 3).map((x) => ({ uf: x.k, n: x.n })),
    quotes: uniq(quoteEvents).length,
    won: { n: wonIds.length, value: Number(wonValue ?? 0) },
    lost: uniq(lostEvents).length,
    pipeline: { n: open._count._all, value: Number(open._sum.estimatedValue ?? 0) },
    stuck: { n: stuck.length, names: stuck.slice(0, 3).map((s) => s.title) },
    agent: {
      sent: actions.filter((a) => a.status === "EXECUTADA").length,
      autoSent: actions.filter((a) => a.status === "EXECUTADA" && !a.decidedById).length,
      rejected: actions.filter((a) => a.status === "REJEITADA").length,
      failed: actions.filter((a) => a.status === "FALHOU").length,
      pendingNow,
      escalations,
    },
    conversations: { unread: unread._sum.unread ?? 0, withTeam },
  };
}

// Texto para WhatsApp: curto, sem tabela, com *negrito*.
export function formatReport(r: Report): string {
  const src = r.bySource.length ? ` (${r.bySource.map((s) => `${SOURCE_LABEL[s.source as SourceName]?.toLowerCase() ?? s.source.toLowerCase()} ${s.n}`).join(", ")})` : "";
  const lines = [
    `*Relatório: ${r.label}*`,
    `Leads novos: ${r.newLeads}${r.newLeads ? src : ""}`,
    r.byUf.length ? `Estados: ${r.byUf.map((u) => `${u.uf} ${u.n}`).join(", ")}` : null,
    `Cotações enviadas: ${r.quotes} · Fechados: ${r.won.n}${r.won.n ? ` (${brl(r.won.value)}/mês)` : ""} · Perdidos: ${r.lost}`,
    `Funil agora: ${r.pipeline.n} leads em aberto · ${brl(r.pipeline.value)}/mês`,
    r.stuck.n ? `Parados há 3+ dias: ${r.stuck.n} (${r.stuck.names.join(", ")}${r.stuck.n > r.stuck.names.length ? "…" : ""})` : "Nenhum lead parado há 3+ dias.",
    `Agente: ${r.agent.sent} mensagens enviadas (${r.agent.autoSent} sozinho), ${r.agent.escalations} escaladas${r.agent.failed ? `, ${r.agent.failed} falharam` : ""}`,
    r.agent.pendingNow ? `Aguardando você: ${r.agent.pendingNow}. Responda PENDÊNCIAS para ver.` : "Nada aguardando aprovação.",
    r.conversations.withTeam ? `Conversas com a equipe: ${r.conversations.withTeam}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}
