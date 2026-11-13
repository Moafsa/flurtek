import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EVENT_LABEL, SOURCE_LABEL, STAGE_LABEL, TEMPERATURE_LABEL, type SourceName, type StageName, type TemperatureName } from "@/lib/crm-constants";
import { ago, brl, dateOnly, dateTime, isPast } from "@/lib/format";
import { can } from "@/server/rbac";
import { requirePermission } from "@/server/session";
import { getLead, listAssignees } from "@/server/leads/service";
import { AssignControl, EditLeadForm, NoteForm, StageControl, TaskForm, TaskToggle } from "./controls";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Lead" };

const TEMP_STYLE: Record<TemperatureName, string> = {
  QUENTE: "bg-bad-bg text-bad",
  MORNO: "bg-warn-bg text-warn",
  FRIO: "bg-[#e4effa] text-[#0b5fa8]",
};

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("lead:read");
  const { id } = await params;
  const lead = await getLead(user, id);
  if (!lead) notFound();

  const assignees = await listAssignees();
  const canMove = can(user.role, "lead:move");
  const canWrite = can(user.role, "lead:write");
  const canNote = can(user.role, "lead:note");
  const canTask = can(user.role, "task:write");
  const ownerValue = lead.agentOwned ? "AGENTE" : (lead.ownerId ?? "");
  const openTasks = lead.tasks.filter((t) => t.status === "ABERTA");

  return (
    <main>
      <Link href="/funil" className="text-sm text-muted underline">
        ← Voltar ao funil
      </Link>

      <header className="mt-3 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight">{lead.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full px-2.5 py-1 font-display font-semibold ${TEMP_STYLE[lead.temperature]}`}>{TEMPERATURE_LABEL[lead.temperature]}</span>
            {lead.company?.segment ? <span className="rounded-full bg-soft px-2.5 py-1 font-display font-semibold">{lead.company.segment}</span> : null}
            {lead.city || lead.uf ? <span className="rounded-full bg-soft px-2.5 py-1 font-display font-semibold">{[lead.city, lead.uf].filter(Boolean).join(" · ")}</span> : null}
            <span className="rounded-full bg-graphite px-2.5 py-1 font-display font-semibold text-lime">Pontuação {lead.score}</span>
          </div>
        </div>
      </header>

      <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-5">
          <section className="rounded-2xl border border-line bg-card p-5" aria-label="Resumo">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Row label="Etapa">
                <StageControl leadId={lead.id} stage={lead.stage as StageName} canMove={canMove} />
              </Row>
              <Row label="Responsável">
                {canWrite ? (
                  <AssignControl leadId={lead.id} current={ownerValue} assignees={assignees} />
                ) : (
                  <span className="font-semibold">{lead.agentOwned ? "Agente IA" : (lead.owner?.name ?? "Sem responsável")}</span>
                )}
              </Row>
              <Row label="Origem">{SOURCE_LABEL[lead.source as SourceName]}</Row>
              <Row label="Valor estimado">{lead.estimatedValue ? `${brl(Number(lead.estimatedValue))} / mês` : "—"}</Row>
              <Row label="Criado">{dateTime(lead.createdAt)}</Row>
              <Row label="Último contato">{lead.lastContactAt ? ago(lead.lastContactAt) : "sem registro"}</Row>
              {lead.stage === "PERDIDO" && lead.lostReason ? <Row label="Motivo da perda">{lead.lostReason}</Row> : null}
              <Row label="Base do contato (LGPD)">
                {lead.consentText ? `${lead.consentText}${lead.consentAt ? ` · ${dateOnly(lead.consentAt)}` : ""}` : "Não registrada"}
              </Row>
              {lead.contact ? (
                <Row label="Contato">
                  {lead.contact.name}
                  {lead.contact.email ? <><br />{lead.contact.email}</> : null}
                  {lead.contact.phone ? <><br />{lead.contact.phone}</> : null}
                </Row>
              ) : null}
            </dl>
          </section>

          <section className="rounded-2xl bg-graphite p-5 text-[#ececec]" aria-label="Agente de IA">
            <p className="font-display text-xs font-semibold uppercase tracking-widest text-lime">Agente IA</p>
            {lead.actions.length ? (
              <ul className="mt-3 grid gap-3">
                {lead.actions.map((a) => (
                  <li key={a.id} className="rounded-xl bg-graphite-800 p-4">
                    <p className="text-xs text-[#b0b0b0]">
                      Aguardando aprovação · {a.kind.replaceAll("_", " ")} · confiança {a.confidence}%
                    </p>
                    {a.draft ? <p className="mt-2 whitespace-pre-wrap text-sm">{a.draft}</p> : null}
                    {a.reason ? <p className="mt-2 text-xs text-[#b0b0b0]">Por que: {a.reason}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-[#b0b0b0]">Nenhuma sugestão pendente para este lead.</p>
            )}
            <p className="mt-3 text-xs text-[#9c9c9c]">A aprovação e o envio chegam no marco M4.</p>
          </section>

          <section className="rounded-2xl border border-line bg-card p-5" aria-label="Tarefas">
            <h2 className="font-display text-base font-bold">Tarefas {openTasks.length ? <span className="text-sm font-normal text-muted">({openTasks.length} abertas)</span> : null}</h2>
            {lead.tasks.length ? (
              <ul className="mt-3 grid gap-1">
                {lead.tasks.map((t) => {
                  const late = t.status === "ABERTA" && t.dueAt && isPast(t.dueAt);
                  return (
                    <li key={t.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                      {canTask ? <TaskToggle leadId={lead.id} taskId={t.id} done={t.status === "CONCLUIDA"} title={t.title} /> : null}
                      <span className={`min-w-0 flex-1 ${t.status !== "ABERTA" ? "text-muted line-through" : ""}`}>{t.title}</span>
                      <span className="text-xs text-muted">{t.assignee?.name.split(" ")[0]}</span>
                      {t.dueAt ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${late ? "bg-bad-bg text-bad" : "bg-soft"}`}>{dateOnly(t.dueAt)}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">Nenhuma tarefa ainda.</p>
            )}
            {canTask ? (
              <div className="mt-4 border-t border-line pt-4">
                <TaskForm leadId={lead.id} assignees={assignees} me={user.id} />
              </div>
            ) : null}
          </section>

          {canWrite ? (
            <section className="rounded-2xl border border-line bg-card p-5" aria-label="Editar dados">
              <h2 className="mb-3 font-display text-base font-bold">Dados do lead</h2>
              <EditLeadForm
                leadId={lead.id}
                initialValues={{
                  product: lead.product ?? "",
                  volume: lead.volume ?? "",
                  estimatedValue: lead.estimatedValue ? String(Number(lead.estimatedValue)).replace(".", ",") : "",
                  nextAction: lead.nextAction ?? "",
                  temperature: lead.temperature,
                  uf: lead.uf ?? "",
                  city: lead.city ?? "",
                }}
              />
            </section>
          ) : null}
        </div>

        <aside className="min-w-0 content-start rounded-2xl border border-line bg-card p-5" aria-label="Linha do tempo">
          <h2 className="font-display text-base font-bold">Linha do tempo</h2>
          {canNote ? (
            <div className="mt-3 border-b border-line pb-4">
              <NoteForm leadId={lead.id} />
            </div>
          ) : null}
          <ol className="mt-4 grid gap-0">
            {lead.events.map((e) => (
              <li key={e.id} className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-3 pb-4 before:absolute before:bottom-0 before:left-[6px] before:top-4 before:w-0.5 before:bg-line last:before:hidden">
                <i
                  className={`mt-1 size-3.5 rounded-full border-[3px] ${e.actorType === "AGENTE" ? "border-graphite bg-lime" : e.kind === "nota" ? "border-[#0b5fa8] bg-soft" : "border-olive bg-soft"}`}
                />
                <div>
                  <p className="text-sm">
                    {e.kind === "nota" ? <span className="whitespace-pre-wrap">{e.text}</span> : e.text}
                  </p>
                  <p className="text-xs text-muted">
                    {EVENT_LABEL[e.kind] ?? e.kind} · {e.actor?.name ?? (e.actorType === "AGENTE" ? "Agente IA" : "Sistema")} · {dateTime(e.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      <p className="mt-6 text-xs text-muted">Etapa atual: {STAGE_LABEL[lead.stage as StageName]}</p>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
