import type { Metadata } from "next";
import { dateOnly } from "@/lib/format";
import { requirePermission } from "@/server/session";
import { listCustomers } from "@/server/customers/service";

export const metadata: Metadata = { title: "Clientes e recompra" };
export const dynamic = "force-dynamic";

export default async function ClientesPage() {
  const user = await requirePermission("lead:read");
  const rows = await listCustomers(user);

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Clientes e recompra</h1>
      <p className="mb-4 mt-1 text-sm text-muted">O ciclo de consumo de cada cliente e o dia em que a reposição deve acontecer.</p>

      <section className="overflow-x-auto rounded-2xl border border-line bg-card" aria-label="Clientes">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Produto</th>
              <th className="px-4 py-3">Última compra</th>
              <th className="px-4 py-3">Ciclo</th>
              <th className="px-4 py-3">Próxima reposição</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const late = c.daysToRestock < 0;
              const soon = !late && c.daysToRestock <= 7;
              return (
                <tr key={c.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <p className="font-semibold">{c.name}</p>
                    <p className="text-xs text-muted">{c.uf ?? ""} · {c.totalOrders} pedido(s)</p>
                  </td>
                  <td className="px-4 py-3">{c.product}</td>
                  <td className="px-4 py-3 text-muted">{dateOnly(c.lastOrderAt)}</td>
                  <td className="px-4 py-3 text-muted">{c.cycleDays} dias</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-1 font-display text-xs font-semibold ${late ? "bg-bad-bg text-bad" : soon ? "bg-warn-bg text-warn" : "bg-ok-bg text-ok"}`}>
                      {late ? `atrasada ${Math.abs(c.daysToRestock)} dias` : c.daysToRestock === 0 ? "hoje" : `em ${c.daysToRestock} dias`}
                    </span>
                    <span className="ml-2 text-xs text-muted">{dateOnly(c.nextRestockAt)}</span>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  Nenhum cliente com pedido ainda.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
      <p className="mt-3 text-xs text-muted">Os lembretes automáticos de recompra pelo agente chegam junto com o canal de WhatsApp.</p>
    </main>
  );
}
