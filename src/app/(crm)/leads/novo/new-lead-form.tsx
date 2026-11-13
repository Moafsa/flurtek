"use client";

import { useActionState } from "react";
import { createLeadAction } from "../actions";
import { CONSENT_BASES, MANUAL_SOURCES, SOURCE_LABEL } from "@/lib/crm-constants";
import { UF_LIST } from "@/lib/validators";

const input = "min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-normal";

export function NewLeadForm() {
  const [state, action, pending] = useActionState(createLeadAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
        Empresa
        <input name="company" required maxLength={120} className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Estado
        <select name="uf" required defaultValue="" className={input}>
          <option value="" disabled>
            Escolha
          </option>
          {UF_LIST.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Cidade
        <input name="city" maxLength={120} className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Segmento
        <input name="segment" maxLength={80} placeholder="Ex.: Transportadoras" className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Origem
        <select name="source" defaultValue="MANUAL" className={input}>
          {MANUAL_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Nome do contato
        <input name="contactName" maxLength={120} className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        E-mail
        <input name="email" type="email" className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Telefone
        <input name="phone" maxLength={40} className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Produto
        <input name="product" maxLength={120} placeholder="Ex.: Água 20L" className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Volume
        <input name="volume" maxLength={120} placeholder="Ex.: 10 galões/mês" className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Valor estimado por mês (R$)
        <input name="estimatedValue" inputMode="decimal" className={input} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
        De onde veio este contato? (base legal, LGPD)
        <select name="consentBase" required defaultValue="" className={input}>
          <option value="" disabled>
            Escolha
          </option>
          {Object.entries(CONSENT_BASES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad sm:col-span-2">
          {state.error}
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <button disabled={pending} className="min-h-11 rounded-lg bg-lime px-5 font-display font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60">
          {pending ? "Criando…" : "Criar lead"}
        </button>
      </div>
    </form>
  );
}
