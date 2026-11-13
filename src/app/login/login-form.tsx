"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";

const initial: LoginState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, initial);

  return (
    <form action={action} className="grid gap-4" noValidate>
      <label className="grid gap-1.5 text-sm font-semibold">
        E-mail
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          className="min-h-11 rounded-lg border border-line bg-white px-3 font-normal"
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Senha
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="min-h-11 rounded-lg border border-line bg-white px-3 font-normal"
        />
      </label>
      {state.error ? (
        <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 rounded-lg bg-lime px-4 font-display font-semibold text-on-lime transition hover:bg-lime-dark disabled:opacity-60"
      >
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
