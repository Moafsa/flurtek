"use client";

import { useState, useTransition } from "react";
import { decideActionAction, setPolicyAction } from "./actions";

export function ApprovalCard({
  id,
  kind,
  leadTitle,
  confidence,
  reason,
  draft,
  needsTemplate,
}: {
  id: string;
  kind: string;
  leadTitle: string;
  confidence: number;
  reason: string | null;
  draft: string;
  needsTemplate?: boolean;
}) {
  const [text, setText] = useState(draft);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function decide(decision: "APROVAR" | "REJEITAR") {
    setError(null);
    start(async () => {
      const res = await decideActionAction(id, decision, decision === "APROVAR" ? text : undefined);
      if (res.error) setError(res.error);
    });
  }

  return (
    <li className="grid gap-3 rounded-xl border border-line bg-white p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-graphite px-2.5 py-0.5 font-display text-[11px] font-semibold text-lime">{kind.replaceAll("_", " ")}</span>
        <b className="font-display text-sm">{leadTitle}</b>
        {needsTemplate ? <span className="rounded-full bg-warn-bg px-2.5 py-0.5 font-display text-[11px] font-semibold text-warn">precisa de modelo (fora da janela de 24 h)</span> : null}
        <span className="ml-auto text-xs text-muted">Confiança {confidence}%</span>
      </header>
      <label className="grid gap-1 text-xs font-semibold text-muted">
        Texto (você pode editar antes de aprovar)
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={4000} className="rounded-lg border border-line bg-paper p-3 text-sm font-normal text-ink" />
      </label>
      {reason ? (
        <p className="text-xs text-muted">
          <b>Por que:</b> {reason}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button disabled={pending} onClick={() => decide("APROVAR")} className="min-h-10 rounded-lg bg-lime px-4 font-display text-sm font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60">
          Aprovar
        </button>
        <button disabled={pending} onClick={() => decide("REJEITAR")} className="min-h-10 rounded-lg border border-line px-4 text-sm font-semibold text-bad hover:border-bad disabled:opacity-60">
          Rejeitar
        </button>
      </div>
      {error ? <p role="alert" className="text-sm text-bad">{error}</p> : null}
    </li>
  );
}

export function PolicySelect({ task, label, level, editable }: { task: string; label: string; level: string; editable: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1.5 border-t border-line py-3.5 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_210px] sm:items-center">
      <b className="font-display text-sm">{label}</b>
      <div className="grid gap-1">
        <select
          aria-label={label}
          defaultValue={level}
          disabled={!editable || pending}
          onChange={(e) => {
            setError(null);
            start(async () => {
              const res = await setPolicyAction(task, e.target.value);
              if (res.error) {
                setError(res.error);
                e.target.value = level;
              }
            });
          }}
          className="min-h-10 rounded-lg border border-line bg-white px-2.5 text-sm"
        >
          <option value="AUTOMATICO">Automático</option>
          <option value="APROVACAO">Com aprovação</option>
          <option value="HUMANO">Somente humano</option>
        </select>
        {error ? <p role="alert" className="text-xs text-bad">{error}</p> : null}
      </div>
    </div>
  );
}
