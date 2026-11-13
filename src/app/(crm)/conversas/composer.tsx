"use client";

import { useActionState, useRef, useTransition } from "react";
import { sendMessageAction, setModeAction, type ConvState } from "./actions";

export function Composer({ id }: { id: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(async (prev: ConvState, fd: FormData) => {
    const res = await sendMessageAction(id, prev, fd);
    if (res.ok) ref.current?.reset();
    return res;
  }, {} as ConvState);
  return (
    <form ref={ref} action={action} className="grid gap-2 border-t border-line p-4">
      <div className="flex gap-2">
        <input name="body" required maxLength={4000} aria-label="Mensagem" placeholder="Escreva uma mensagem (o agente sai da conversa)" className="min-h-11 min-w-0 flex-1 rounded-lg border border-line px-3 text-sm" />
        <button disabled={pending} className="min-h-11 rounded-lg bg-graphite px-5 text-sm font-semibold text-white disabled:opacity-60">
          Enviar
        </button>
      </div>
      {state.error ? <p role="alert" className="text-sm text-bad">{state.error}</p> : null}
      <p className="text-xs text-muted">O canal de WhatsApp ainda não está conectado: a mensagem fica registrada como “aguardando envio”.</p>
    </form>
  );
}

export function ModeButton({ id, mode }: { id: string; mode: "AGENTE" | "HUMANO" }) {
  const [pending, start] = useTransition();
  const next = mode === "AGENTE" ? "HUMANO" : "AGENTE";
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => void (await setModeAction(id, next)))}
      className="min-h-9 rounded-lg border border-line px-3 text-sm font-semibold hover:border-olive disabled:opacity-60"
    >
      {mode === "AGENTE" ? "Assumir conversa" : "Devolver ao agente"}
    </button>
  );
}
