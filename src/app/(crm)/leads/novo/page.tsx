import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/server/session";
import { NewLeadForm } from "./new-lead-form";

export const metadata: Metadata = { title: "Novo lead" };

export default async function NewLeadPage() {
  await requirePermission("lead:write");
  return (
    <main className="max-w-3xl">
      <Link href="/funil" className="text-sm text-muted underline">
        ← Voltar ao funil
      </Link>
      <h1 className="mt-3 font-display text-2xl font-bold tracking-tight">Novo lead</h1>
      <p className="mb-5 mt-1 text-sm text-muted">Cadastro manual. Registramos de onde veio o contato para cumprir a LGPD.</p>
      <div className="rounded-2xl border border-line bg-card p-5">
        <NewLeadForm />
      </div>
    </main>
  );
}
