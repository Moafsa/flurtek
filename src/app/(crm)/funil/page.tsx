import type { Metadata } from "next";
import Link from "next/link";
import { BOARD_STAGES, EXTRA_STAGES, TEMPERATURES, TEMPERATURE_LABEL } from "@/lib/crm-constants";
import { UF_LIST } from "@/lib/validators";
import { can } from "@/server/rbac";
import { requirePermission } from "@/server/session";
import { listLeads, listSegments, type LeadFilters } from "@/server/leads/service";
import { Board, type BoardLead } from "./board";

export const metadata: Metadata = { title: "Funil de vendas" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function FunilPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePermission("lead:read");
  const sp = await searchParams;
  const filters: LeadFilters = {
    q: one(sp.q),
    temperature: one(sp.temperatura),
    owner: (one(sp.responsavel) || undefined) as LeadFilters["owner"],
    uf: one(sp.uf),
    segment: one(sp.segmento),
    includeClosed: one(sp.encerrados) === "1",
  };

  const [rows, segments] = await Promise.all([listLeads(user, filters), listSegments(user)]);
  const leads: BoardLead[] = rows.map((l) => ({
    id: l.id,
    title: l.title,
    uf: l.uf,
    city: l.city,
    segment: l.company?.segment ?? null,
    product: l.product,
    volume: l.volume,
    value: Number(l.estimatedValue ?? 0),
    score: l.score,
    temperature: l.temperature,
    stage: l.stage,
    ownerName: l.owner?.name ?? null,
    agentOwned: l.agentOwned,
    nextAction: l.nextAction,
    updatedAt: l.updatedAt.toISOString(),
  }));

  const stages = filters.includeClosed ? [...BOARD_STAGES, ...EXTRA_STAGES] : BOARD_STAGES;
  const hasFilter = Boolean(filters.q || filters.temperature || filters.owner || filters.uf || filters.segment || filters.includeClosed);
  const select = "min-h-10 rounded-lg border border-line bg-white px-2.5 text-sm";

  return (
    <main>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">Funil de vendas</h1>
        <span className="text-sm text-muted">{leads.length} lead(s)</span>
        {can(user.role, "lead:write") ? (
          <Link href="/leads/novo" className="ml-auto min-h-10 rounded-lg bg-lime px-4 py-2 font-display text-sm font-semibold text-on-lime hover:bg-lime-dark">
            + Novo lead
          </Link>
        ) : null}
      </div>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2.5" aria-label="Filtros">
        <label className="grid gap-1 text-xs font-semibold text-muted">
          Buscar
          <input name="q" defaultValue={filters.q} placeholder="Empresa, produto ou cidade" className={`${select} w-56`} />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted">
          Segmento
          <select name="segmento" defaultValue={filters.segment} className={select}>
            <option value="">Todos</option>
            {segments.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted">
          Temperatura
          <select name="temperatura" defaultValue={filters.temperature} className={select}>
            <option value="">Todas</option>
            {TEMPERATURES.map((t) => (
              <option key={t} value={t}>
                {TEMPERATURE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted">
          Responsável
          <select name="responsavel" defaultValue={filters.owner ?? ""} className={select}>
            <option value="">Todos</option>
            <option value="meus">Meus leads</option>
            <option value="agente">Agente IA</option>
            <option value="equipe">Equipe</option>
            <option value="sem">Sem responsável</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-muted">
          Estado
          <select name="uf" defaultValue={filters.uf} className={select}>
            <option value="">Todos</option>
            {UF_LIST.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input type="checkbox" name="encerrados" value="1" defaultChecked={filters.includeClosed} />
          Mostrar perdidos e frios
        </label>
        <button className="min-h-10 rounded-lg bg-graphite px-4 text-sm font-semibold text-white">Filtrar</button>
        {hasFilter ? (
          <Link href="/funil" className="min-h-10 px-2 py-2 text-sm text-muted underline">
            Limpar
          </Link>
        ) : null}
      </form>

      <div className="mt-5">
        <Board leads={leads} stages={stages} canMove={can(user.role, "lead:move")} />
      </div>
    </main>
  );
}
