"use client";

import { useActionState } from "react";
import { removeCertificateAction, uploadCertificateAction, type CertState } from "./actions";

export type CertView = { subject: string; cnpj: string | null; notAfter: string; daysLeft: number; uploadedAt: string } | null;

const field = "min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-normal";

export function CertificateCard({ current }: { current: CertView }) {
  const [state, action, pending] = useActionState(uploadCertificateAction, {} as CertState);
  const soon = current ? current.daysLeft <= 30 : false;

  return (
    <div className="grid gap-4">
      {current ? (
        <div className={`rounded-xl border p-4 text-sm ${soon ? "border-warn bg-warn-bg" : "border-line bg-white"}`}>
          <p className="font-semibold">Certificado enviado</p>
          <p className="mt-1 text-muted">
            {current.subject}
            <br />
            CNPJ do certificado: {current.cnpj ?? "não identificado"} · vence em {new Date(current.notAfter).toLocaleDateString("pt-BR")} ({current.daysLeft} dia(s))
            <br />
            Enviado em {new Date(current.uploadedAt).toLocaleString("pt-BR")}
          </p>
          {soon ? <p className="mt-1 font-semibold text-warn">Vence em breve. Envie o certificado renovado.</p> : null}
          <form action={removeCertificateAction} className="mt-3">
            <button className="min-h-9 rounded-lg border border-line px-3 text-xs font-semibold hover:border-bad hover:text-bad">Remover certificado</button>
          </form>
        </div>
      ) : (
        <p className="rounded-xl border border-line bg-white p-4 text-sm text-muted">Nenhum certificado enviado ainda. Sem ele, a emissão real de nota não funciona.</p>
      )}

      <form action={action} className="grid gap-4 sm:grid-cols-2" key={state.ok ? "ok" : "form"}>
        <label className="grid gap-1.5 text-sm font-semibold">
          Arquivo do certificado A1 (.pfx ou .p12)
          <input name="certificate" type="file" accept=".pfx,.p12" required className={field} />
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">
          Senha do certificado
          <input name="password" type="password" required autoComplete="off" className={field} />
        </label>
        <p className="text-xs text-muted sm:col-span-2">O arquivo e a senha são guardados criptografados e nunca aparecem de novo na tela. Enviar outro certificado substitui o atual.</p>
        {state.error ? (
          <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad sm:col-span-2">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p role="status" className="rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok sm:col-span-2">
            Certificado salvo. Use “Testar conexão com a SEFAZ” para conferir.
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <button disabled={pending} className="min-h-11 rounded-lg bg-lime px-5 font-display font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60">
            {pending ? "Enviando…" : current ? "Substituir certificado" : "Enviar certificado"}
          </button>
        </div>
      </form>
    </div>
  );
}
