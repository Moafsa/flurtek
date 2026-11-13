"use client";

import { useState, useTransition } from "react";
import { testSefazAction, type SefazState } from "./actions";

export function SefazTest() {
  const [state, setState] = useState<SefazState>({});
  const [pending, start] = useTransition();
  const c = state.result?.certificate;
  const s = state.result?.service;
  const row = (ok: boolean | undefined, label: string, text: string) => (
    <p className={`rounded-lg px-3 py-2 text-sm ${ok ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>
      <b>{label}:</b> {text}
    </p>
  );

  return (
    <div className="grid gap-3">
      <div>
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => setState(await testSefazAction()))}
          className="min-h-11 rounded-lg border border-line px-5 font-display font-semibold hover:border-olive disabled:opacity-60"
        >
          {pending ? "Testando…" : "Testar conexão com a SEFAZ"}
        </button>
        <p className="mt-2 text-xs text-muted">Confere o certificado e consulta o status do serviço no ambiente escolhido. Não emite nenhuma nota.</p>
      </div>
      {state.error ? <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{state.error}</p> : null}
      {c ? (
        <div role="status" className="grid gap-2">
          {row(c.ok, "Certificado", c.message)}
          {c.ok ? (
            <p className="text-xs text-muted">
              Titular: {c.subject} · CNPJ do certificado: {c.cnpj ?? "não identificado"} · vence em {c.notAfter ? new Date(c.notAfter).toLocaleDateString("pt-BR") : "—"}. Confira se o CNPJ é o da Flurtek.
            </p>
          ) : null}
          {s ? row(s.ok, `SEFAZ (${state.result!.environment === "PRODUCAO" ? "produção" : "homologação"})`, s.message) : null}
        </div>
      ) : null}
    </div>
  );
}
