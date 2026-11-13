import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requirePermission } from "@/server/session";
import { ROLE_LABEL, ROLES, isRole } from "@/server/rbac";
import { setActiveAction, setRoleAction } from "./actions";
import { NewUserForm } from "./new-user-form";

export const metadata: Metadata = { title: "Usuários" };
export const dynamic = "force-dynamic";

export default async function UsuariosPage() {
  const me = await requirePermission("user:manage");
  const users = await db.user.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Usuários e papéis</h1>
      <p className="mt-1 text-sm text-muted">Quem acessa o CRM e o que cada papel pode fazer. Todas as mudanças ficam no registro de auditoria.</p>

      <section className="mt-6 overflow-x-auto rounded-2xl border border-line bg-card" aria-label="Lista de usuários">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Papel</th>
              <th className="px-4 py-3">Estados</th>
              <th className="px-4 py-3">Último acesso</th>
              <th className="px-4 py-3">Situação</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-line align-middle">
                <td className="px-4 py-3">
                  <p className="font-semibold">{u.name}</p>
                  <p className="text-muted">{u.email}</p>
                </td>
                <td className="px-4 py-3">
                  {u.id === me.id ? (
                    ROLE_LABEL[isRole(u.role) ? u.role : "LEITURA"]
                  ) : (
                    <form action={setRoleAction} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={u.id} />
                      <select name="role" defaultValue={u.role} aria-label={`Papel de ${u.name}`} className="min-h-10 rounded-lg border border-line bg-white px-2">
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                      <button className="min-h-10 rounded-lg border border-line px-3 hover:border-olive">Salvar</button>
                    </form>
                  )}
                </td>
                <td className="px-4 py-3">{u.states.length ? u.states.join(", ") : "—"}</td>
                <td className="px-4 py-3 text-muted">
                  {u.lastLoginAt ? u.lastLoginAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "nunca"}
                </td>
                <td className="px-4 py-3">
                  {u.id === me.id ? (
                    <span className="rounded-full bg-ok-bg px-2.5 py-1 text-xs font-semibold text-ok">Você</span>
                  ) : (
                    <form action={setActiveAction}>
                      <input type="hidden" name="id" value={u.id} />
                      <input type="hidden" name="active" value={String(!u.active)} />
                      <button className={`min-h-10 rounded-lg border px-3 ${u.active ? "border-line hover:border-bad hover:text-bad" : "border-olive text-olive"}`}>
                        {u.active ? "Desativar" : "Reativar"}
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-6 rounded-2xl border border-line bg-card p-5" aria-label="Novo usuário">
        <h2 className="mb-4 font-display text-base font-bold">Novo usuário</h2>
        <NewUserForm />
      </section>
    </main>
  );
}
