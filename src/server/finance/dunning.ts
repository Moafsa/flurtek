// Lembrete de cobrança vencida. O agente só propõe o texto; vai para aprovação (tem valor e link).
import { db } from "@/lib/db";
import { createAction, levelFor, resolveLevel } from "@/server/agent/operation";
import { draftIssues } from "@/server/agent/guardrails";
import { insideWindow } from "@/server/channels/types";
import { brl } from "@/server/finance/service";

const DAY = 86_400_000;

export async function runDunning(now = new Date()): Promise<number> {
  const overdue = await db.charge.findMany({
    where: { status: "VENCIDA", paymentUrl: { not: null }, dueDate: { lt: new Date(now.getTime() - DAY) } },
    include: { order: { include: { customer: { include: { company: { include: { contacts: true, leads: { orderBy: { createdAt: "desc" }, take: 1 } } } } } } } },
  });
  let created = 0;
  for (const c of overdue) {
    if (c.remindedAt && now.getTime() - c.remindedAt.getTime() < 5 * DAY) continue; // no máximo um lembrete a cada 5 dias
    const company = c.order.customer.company;
    const lead = company.leads[0];
    const contact = company.contacts.find((x) => x.phoneKey && !x.optOutAt);
    if (!lead || !contact) continue;
    const conv = await db.conversation.findFirst({ where: { leadId: lead.id, channel: "WHATSAPP", kind: "CLIENTE" }, orderBy: { updatedAt: "desc" } });
    const needsTemplate = !insideWindow(conv?.lastInboundAt, now);
    const text = `Olá! Aqui é a Flurtek. Identificamos que a cobrança de ${brl(Number(c.value))} do seu pedido de ${c.order.product} está em aberto. Se já pagou, desconsidere. Para pagar: ${c.paymentUrl}`;
    const { level, forcedBy } = resolveLevel({ policy: await levelFor("lembrete_cobranca"), kind: "followup", confidence: 85, issues: draftIssues(text), needsTemplate });
    const r = await createAction({ leadId: lead.id, conversationId: conv?.id ?? null, kind: "lembrete_cobranca", draft: text, confidence: 85, reason: `Cobrança vencida em ${c.dueDate.toLocaleDateString("pt-BR")}.`, level, forcedBy, needsTemplate, brain: "regras" });
    if (r === "human") continue;
    await db.charge.update({ where: { id: c.id }, data: { remindedAt: now } });
    created++;
  }
  return created;
}
