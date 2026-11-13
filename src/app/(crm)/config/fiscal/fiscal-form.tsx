"use client";

import { useActionState, useState } from "react";
import { saveFiscalAction, type FiscalState } from "./actions";
import { REGIMES, type Regime } from "@/server/finance/fiscal-regimes";
import type { FiscalConfig } from "@/server/finance/fiscal-config";

const field = "min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-normal";
const hint = "text-xs font-normal text-muted";

export function FiscalForm({ config }: { config: FiscalConfig }) {
  const [state, action, pending] = useActionState(saveFiscalAction, {} as FiscalState);
  const [regime, setRegime] = useState<Regime | "">(config.regime ?? "");
  const code = regime ? REGIMES[regime].taxCode : null;

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
        Regime tributário
        <select name="regime" value={regime} onChange={(e) => setRegime(e.target.value as Regime | "")} className={field}>
          <option value="">Ainda não definido</option>
          {(Object.keys(REGIMES) as Regime[]).map((k) => (
            <option key={k} value={k}>
              {REGIMES[k].label}
            </option>
          ))}
        </select>
        <span className={hint}>Pode ser trocado a qualquer momento. Confirme com o contador antes de emitir em produção.</span>
      </label>

      <label className="grid gap-1.5 text-sm font-semibold">
        Ambiente da SEFAZ
        <select name="environment" defaultValue={config.environment} className={field}>
          <option value="HOMOLOGACAO">Homologação (teste, sem valor fiscal)</option>
          <option value="PRODUCAO">Produção</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Inscrição estadual
        <input name="stateRegistration" defaultValue={config.stateRegistration} maxLength={20} className={field} />
      </label>

      <label className="grid gap-1.5 text-sm font-semibold">
        Série da NF-e
        <input name="series" type="number" min={1} max={999} defaultValue={config.series} className={field} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Próximo número
        <input name="nextNumber" type="number" min={1} defaultValue={config.nextNumber} className={field} />
        <span className={hint}>Não pode diminuir: a SEFAZ não aceita número repetido.</span>
      </label>

      <label className="grid gap-1.5 text-sm font-semibold">
        CFOP dentro do estado
        <input name="cfopInState" inputMode="numeric" maxLength={4} defaultValue={config.cfopInState} placeholder="5xxx" className={field} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        CFOP fora do estado
        <input name="cfopOutState" inputMode="numeric" maxLength={4} defaultValue={config.cfopOutState} placeholder="6xxx" className={field} />
      </label>

      <label className="grid gap-1.5 text-sm font-semibold">
        {code ? `Código ${code}` : "Código de tributação (CSOSN ou CST)"}
        <input name="taxCode" inputMode="numeric" maxLength={3} defaultValue={config.taxCode} className={field} />
        <span className={hint}>{code === "CSOSN" ? "Simples e MEI usam CSOSN (3 dígitos)." : code === "CST" ? "Lucro Presumido e Real usam CST (2 dígitos)." : "Escolha o regime para saber qual código usar."}</span>
      </label>
      <div className="hidden sm:block" />

      <label className="grid gap-1.5 text-sm font-semibold">
        NCM da água desmineralizada
        <input name="ncmWater" inputMode="numeric" maxLength={10} defaultValue={config.ncmWater} placeholder="8 dígitos" className={field} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        NCM do fluido de radiador
        <input name="ncmFluid" inputMode="numeric" maxLength={10} defaultValue={config.ncmFluid} placeholder="8 dígitos" className={field} />
      </label>

      {state.error ? (
        <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad sm:col-span-2">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p role="status" className="rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok sm:col-span-2">
          Configuração fiscal salva.
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <button disabled={pending} className="min-h-11 rounded-lg bg-lime px-5 font-display font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60">
          {pending ? "Salvando…" : "Salvar configuração"}
        </button>
      </div>
    </form>
  );
}
