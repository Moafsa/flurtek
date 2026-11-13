"use client";

import { useActionState, useState } from "react";
import { createUserAction, type FormState } from "./actions";
import { UF_LIST } from "@/lib/validators";
import { ROLE_LABEL, ROLES } from "@/server/rbac";

const initial: FormState = {};
const field = "min-h-11 rounded-lg border border-line bg-white px-3 font-normal";

export function NewUserForm() {
  const [state, action, pending] = useActionState(createUserAction, initial);
  const [role, setRole] = useState<string>("COMERCIAL");
  const err = (k: string) =>
    state.fieldErrors?.[k] ? (
      <span role="alert" className="text-xs font-normal text-bad">
        {state.fieldErrors[k]}
      </span>
    ) : null;

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" key={state.ok ? "ok" : "form"}>
      <label className="grid gap-1.5 text-sm font-semibold">
        Nome
        <input name="name" required className={field} />
        {err("name")}
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        E-mail
        <input name="email" type="email" required className={field} />
        {err("email")}
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Papel
        <select name="role" value={role} onChange={(e) => setRole(e.target.value)} className={field}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Senha provisória (mín. 12 caracteres)
        <input name="password" type="password" autoComplete="new-password" required minLength={12} className={field} />
        {err("password")}
      </label>
      {role === "REPRESENTANTE" ? (
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-semibold">Estados atendidos</legend>
          <div className="flex flex-wrap gap-2">
            {UF_LIST.map((uf) => (
              <label key={uf} className="flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-sm">
                <input type="checkbox" name="states" value={uf} />
                {uf}
              </label>
            ))}
          </div>
          {err("states")}
        </fieldset>
      ) : null}
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className="min-h-11 rounded-lg bg-lime px-5 font-display font-semibold text-on-lime hover:bg-lime-dark disabled:opacity-60">
          {pending ? "Criando…" : "Criar usuário"}
        </button>
        {state.ok ? <p role="status" className="text-sm text-ok">Usuário criado.</p> : null}
      </div>
    </form>
  );
}
