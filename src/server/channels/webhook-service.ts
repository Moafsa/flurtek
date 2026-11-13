// Processa o que chega do ConextBot: guarda o bruto, cria/atualiza conversa, lead e mensagem, e trata "sair".
import { db } from "@/lib/db";
import { normalizePhone, samePhone } from "@/lib/phone";
import { writeAudit } from "@/server/audit";
import { isOptOut } from "@/server/channels/types";
import { parseWebhook, type InboundMessage } from "@/server/channels/inbound";
import type { Prisma } from "@prisma/client";
import { notifyWatchers } from "@/server/owner/notify";

export type WebhookSummary = { recognized: boolean; messages: number; duplicates: number; statuses: number; ownerMessages: number; optOuts: number };

async function findOrCreateCustomer(msg: InboundMessage, phoneKey: string) {
  // Acha pelo telefone (com e sem o 9) para não duplicar quem já preencheu o formulário do site.
  let contact = await db.contact.findFirst({ where: { phoneKey }, orderBy: { createdAt: "desc" } });
  if (!contact) {
    const alt = phoneKey.length === 13 ? phoneKey.slice(0, 4) + phoneKey.slice(5) : phoneKey.length === 12 ? phoneKey.slice(0, 4) + "9" + phoneKey.slice(4) : null;
    if (alt) contact = await db.contact.findFirst({ where: { phoneKey: alt }, orderBy: { createdAt: "desc" } });
  }
  if (!contact) {
    contact = await db.contact.create({ data: { name: msg.name ?? `WhatsApp ${phoneKey.slice(-4)}`, phone: `+${phoneKey}`, phoneKey } });
  }
  let lead = await db.lead.findFirst({
    where: { contactId: contact.id, stage: { notIn: ["FECHADO", "PERDIDO"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!lead) {
    lead = await db.lead.create({
      data: {
        title: contact.name,
        contactId: contact.id,
        companyId: contact.companyId,
        source: "WHATSAPP",
        agentOwned: true,
        nextAction: "Responder ao cliente que iniciou a conversa pelo WhatsApp.",
        consentAt: new Date(),
        consentText: "O próprio cliente iniciou a conversa pelo WhatsApp.",
        consentSource: "whatsapp_inbound",
        events: { create: { actorType: "SISTEMA", kind: "criado", text: "Cliente iniciou conversa pelo WhatsApp." } },
      },
    });
  }
  return { contact, lead };
}

export async function handleWebhook(payload: unknown): Promise<WebhookSummary> {
  const summary: WebhookSummary = { recognized: false, messages: 0, duplicates: 0, statuses: 0, ownerMessages: 0, optOuts: 0 };
  const event = await db.webhookEvent.create({ data: { provider: "conextbot", payload: payload as Prisma.InputJsonValue } });

  try {
    const parsed = parseWebhook(payload);
    summary.recognized = parsed.recognized;

    for (const msg of parsed.messages) {
      if (await db.message.findUnique({ where: { externalId: msg.id } })) {
        summary.duplicates++;
        continue;
      }
      const phoneKey = normalizePhone(msg.from);
      if (!phoneKey) continue;

      const owners = await db.authorizedNumber.findMany({ where: { active: true } });
      const owner = owners.find((a) => samePhone(a.phoneKey, phoneKey)) ?? null;

      // Conversa com número autorizado (dono ou gestor): fica separada dos clientes. Não vira lead.
      if (owner) {
        const conv =
          (await db.conversation.findUnique({ where: { channel_externalId: { channel: "WHATSAPP", externalId: owner.phoneKey } } })) ??
          (await db.conversation.create({ data: { channel: "WHATSAPP", externalId: owner.phoneKey, kind: "DONO", mode: "AGENTE" } }));
        await db.message.create({ data: { conversationId: conv.id, author: "CLIENTE", body: msg.text, externalId: msg.id, status: "recebida", meta: { remetente: owner.name, papel: owner.role }, createdAt: msg.at } });
        await db.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: msg.at, unread: { increment: 1 } } });
        // O dono escreveu: a janela de 24 h abriu, então o que estava esperando pode sair.
        await db.message.updateMany({ where: { conversationId: conv.id, author: "AGENTE", status: "aguardando_janela" }, data: { status: null } });
        summary.ownerMessages++;
        continue;
      }

      const { contact, lead } = await findOrCreateCustomer(msg, phoneKey);
      const conv =
        (await db.conversation.findUnique({ where: { channel_externalId: { channel: "WHATSAPP", externalId: phoneKey } } })) ??
        (await db.conversation.create({ data: { channel: "WHATSAPP", externalId: phoneKey, leadId: lead.id, mode: "AGENTE" } }));
      if (!conv.leadId) await db.conversation.update({ where: { id: conv.id }, data: { leadId: lead.id } });

      await db.message.create({ data: { conversationId: conv.id, author: "CLIENTE", body: msg.text, externalId: msg.id, status: "recebida", createdAt: msg.at } });
      await db.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: msg.at, unread: { increment: 1 } } });
      await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: msg.at } });
      summary.messages++;
      await notifyWatchers(lead.id, lead.title, msg.text);

      // "sair": para de enviar para esse contato e entrega a conversa à equipe.
      if (isOptOut(msg.text)) {
        await db.$transaction([
          db.contact.update({ where: { id: contact.id }, data: { optOutAt: new Date() } }),
          db.conversation.update({ where: { id: conv.id }, data: { mode: "HUMANO" } }),
          db.leadEvent.create({ data: { leadId: lead.id, actorType: "SISTEMA", kind: "optout", text: 'O cliente pediu para não receber mais mensagens ("sair"). Envios automáticos foram bloqueados.' } }),
          db.message.create({ data: { conversationId: conv.id, author: "SISTEMA", body: "Cliente pediu para não receber mais mensagens." } }),
        ]);
        await writeAudit({ action: "contato.optout", actorType: "SISTEMA", entity: "Contact", entityId: contact.id });
        summary.optOuts++;
      }
    }

    for (const s of parsed.statuses) {
      const res = await db.message.updateMany({ where: { externalId: s.id }, data: { status: s.status, ...(s.error ? { error: s.error.slice(0, 300) } : {}) } });
      if (res.count) summary.statuses++;
    }

    await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  } catch (error) {
    await db.webhookEvent.update({ where: { id: event.id }, data: { error: String(error).slice(0, 500) } });
    throw error;
  }
  return summary;
}
