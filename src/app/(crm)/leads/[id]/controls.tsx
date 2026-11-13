"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import {
  addNoteAction,
  assignLeadAction,
  createTaskAction,
  moveLeadAction,
  setTaskStatusAction,
  updateLeadAction,
  type ActionState,
} from "../actions";
import { STAGE_LABEL, STAGES, TEMPERATURES, TEMPERATURE_LABEL, type StageName } from "@/lib/crm-constants";
import { UF_LIST } from "@/lib/validators";

const input = "min-h-10 rounded-lg border border-line bg-white px-3 text-sm font-normal";
const primary = "min-h-10 rounded-lg bg-lime px-4 font-display text-sm font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60";
const initial: ActionState = {};

function Msg({ state }: { state: ActionState }) {
  if (state.error) return <p role="alert" className="text-sm text-bad">{state.error}</p>;
  return null;
}

export function StageControl({ leadId, stage, canMove }: { leadId: string; stage: StageName; canMove: boolean }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState<StageName>(stage);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!canMove) return <span className="font-semibold">{STAGE_LABEL[stage]}</span>;

  function submit() {
    setError(null);
    start(async () => {
      const res = await moveLeadAction(leadId, value, reason);
      if (res.error) setError(res.error);
      else setReason("");
    });
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <select aria-label="Etapa" value={value} onChange={(e) => setValue(e.target.value as StageName)} className={input}>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
        <button type="button" onClick={submit} disabled={pending || value === stage} className="min-h-10 rounded-lg bg-graphite px-4 text-sm font-semibold text-white disabled:opacity-50">
          {pending ? "Movendo…" : "Mover"}
        </button>
      </div>
      {value === "PERDIDO" && stage !== "PERDIDO" ? (
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo da perda" aria-label="Motivo da perda" className={input} />
      ) : null}
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

export function AssignControl({
  leadId,
  current,
  assignees,
}: {
  leadId: string;
  current: string;
  assignees: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <select
        aria-label="Responsável"
        defaultValue={current}
        disabled={pending}
        className={input}
        onChange={(e) => {
          setError(null);
          start(async () => {
            const res = await assignLeadAction(leadId, e.target.value);
            if (res.error) setError(res.error);
          });
        }}
      >
        <option value="">Sem responsável</option>
        <option value="AGENTE">Agente IA</option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </div>
  );
}

export function NoteForm({ leadId }: { leadId: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(async (prev: ActionState, fd: FormData) => {
    const res = await addNoteAction(leadId, prev, fd);
    if (res.ok) ref.current?.reset();
    return res;
  }, initial);
  return (
    <form ref={ref} action={action} className="grid gap-2">
      <label className="grid gap-1.5 text-sm font-semibold">
        Nova nota
        <textarea name="text" required rows={3} maxLength={2000} className={`${input} py-2`} placeholder="O que aconteceu neste contato?" />
      </label>
      <div className="flex items-center gap-3">
        <button disabled={pending} className={primary}>
          {pending ? "Salvando…" : "Adicionar nota"}
        </button>
        <Msg state={state} />
      </div>
    </form>
  );
}

export function TaskForm({ leadId, assignees, me }: { leadId: string; assignees: { id: string; name: string }[]; me: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(async (prev: ActionState, fd: FormData) => {
    const res = await createTaskAction(leadId, prev, fd);
    if (res.ok) ref.current?.reset();
    return res;
  }, initial);
  return (
    <form ref={ref} action={action} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_170px_auto] sm:items-end">
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Nova tarefa
        <input name="title" required maxLength={160} className={input} placeholder="Ex.: ligar para confirmar volume" />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Prazo
        <input name="dueAt" type="date" className={input} />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Responsável
        <select name="assigneeId" defaultValue={me} className={input}>
          {assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <button disabled={pending} className={primary}>
        Criar
      </button>
      <div className="sm:col-span-4">
        <Msg state={state} />
      </div>
    </form>
  );
}

export function TaskToggle({ leadId, taskId, done, title }: { leadId: string; taskId: string; done: boolean; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={done}
        disabled={pending}
        aria-label={`${done ? "Reabrir" : "Concluir"} tarefa: ${title}`}
        className="size-5 accent-olive"
        onChange={(e) => {
          setError(null);
          start(async () => {
            const res = await setTaskStatusAction(leadId, taskId, e.target.checked ? "CONCLUIDA" : "ABERTA");
            if (res.error) setError(res.error);
          });
        }}
      />
      {error ? <span role="alert" className="text-xs text-bad">{error}</span> : null}
    </span>
  );
}

export function EditLeadForm({
  leadId,
  initialValues,
}: {
  leadId: string;
  initialValues: { product: string; volume: string; estimatedValue: string; nextAction: string; temperature: string; uf: string; city: string };
}) {
  const [state, action, pending] = useActionState(async (prev: ActionState, fd: FormData) => updateLeadAction(leadId, prev, fd), initial);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Produto
        <input name="product" defaultValue={initialValues.product} className={input} />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Volume
        <input name="volume" defaultValue={initialValues.volume} className={input} />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Valor estimado por mês (R$)
        <input name="estimatedValue" inputMode="decimal" defaultValue={initialValues.estimatedValue} className={input} />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Temperatura
        <select name="temperature" defaultValue={initialValues.temperature} className={input}>
          {TEMPERATURES.map((t) => (
            <option key={t} value={t}>
              {TEMPERATURE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Estado
        <select name="uf" defaultValue={initialValues.uf} className={input}>
          <option value="">—</option>
          {UF_LIST.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Cidade
        <input name="city" defaultValue={initialValues.city} className={input} />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-muted sm:col-span-2">
        Próxima ação
        <input name="nextAction" defaultValue={initialValues.nextAction} maxLength={300} className={input} />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button disabled={pending} className={primary}>
          {pending ? "Salvando…" : "Salvar dados"}
        </button>
        {state.ok ? <span role="status" className="text-sm text-ok">Salvo.</span> : null}
        <Msg state={state} />
      </div>
    </form>
  );
}
