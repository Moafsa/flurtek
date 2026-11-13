"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { STAGE_LABEL, TEMPERATURE_LABEL, type StageName, type TemperatureName } from "@/lib/crm-constants";
import { brl, ago } from "@/lib/format";
import { moveLeadAction } from "../leads/actions";

export type BoardLead = {
  id: string;
  title: string;
  uf: string | null;
  city: string | null;
  segment: string | null;
  product: string | null;
  volume: string | null;
  value: number;
  score: number;
  temperature: TemperatureName;
  stage: StageName;
  ownerName: string | null;
  agentOwned: boolean;
  nextAction: string | null;
  updatedAt: string;
};

const TEMP_STYLE: Record<TemperatureName, string> = {
  QUENTE: "bg-bad-bg text-bad",
  MORNO: "bg-warn-bg text-warn",
  FRIO: "bg-[#e4effa] text-[#0b5fa8]",
};

export function Board({ leads, stages, canMove }: { leads: BoardLead[]; stages: StageName[]; canMove: boolean }) {
  const [, startTransition] = useTransition();
  const [items, applyMove] = useOptimistic(leads, (cur, m: { id: string; stage: StageName }) =>
    cur.map((l) => (l.id === m.id ? { ...l, stage: m.stage } : l)),
  );
  const [active, setActive] = useState<BoardLead | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lost, setLost] = useState<{ id: string; title: string } | null>(null);
  const justDragged = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  function commit(id: string, stage: StageName, reason?: string) {
    setMessage(null);
    startTransition(async () => {
      applyMove({ id, stage });
      const res = await moveLeadAction(id, stage, reason);
      if (res.error) setMessage(res.error);
    });
  }

  function onDragStart(e: DragStartEvent) {
    setActive(items.find((l) => l.id === e.active.id) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 150);
    const lead = items.find((l) => l.id === e.active.id);
    const to = e.over?.id as StageName | undefined;
    if (!lead || !to || lead.stage === to) return;
    if (to === "PERDIDO") setLost({ id: lead.id, title: lead.title });
    else commit(lead.id, to);
  }

  return (
    <div>
      {message ? (
        <p role="alert" className="mb-3 rounded-lg bg-bad-bg px-4 py-3 text-sm text-bad">
          {message}
        </p>
      ) : null}
      <DndContext id="funil-dnd" sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
        <div className="grid auto-cols-[minmax(260px,1fr)] grid-flow-col items-start gap-3.5 overflow-x-auto pb-4">
          {stages.map((stage) => (
            <Column key={stage} stage={stage} leads={items.filter((l) => l.stage === stage)} canMove={canMove} justDragged={justDragged} />
          ))}
        </div>
        <DragOverlay>{active ? <CardBody lead={active} overlay /> : null}</DragOverlay>
      </DndContext>

      {lost ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Motivo da perda">
          <form
            className="w-full max-w-md rounded-2xl bg-card p-6 shadow-2xl"
            onSubmit={(e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
              if (reason.length < 3) return;
              commit(lost.id, "PERDIDO", reason);
              setLost(null);
            }}
          >
            <h2 className="font-display text-lg font-bold">Marcar como perdido</h2>
            <p className="mt-1 text-sm text-muted">{lost.title}</p>
            <label className="mt-4 grid gap-1.5 text-sm font-semibold">
              Motivo da perda
              <input name="reason" required minLength={3} autoFocus className="min-h-11 rounded-lg border border-line px-3 font-normal" placeholder="Ex.: fechou com outro fornecedor" />
            </label>
            <div className="mt-5 flex gap-3">
              <button type="submit" className="min-h-11 rounded-lg bg-graphite px-4 font-semibold text-white">
                Confirmar
              </button>
              <button type="button" onClick={() => setLost(null)} className="min-h-11 rounded-lg border border-line px-4 font-semibold">
                Cancelar
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function Column({
  stage,
  leads,
  canMove,
  justDragged,
}: {
  stage: StageName;
  leads: BoardLead[];
  canMove: boolean;
  justDragged: React.RefObject<boolean>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage, disabled: !canMove });
  const total = leads.reduce((n, l) => n + l.value, 0);
  return (
    <section
      ref={setNodeRef}
      aria-label={STAGE_LABEL[stage]}
      className={`min-h-80 rounded-2xl border-2 p-3 transition ${isOver ? "border-lime-dark bg-[#eef0cf]" : "border-transparent bg-soft"}`}
    >
      <header className="mb-3 flex items-center gap-2 px-1">
        <h2 className="font-display text-[13px] font-bold uppercase tracking-wider">{STAGE_LABEL[stage]}</h2>
        <span className="rounded-full bg-graphite px-2 py-0.5 font-display text-[11px] font-bold text-white">{leads.length}</span>
        <span className="ml-auto text-xs font-semibold text-muted">{total ? brl(total) : ""}</span>
      </header>
      <div className="grid gap-2.5">
        {leads.map((l) => (
          <DraggableCard key={l.id} lead={l} canMove={canMove} justDragged={justDragged} />
        ))}
        {leads.length === 0 ? <p className="rounded-xl border-2 border-dashed border-line px-3 py-6 text-center text-xs text-muted">{canMove ? "Solte um lead aqui" : "Sem leads"}</p> : null}
      </div>
    </section>
  );
}

function DraggableCard({ lead, canMove, justDragged }: { lead: BoardLead; canMove: boolean; justDragged: React.RefObject<boolean> }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id, disabled: !canMove });
  return (
    <div
      ref={setNodeRef}
      {...(canMove ? listeners : {})}
      {...(canMove ? attributes : {})}
      className={`touch-manipulation ${canMove ? "cursor-grab active:cursor-grabbing" : ""} ${isDragging ? "opacity-40" : ""}`}
    >
      <CardBody lead={lead} onLinkClick={(e) => justDragged.current && e.preventDefault()} />
    </div>
  );
}

function CardBody({ lead, overlay, onLinkClick }: { lead: BoardLead; overlay?: boolean; onLinkClick?: (e: React.MouseEvent) => void }) {
  return (
    <article className={`grid gap-2 rounded-xl border border-line bg-white p-3 text-left ${overlay ? "rotate-2 shadow-2xl" : "hover:border-olive hover:shadow-md"}`}>
      <div className="flex items-start gap-2">
        <Link href={`/leads/${lead.id}`} onClick={onLinkClick} className="font-display text-sm font-semibold tracking-tight hover:underline">
          {lead.title}
        </Link>
        <span title="Pontuação" className="ml-auto grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-graphite font-display text-xs font-extrabold text-lime">
          {lead.score}
        </span>
      </div>
      <p className="text-xs text-muted">
        {[lead.product, lead.volume].filter(Boolean).join(" · ") || "Produto a definir"}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 font-display text-[11px] font-semibold ${TEMP_STYLE[lead.temperature]}`}>{TEMPERATURE_LABEL[lead.temperature]}</span>
        {lead.uf ? <span className="rounded-full bg-soft px-2 py-0.5 font-display text-[11px] font-semibold">{lead.uf}</span> : null}
        <span className={`rounded-full px-2 py-0.5 font-display text-[11px] font-semibold ${lead.agentOwned ? "bg-graphite text-lime" : "bg-soft"}`}>
          {lead.agentOwned ? "Agente" : (lead.ownerName?.split(" ")[0] ?? "Sem responsável")}
        </span>
        {lead.value ? <span className="ml-auto text-xs font-semibold">{brl(lead.value)}</span> : null}
      </div>
      {lead.nextAction ? (
        <p className="flex gap-1.5 border-t border-dashed border-line pt-2 text-xs">
          <span aria-hidden="true">→</span>
          <span>{lead.nextAction}</span>
        </p>
      ) : null}
      <p className="text-[11px] text-muted">Atualizado {ago(lead.updatedAt)}</p>
    </article>
  );
}
