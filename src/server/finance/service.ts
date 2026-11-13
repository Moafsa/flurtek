// Financeiro: pedido → cobrança (Asaas) → conciliação por webhook → nota fiscal.
// Quem decide valor e vencimento é uma pessoa. O agente só avisa, lembra (com aprovação) e concilia.
import type { Charge, ChargeStatus, FiscalDoc, Order } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/server/audit";
import { can } from "@/server/rbac";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { getFiscal, getPayment } from "@/server/finance";
import type { BillingType } from "@/server/finance/types";
import { getSetting } from "@/server/settings";
import { FISCAL_CONFIG_KEY, fiscalMissing, getFiscalConfig, type FiscalConfig } from "@/server/finance/fiscal-config";
import { REGIMES } from "@/server/finance/fiscal-regimes";
import { notifyOwners } from "@/server/owner/notify";

export const AUTO_INVOICE_KEY = "finance.autoInvoice";

function need(actor: Actor, permission: "finance:read" | "finance:write" | "finance:admin") {
  if (!can(actor.role, permission)) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
}

export const brl = (v: number | { toString(): string }) => Number(v.toString()).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// ---------- pedidos ----------

export async function createOrder(actor: Actor, input: { customerId: string; product: string; volume?: string; value: number; notes?: string }): Promise<Order> {
  need(actor, "finance:write");
  if (!(input.value > 0)) throw new ServiceError("INVALIDO", "Informe um valor maior que zero.");
  if (!input.product.trim()) throw new ServiceError("INVALIDO", "Informe o produto.");
  const customer = await db.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw new ServiceError("NAO_ENCONTRADO", "Cliente não encontrado.");
  const order = await db.order.create({
    data: { customerId: input.customerId, product: input.product.trim(), volume: input.volume?.trim() || null, value: input.value, notes: input.notes?.trim() || null, orderedAt: new Date() },
  });
  await writeAudit({ action: "financeiro.pedido_criado", actorId: actor.id, entity: "Order", entityId: order.id, meta: { value: input.value } });
  return order;
}

// ---------- cobrança ----------

export async function createCharge(actor: Actor, orderId: string, input: { billingType: BillingType; dueDate: Date }): Promise<Charge> {
  need(actor, "finance:write");
  const order = await db.order.findUnique({ where: { id: orderId }, include: { customer: { include: { company: { include: { contacts: true } } } }, charges: true } });
  if (!order) throw new ServiceError("NAO_ENCONTRADO", "Pedido não encontrado.");
  if (order.status === "CANCELADO" || order.status === "PAGO") throw new ServiceError("INVALIDO", `Pedido ${order.status === "PAGO" ? "já pago" : "cancelado"}.`);
  if (!order.value || Number(order.value) <= 0) throw new ServiceError("INVALIDO", "O pedido não tem valor.");
  if (order.charges.some((c) => c.status === "PENDENTE" || c.status === "VENCIDA")) throw new ServiceError("INVALIDO", "Já existe uma cobrança em aberto para este pedido.");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (input.dueDate.getTime() < today.getTime()) throw new ServiceError("INVALIDO", "O vencimento não pode estar no passado.");

  const company = order.customer.company;
  const contact = company.contacts.find((c) => c.email || c.phone) ?? company.contacts[0];
  const provider = getPayment();
  const charge = await db.charge.create({
    data: { orderId, provider: provider.name, billingType: input.billingType, value: order.value, dueDate: input.dueDate, createdById: actor.id },
  });
  try {
    const result = await provider.createCharge({
      payer: { externalReference: order.customerId, name: company.name, cnpj: company.cnpj, email: contact?.email, phone: contact?.phone },
      billingType: input.billingType,
      value: Number(order.value),
      dueDate: input.dueDate,
      description: `${order.product}${order.volume ? ` · ${order.volume}` : ""} — Flurtek`,
      externalReference: charge.id,
    });
    const saved = await db.charge.update({ where: { id: charge.id }, data: { externalId: result.externalId, paymentUrl: result.paymentUrl, pixPayload: result.pixPayload } });
    await db.order.update({ where: { id: orderId }, data: { status: "FATURADO" } });
    await writeAudit({ action: "financeiro.cobranca_criada", actorId: actor.id, entity: "Charge", entityId: charge.id, meta: { provider: provider.name, value: Number(order.value), billingType: input.billingType } });
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "falha desconhecida";
    await db.charge.update({ where: { id: charge.id }, data: { status: "CANCELADA", error: message.slice(0, 300) } });
    await writeAudit({ action: "financeiro.cobranca_falhou", actorId: actor.id, entity: "Charge", entityId: charge.id, meta: { error: message.slice(0, 300) } });
    throw new ServiceError("INVALIDO", `Não foi possível criar a cobrança: ${message}`);
  }
}

export async function cancelCharge(actor: Actor, chargeId: string): Promise<void> {
  need(actor, "finance:admin");
  const charge = await db.charge.findUnique({ where: { id: chargeId } });
  if (!charge) throw new ServiceError("NAO_ENCONTRADO", "Cobrança não encontrada.");
  if (charge.status === "PAGA" || charge.status === "CANCELADA") throw new ServiceError("INVALIDO", "Esta cobrança não pode ser cancelada.");
  if (charge.externalId) {
    try {
      await getPayment().cancelCharge(charge.externalId);
    } catch (error) {
      throw new ServiceError("INVALIDO", `O gateway recusou o cancelamento: ${error instanceof Error ? error.message : "erro"}`);
    }
  }
  await db.charge.update({ where: { id: chargeId }, data: { status: "CANCELADA" } });
  await db.order.updateMany({ where: { id: charge.orderId, status: "FATURADO" }, data: { status: "ABERTO" } });
  await writeAudit({ action: "financeiro.cobranca_cancelada", actorId: actor.id, entity: "Charge", entityId: chargeId });
}

// ---------- conciliação (webhook do Asaas) ----------

const EVENT_STATUS: Record<string, ChargeStatus | undefined> = {
  PAYMENT_RECEIVED: "PAGA",
  PAYMENT_CONFIRMED: "PAGA",
  PAYMENT_OVERDUE: "VENCIDA",
  PAYMENT_DELETED: "CANCELADA",
  PAYMENT_REFUNDED: "ESTORNADA",
  PAYMENT_CHARGEBACK_REQUESTED: "ESTORNADA",
};

export type ReconcileResult = "ignorado" | "desconhecida" | "sem_mudanca" | "atualizada";

export async function applyPaymentEvent(ev: { event: string; paymentId: string; value?: number; paidAt?: Date }, now = new Date()): Promise<ReconcileResult> {
  const next = EVENT_STATUS[ev.event];
  if (!next) return "ignorado";
  const charge = await db.charge.findUnique({ where: { externalId: ev.paymentId }, include: { order: { include: { customer: { include: { company: true } } } } } });
  if (!charge) return "desconhecida";
  if (charge.status === next) return "sem_mudanca";
  // Cobrança paga não volta para vencida por evento atrasado.
  if (charge.status === "PAGA" && (next === "VENCIDA" || next === "CANCELADA")) return "sem_mudanca";

  const paid = next === "PAGA";
  await db.charge.update({ where: { id: charge.id }, data: { status: next, paidAt: paid ? (ev.paidAt ?? now) : charge.paidAt, paidValue: paid ? (ev.value ?? Number(charge.value)) : charge.paidValue } });
  if (paid) await db.order.update({ where: { id: charge.orderId }, data: { status: "PAGO" } });
  if (next === "ESTORNADA") await db.order.update({ where: { id: charge.orderId }, data: { status: "FATURADO" } });
  await writeAudit({ action: `financeiro.cobranca_${next.toLowerCase()}`, actorType: "SISTEMA", entity: "Charge", entityId: charge.id, meta: { event: ev.event } });

  const who = charge.order.customer.company.name;
  if (paid) {
    const diverge = ev.value !== undefined && Math.abs(ev.value - Number(charge.value)) > 0.009;
    await notifyOwners(`💰 *Pagamento recebido:* ${who} pagou ${brl(ev.value ?? Number(charge.value))}${diverge ? ` (a cobrança era de ${brl(Number(charge.value))}, confira)` : ""}.`, { dedupeKey: `pago:${charge.id}` });
    if (await getSetting<boolean>(AUTO_INVOICE_KEY, false)) {
      try {
        await emitInvoice(null, charge.orderId, { chargeId: charge.id });
      } catch (error) {
        await notifyOwners(`⚠️ Pagamento de ${who} conciliado, mas a nota fiscal não saiu: ${error instanceof Error ? error.message : "erro"}. Emita pelo CRM.`, { dedupeKey: `nf-erro:${charge.id}` });
      }
    }
  } else if (next === "ESTORNADA") {
    await notifyOwners(`↩️ *Estorno:* a cobrança de ${who} (${brl(Number(charge.value))}) foi estornada.`, { dedupeKey: `estorno:${charge.id}` });
  }
  return "atualizada";
}

// Marca como vencida, localmente, a cobrança cujo prazo passou (não depende de o gateway avisar).
export async function markOverdue(now = new Date()): Promise<number> {
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const due = await db.charge.findMany({ where: { status: "PENDENTE", dueDate: { lt: new Date(startOfToday.getTime() - 3 * 3_600_000) } }, include: { order: { include: { customer: { include: { company: true } } } } } });
  for (const c of due) {
    await db.charge.update({ where: { id: c.id }, data: { status: "VENCIDA" } });
    await writeAudit({ action: "financeiro.cobranca_vencida", actorType: "SISTEMA", entity: "Charge", entityId: c.id });
  }
  if (due.length) {
    const lines = due.slice(0, 5).map((c) => `• ${c.order.customer.company.name}: ${brl(Number(c.value))}`).join("\n");
    await notifyOwners(`⏰ *${due.length} cobrança(s) venceram:*\n${lines}\nQuer que eu prepare um lembrete? Ele só sai com a sua aprovação.`, { dedupeKey: `vencidas:${now.toISOString().slice(0, 10)}` });
  }
  return due.length;
}

// ---------- nota fiscal ----------

const EMITTER_UF = "RS";

// Reserva o próximo número da série (a SEFAZ não aceita repetir) e monta os parâmetros fiscais da nota.
async function buildFiscalParams(cfg: FiscalConfig, customerUf: string | null, product: string) {
  const fluid = /fluido|radiador|aditivo|arrefec/i.test(product);
  const number = await db.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: FISCAL_CONFIG_KEY } });
    const current = { ...cfg, ...((row?.value as object | null) ?? {}) } as FiscalConfig;
    await tx.setting.update({ where: { key: FISCAL_CONFIG_KEY }, data: { value: { ...current, nextNumber: Number(current.nextNumber) + 1 } as never } });
    return Number(current.nextNumber);
  });
  const regime = cfg.regime!;
  return {
    regime,
    crt: REGIMES[regime].crt,
    environment: cfg.environment,
    series: cfg.series,
    number,
    taxCode: cfg.taxCode,
    cfop: customerUf === EMITTER_UF ? cfg.cfopInState : cfg.cfopOutState,
    ncm: fluid ? cfg.ncmFluid : cfg.ncmWater,
  };
}

export async function emitInvoice(actor: Actor | null, orderId: string, opts: { kind?: "NFE" | "NFSE"; chargeId?: string } = {}): Promise<FiscalDoc> {
  if (actor) need(actor, "finance:write");
  const order = await db.order.findUnique({ where: { id: orderId }, include: { customer: { include: { company: true } }, fiscalDocs: true } });
  if (!order) throw new ServiceError("NAO_ENCONTRADO", "Pedido não encontrado.");
  const existing = order.fiscalDocs.find((d) => d.status === "EMITIDA" || d.status === "PENDENTE");
  if (existing) return existing; // idempotente: um pedido não gera duas notas
  if (order.status === "CANCELADO") throw new ServiceError("INVALIDO", "Pedido cancelado.");
  if (!order.value || Number(order.value) <= 0) throw new ServiceError("INVALIDO", "O pedido não tem valor.");
  const company = order.customer.company;
  const kind = opts.kind ?? "NFE"; // água e fluido são produto
  if (!company.cnpj) throw new ServiceError("INVALIDO", `Falta o CNPJ de ${company.name} para emitir a nota.`);

  const provider = getFiscal();
  const cfg = await getFiscalConfig();
  // Emissão real só com a configuração fiscal completa; no modo simulado a configuração é opcional.
  if (provider.name !== "mock") {
    const missing = fiscalMissing(cfg);
    if (missing.length) throw new ServiceError("INVALIDO", `Configuração fiscal incompleta: falta ${missing.join(", ")}.`);
  }
  const fiscal = provider.name === "mock" ? undefined : await buildFiscalParams(cfg, company.uf, order.product);
  const doc = await db.fiscalDoc.create({ data: { orderId, chargeId: opts.chargeId, kind, provider: provider.name, createdById: actor?.id } });
  try {
    const r = await provider.emit({ kind, orderId, customerName: company.name, cnpj: company.cnpj, total: Number(order.value), items: [{ description: order.product, quantity: order.volume, value: Number(order.value) }], fiscal });
    const saved = await db.fiscalDoc.update({
      where: { id: doc.id },
      data: { externalId: r.externalId, number: r.number, series: r.series, accessKey: r.accessKey, pdfUrl: r.pdfUrl, xmlUrl: r.xmlUrl, status: r.status, emittedAt: r.status === "EMITIDA" ? new Date() : null },
    });
    await writeAudit({ action: "financeiro.nota_emitida", actorId: actor?.id ?? null, actorType: actor ? "USUARIO" : "SISTEMA", entity: "FiscalDoc", entityId: doc.id, meta: { kind, number: r.number ?? null, provider: provider.name } });
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "falha desconhecida";
    await db.fiscalDoc.update({ where: { id: doc.id }, data: { status: "ERRO", error: message.slice(0, 300) } });
    await writeAudit({ action: "financeiro.nota_falhou", actorId: actor?.id ?? null, entity: "FiscalDoc", entityId: doc.id, meta: { error: message.slice(0, 300) } });
    throw new ServiceError("INVALIDO", `Não foi possível emitir a nota: ${message}`);
  }
}

export async function cancelInvoice(actor: Actor, docId: string, reason: string): Promise<void> {
  need(actor, "finance:admin");
  if (reason.trim().length < 15) throw new ServiceError("INVALIDO", "Explique o motivo do cancelamento (mínimo 15 caracteres).");
  const doc = await db.fiscalDoc.findUnique({ where: { id: docId } });
  if (!doc || doc.status !== "EMITIDA") throw new ServiceError("INVALIDO", "Só nota emitida pode ser cancelada.");
  if (doc.externalId) await getFiscal().cancel(doc.externalId, reason.trim());
  await db.fiscalDoc.update({ where: { id: docId }, data: { status: "CANCELADA" } });
  await writeAudit({ action: "financeiro.nota_cancelada", actorId: actor.id, entity: "FiscalDoc", entityId: docId, meta: { reason: reason.trim() } });
}

// ---------- consultas ----------

export type FinanceSummary = { aReceber: number; vencido: number; recebidoMes: number; qtdAberta: number; qtdVencida: number; semNota: number };

export async function financeSummary(actor: Actor, now = new Date()): Promise<FinanceSummary> {
  need(actor, "finance:read");
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [open, paid, semNota] = await Promise.all([
    db.charge.findMany({ where: { status: { in: ["PENDENTE", "VENCIDA"] } }, select: { value: true, status: true } }),
    db.charge.aggregate({ where: { status: "PAGA", paidAt: { gte: monthStart } }, _sum: { paidValue: true } }),
    db.order.count({ where: { status: "PAGO", fiscalDocs: { none: { status: { in: ["EMITIDA", "PENDENTE"] } } } } }),
  ]);
  const sum = (rows: { value: { toString(): string } }[]) => rows.reduce((t, r) => t + Number(r.value.toString()), 0);
  const overdue = open.filter((c) => c.status === "VENCIDA");
  return { aReceber: sum(open), vencido: sum(overdue), recebidoMes: Number(paid._sum.paidValue ?? 0), qtdAberta: open.length, qtdVencida: overdue.length, semNota };
}

export async function listCharges(actor: Actor, filter: { status?: ChargeStatus } = {}) {
  need(actor, "finance:read");
  return db.charge.findMany({
    where: filter.status ? { status: filter.status } : {},
    orderBy: [{ dueDate: "asc" }],
    take: 200,
    include: { order: { include: { customer: { include: { company: { select: { name: true, uf: true } } } }, fiscalDocs: true } } },
  });
}

export async function listOrders(actor: Actor) {
  need(actor, "finance:read");
  return db.order.findMany({
    orderBy: { orderedAt: "desc" },
    take: 200,
    include: { customer: { include: { company: { select: { name: true, cnpj: true } } } }, charges: { orderBy: { createdAt: "desc" } }, fiscalDocs: { orderBy: { createdAt: "desc" } } },
  });
}
