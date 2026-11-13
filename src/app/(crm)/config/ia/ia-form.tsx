"use client";

import { useActionState, useState, useTransition } from "react";
import { removeIaKeyAction, saveIaAction, testIaAction, type IaState, type IaTestState } from "./actions";

const field = "min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-normal";
const hint = "text-xs font-normal text-muted";

export type IaView = {
  provider: string;
  hasKey: boolean;
  keyHint: string | null;
  keySource: "painel" | "env" | "nenhuma";
  model: string;
  ownerModel: string;
  dataCollection: "allow" | "deny";
  defaults: { model: string; ownerModel: string };
};

export function IaForm({ v }: { v: IaView }) {
  const [state, action, pending] = useActionState(saveIaAction, {} as IaState);
  const [provider, setProvider] = useState(v.provider);
  const [test, setTest] = useState<IaTestState>({});
  const [testing, startTest] = useTransition();
  const [removing, startRemove] = useTransition();
  const usesOpenRouter = provider === "auto" || provider === "openrouter";

  return (
    <div className="grid gap-6">
      <form action={action} className="grid gap-4 sm:grid-cols-2" key={state.ok ? "salvo" : "form"}>
        <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
          Provedor de IA
          <select name="provider" value={provider} onChange={(e) => setProvider(e.target.value)} className={field}>
            <option value="auto">Automático (OpenRouter se houver chave, senão Anthropic)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Anthropic (chave no .env)</option>
            <option value="mock">Desligada (regras simples, sem IA)</option>
          </select>
        </label>

        {usesOpenRouter ? (
          <>
            <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
              Chave do OpenRouter
              <input name="apiKey" type="password" autoComplete="off" spellCheck={false} placeholder={v.hasKey ? `Chave atual: ${v.keyHint ?? "guardada"} (deixe em branco para manter)` : "sk-or-v1-…"} className={field} />
              <span className={hint}>
                Crie em openrouter.ai/keys. Fica guardada criptografada e nunca aparece de novo na tela.
                {v.keySource === "env" ? " Hoje está usando a chave do arquivo .env; se você colar uma aqui, esta passa a valer." : ""}
              </span>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">
              Modelo do atendimento
              <input name="model" defaultValue={v.model} placeholder={v.defaults.model} maxLength={100} className={field} />
              <span className={hint}>Chat do site e WhatsApp. Vazio usa o padrão.</span>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">
              Modelo das ordens do dono
              <input name="ownerModel" defaultValue={v.ownerModel} placeholder={v.defaults.ownerModel} maxLength={100} className={field} />
              <span className={hint}>Interpreta o que o dono pede. Pode ser um modelo menor e mais barato.</span>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
              Privacidade das conversas
              <select name="dataCollection" defaultValue={v.dataCollection} className={field}>
                <option value="deny">Só provedores que não guardam nem treinam com os dados (recomendado)</option>
                <option value="allow">Permitir qualquer provedor (mais modelos, menos privacidade)</option>
              </select>
              <span className={hint}>Com a opção recomendada, alguns modelos gratuitos ou baratos podem não estar disponíveis.</span>
            </label>
          </>
        ) : (
          <>
            <input type="hidden" name="model" value={v.model} />
            <input type="hidden" name="ownerModel" value={v.ownerModel} />
            <input type="hidden" name="dataCollection" value={v.dataCollection} />
            <p className="rounded-lg bg-white px-3 py-2 text-sm text-muted sm:col-span-2">
              {provider === "anthropic" ? "A chave da Anthropic é lida do arquivo .env (ANTHROPIC_API_KEY)." : "Com a IA desligada, o agente responde só com regras simples e a base de conhecimento."}
            </p>
          </>
        )}

        {state.error ? (
          <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad sm:col-span-2">
            {state.error}
          </p>
        ) : null}
        {state.ok ? (
          <p role="status" className="rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok sm:col-span-2">
            Configuração salva. O agente passa a usar em até alguns segundos, sem reiniciar nada.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button disabled={pending} className="min-h-11 rounded-lg bg-lime px-5 font-display font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60">
            {pending ? "Salvando…" : "Salvar"}
          </button>
          {v.keySource === "painel" ? (
            <button
              type="button"
              disabled={removing}
              onClick={() => startRemove(async () => void (await removeIaKeyAction()))}
              className="min-h-11 rounded-lg border border-line px-4 text-sm font-semibold hover:border-bad hover:text-bad disabled:opacity-60"
            >
              {removing ? "Removendo…" : "Remover a chave guardada"}
            </button>
          ) : null}
        </div>
      </form>

      <div className="grid gap-3 border-t border-line pt-5">
        <div>
          <button
            type="button"
            disabled={testing}
            onClick={() => startTest(async () => setTest(await testIaAction()))}
            className="min-h-11 rounded-lg border border-line px-5 font-display font-semibold hover:border-olive disabled:opacity-60"
          >
            {testing ? "Testando…" : "Testar conexão com a IA"}
          </button>
          <p className="mt-2 text-xs text-muted">Faz uma chamada mínima, sem dados de clientes, para conferir a chave e o modelo. Teste depois de salvar.</p>
        </div>
        {test.error ? <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{test.error}</p> : null}
        {test.result ? (
          <p role="status" className={`rounded-lg px-3 py-2 text-sm ${test.result.ok ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}>
            {test.result.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
