import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-graphite px-4 py-10">
      <div className="w-full max-w-md rounded-2xl bg-card p-8 shadow-2xl">
        <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-olive">Flurtek CRM</p>
        <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">Entrar</h1>
        <p className="mb-6 mt-1 text-sm text-muted">Acesso restrito à equipe e aos representantes.</p>
        <LoginForm />
      </div>
    </main>
  );
}
