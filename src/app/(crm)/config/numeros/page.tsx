import type { Metadata } from "next";
import { db } from "@/lib/db";
import { maskPhone } from "@/lib/phone";
import { dateTime } from "@/lib/format";
import { requirePermission } from "@/server/session";
import { newCodeAction, toggleNumberAction } from "./actions";
import { NewNumberForm } from "./new-number-form";

export const metadata: Metadata = { title: "Números autorizados" };
export const dynamic = "force-dynamic";

export default async function NumerosPage() {
  await requirePermission("user:manage");
  const [numbers, users] = await Promise.all([
    db.authorizedNumber.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], include: { user: { select: { name: true } } } }),
    db.user.findMany({ where: { active: true, role: { in: ["ADMIN", "COMERCIAL"] } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Números autorizados</h1>
      <p className="mb-4 mt-1 text-sm text-muted">
        Só estes WhatsApps podem dar ordens ao agente. Cada número precisa ser verificado com um código. Mensagens de clientes nunca são ordens.
      </p>

      <section className="overflow-x-auto rounded-2xl border border-line bg-card" aria-label="Números cadastrados">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Número</th>
              <th className="px-4 py-3">Papel</th>
              <th className="px-4 py-3">Usuário</th>
              <th className="px-4 py-3">Verificação</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
              <tr key={n.id} className="border-t border-line align-middle">
                <td className="px-4 py-3 font-semibold">{n.name}</td>
                <td className="px-4 py-3 text-muted">{maskPhone(n.phoneKey)}</td>
                <td className="px-4 py-3">{n.role === "DONO" ? "Dono" : "Gestor"}</td>
                <td className="px-4 py-3 text-muted">{n.user?.name ?? "—"}</td>
                <td className="px-4 py-3">
                  {n.verifiedAt ? (
                    <span className="rounded-full bg-ok-bg px-2.5 py-1 font-display text-xs font-semibold text-ok">verificado {dateTime(n.verifiedAt)}</span>
                  ) : (
                    <form action={newCodeAction} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={n.id} />
                      <span className="rounded-full bg-warn-bg px-2.5 py-1 font-display text-xs font-semibold text-warn">não verificado</span>
                      <button className="min-h-9 rounded-lg border border-line px-3 text-xs font-semibold hover:border-olive">Gerar novo código</button>
                    </form>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <form action={toggleNumberAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="active" value={String(!n.active)} />
                    <button className={`min-h-9 rounded-lg border px-3 text-xs font-semibold ${n.active ? "border-line hover:border-bad hover:text-bad" : "border-olive text-olive"}`}>{n.active ? "Desativar" : "Reativar"}</button>
                  </form>
                </td>
              </tr>
            ))}
            {numbers.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted">
                  Nenhum número cadastrado ainda.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="mt-5 rounded-2xl border border-line bg-card p-5" aria-label="Novo número">
        <h2 className="mb-4 font-display text-base font-bold">Cadastrar número</h2>
        <NewNumberForm users={users} />
      </section>
    </main>
  );
}
