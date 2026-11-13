"use client";

import { useActionState } from "react";
import { addNumberAction, type NumberState } from "./actions";

const field = "min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-normal";

export function NewNumberForm({ users }: { users: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(addNumberAction, {} as NumberState);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" key={state.code ?? "form"}>
      <label className="grid gap-1.5 text-sm font-semibold">
        Nome
        <input name="name" required maxLength={80} className={field} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        WhatsApp (com DDD)
        <input name="phone" required inputMode="tel" placeholder="(54) 99999-9999" className={field} />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Papel
        <select name="role" defaultValue="DONO" className={field}>
          <option value="DONO">Dono (pode tudo, com confirmação)</option>
          <option value="GESTOR">Gestor (relatórios, pendências e status)</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Usuário do CRM vinculado
        <select name="userId" defaultValue="" className={field}>
          <option value="">Nenhum (só consulta)</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      {state.error ? <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad sm:col-span-2">{state.error}</p> : null}
      {state.code ? (
        <div role="status" className="rounded-xl border border-olive bg-[#f7f9dc] p-4 text-sm sm:col-span-2">
          <p>
            Número de <b>{state.name}</b> cadastrado. Peça para a pessoa enviar, deste WhatsApp, a mensagem:
          </p>
          <p className="my-2 font-display text-2xl font-extrabold tracking-wider">VERIFICAR {state.code}</p>
          <p className="text-muted">Vale por 30 minutos. Este código aparece só agora.</p>
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <button disabled={pending} className="min-h-11 rounded-lg bg-lime px-5 font-display font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60">
          {pending ? "Cadastrando…" : "Cadastrar número"}
        </button>
      </div>
    </form>
  );
}
