import type { Metadata } from "next";
import { db } from "@/lib/db";
import { brl, dateOnly, tomorrowISO } from "@/lib/format";
import { can } from "@/server/rbac";
import { requirePermission } from "@/server/session";
import { financeSummary, listOrders } from "@/server/finance/service";
import { cancelChargeAction, createChargeAction, createOrderAction, emitInvoiceAction } from "./actions";

export const metadata: Metadata = { title: "Financeiro" };
export const dynamic = "force-dynamic";

const field = "min-h-10 rounded-lg border border-line bg-white px-3 text-sm font-normal";
const btn = "min-h-9 rounded-lg border border-line px-3 text-xs font-semibold hover:border-olive";
const STATUS: Record<string, string> = { PENDENTE: "bg-warn-bg text-warn", VENCIDA: "bg-bad-bg text-bad", PAGA: "bg-ok-bg text-ok", CANCELADA: "bg-line text-muted", ESTORNADA: "bg-bad-bg text-bad" };

export default async function FinanceiroPage({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const user = await requirePermission("finance:read");
  const sp = await searchParams;
  const canWrite = can(user.role, "finance:write");
  const canAdmin = can(user.role, "finance:admin");
  const [sum, orders, customers] = await Promise.all([
    financeSummary(user),
    listOrders(user),
    canWrite ? db.customer.findMany({ include: { company: { select: { name: true } } }, orderBy: { company: { name: "asc" } } }) : [],
  ]);
  const tomorrow = tomorrowISO();

  const tile = (label: string, value: string, tone = "") => (
    <div className="rounded-2xl border border-line bg-card p-4">
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 font-display text-2xl font-extrabold ${tone}`}>{value}</p>
    </div>
  );

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Financeiro</h1>
      <p className="mb-4 mt-1 text-sm text-muted">Pedidos, cobranças (Asaas) e notas fiscais. Valor e vencimento são sempre decididos por uma pessoa.</p>

      {sp.erro ? <p role="alert" className="mb-4 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{sp.erro}</p> : null}
      {sp.ok ? <p role="status" className="mb-4 rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok">{sp.ok}</p> : null}

      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Resumo">
        {tile("A receber", brl(sum.aReceber), "")}
        {tile("Vencido", brl(sum.vencido), sum.vencido > 0 ? "text-bad" : "")}
        {tile("Recebido no mês", brl(sum.recebidoMes), "text-ok")}
        {tile("Pagos sem nota", String(sum.semNota), sum.semNota > 0 ? "text-warn" : "")}
      </section>

      <section className="overflow-x-auto rounded-2xl border border-line bg-card" aria-label="Pedidos">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-3">Cliente / pedido</th>
              <th className="px-4 py-3">Valor</th>
              <th className="px-4 py-3">Cobrança</th>
              <th className="px-4 py-3">Nota fiscal</th>
              <th className="px-4 py-3">Ações</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const charge = o.charges.find((c) => c.status !== "CANCELADA") ?? null;
              const doc = o.fiscalDocs.find((d) => d.status === "EMITIDA" || d.status === "PENDENTE") ?? null;
              const open = charge && (charge.status === "PENDENTE" || charge.status === "VENCIDA");
              return (
                <tr key={o.id} className="border-t border-line align-top">
                  <td className="px-4 py-3">
                    <p className="font-semibold">{o.customer.company.name}</p>
                    <p className="text-xs text-muted">{o.product}{o.volume ? ` · ${o.volume}` : ""} · {dateOnly(o.orderedAt)}</p>
                  </td>
                  <td className="px-4 py-3">{o.value ? brl(Number(o.value), 2) : "—"}</td>
                  <td className="px-4 py-3">
                    {charge ? (
                      <div className="grid gap-1">
                        <span className={`w-fit rounded-full px-2.5 py-1 font-display text-xs font-semibold ${STATUS[charge.status]}`}>{charge.status.toLowerCase()}</span>
                        <span className="text-xs text-muted">vence {dateOnly(charge.dueDate)} · {charge.billingType}</span>
                        {charge.paymentUrl && open ? <a href={charge.paymentUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-olive underline">Link de pagamento</a> : null}
                      </div>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {doc ? (
                      <div className="grid gap-1">
                        <span className={`w-fit rounded-full px-2.5 py-1 font-display text-xs font-semibold ${doc.status === "EMITIDA" ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>{doc.kind} {doc.number ? `nº ${doc.number}` : doc.status.toLowerCase()}</span>
                        {doc.pdfUrl ? <a href={doc.pdfUrl} target="_blank" rel="noreferrer" className="text-xs font-semibold text-olive underline">Abrir PDF</a> : null}
                      </div>
                    ) : o.fiscalDocs.some((d) => d.status === "ERRO") ? (
                      <span className="text-xs text-bad">erro na última tentativa</span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {canWrite && o.status !== "CANCELADO" ? (
                      <div className="grid gap-2">
                        {!open && o.status !== "PAGO" ? (
                          <form action={createChargeAction} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="orderId" value={o.id} />
                            <select name="billingType" defaultValue="PIX" className={field} aria-label="Forma de pagamento">
                              <option value="PIX">Pix</option>
                              <option value="BOLETO">Boleto</option>
                              <option value="CREDIT_CARD">Cartão</option>
                              <option value="UNDEFINED">Cliente escolhe</option>
                            </select>
                            <input type="date" name="due" defaultValue={tomorrow} min={tomorrow.slice(0, 10)} className={field} aria-label="Vencimento" />
                            <button className={btn}>Gerar cobrança</button>
                          </form>
                        ) : null}
                        {!doc ? (
                          <form action={emitInvoiceAction}>
                            <input type="hidden" name="orderId" value={o.id} />
                            <button className={btn}>Emitir nota</button>
                          </form>
                        ) : null}
                        {canAdmin && open && charge ? (
                          <form action={cancelChargeAction}>
                            <input type="hidden" name="chargeId" value={charge.id} />
                            <button className={`${btn} hover:border-bad hover:text-bad`}>Cancelar cobrança</button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {orders.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  Nenhum pedido ainda.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {canWrite ? (
        <section className="mt-5 rounded-2xl border border-line bg-card p-5" aria-label="Novo pedido">
          <h2 className="mb-4 font-display text-base font-bold">Novo pedido</h2>
          <form action={createOrderAction} className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-semibold">
              Cliente
              <select name="customerId" required className={field} defaultValue="">
                <option value="" disabled>Escolha…</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.company.name}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">
              Produto
              <input name="product" required maxLength={120} placeholder="Água desmineralizada 20L" className={field} />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">
              Volume
              <input name="volume" maxLength={60} placeholder="10 galões" className={field} />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">
              Valor total (R$)
              <input name="value" required inputMode="decimal" placeholder="1.450,00" className={field} />
            </label>
            <div className="sm:col-span-2">
              <button className="min-h-11 rounded-lg bg-lime px-5 font-display font-semibold text-on-lime hover:bg-lime-dark">Criar pedido</button>
            </div>
          </form>
        </section>
      ) : null}
    </main>
  );
}
