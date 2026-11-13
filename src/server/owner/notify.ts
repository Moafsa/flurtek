// Mensagens do agente para o dono. Entram numa fila (Message AGENTE sem status na conversa DONO);
// o executor envia quando a janela de 24 h do dono está aberta.
import { db } from "@/lib/db";

// Conversa do dono com este número (cria se não existir).
export async function ownerConversation(phoneKey: string) {
  return (
    (await db.conversation.findUnique({ where: { channel_externalId: { channel: "WHATSAPP", externalId: phoneKey } } })) ??
    (await db.conversation.create({ data: { channel: "WHATSAPP", externalId: phoneKey, kind: "DONO", mode: "AGENTE" } }))
  );
}

export async function queueOwnerMessage(phoneKey: string, body: string, meta: Record<string, unknown> = {}) {
  const conv = await ownerConversation(phoneKey);
  return db.message.create({ data: { conversationId: conv.id, author: "AGENTE", body, meta: { owner: true, ...meta } } });
}

// Avisa todos os donos verificados. dedupeKey evita repetir o mesmo aviso no mesmo dia.
export async function notifyOwners(body: string, opts: { dedupeKey?: string; roles?: string[] } = {}): Promise<number> {
  const numbers = await db.authorizedNumber.findMany({ where: { active: true, verifiedAt: { not: null }, role: { in: opts.roles ?? ["DONO"] } } });
  let sent = 0;
  for (const n of numbers) {
    if (opts.dedupeKey) {
      const dup = await db.message.findFirst({ where: { conversation: { kind: "DONO", externalId: n.phoneKey }, meta: { path: ["dedupeKey"], equals: opts.dedupeKey } } });
      if (dup) continue;
    }
    await queueOwnerMessage(n.phoneKey, body, { notificacao: true, ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}) });
    sent++;
  }
  return sent;
}

// Chamado quando um cliente observado escreve: avisa quem pediu e encerra a vigilância.
export async function notifyWatchers(leadId: string, leadTitle: string, snippet: string): Promise<number> {
  const watches = await db.ownerWatch.findMany({ where: { leadId, active: true } });
  for (const w of watches) {
    await queueOwnerMessage(w.phoneKey, `*${leadTitle}* respondeu: “${snippet.slice(0, 160)}”`, { notificacao: true, watch: w.id });
    await db.ownerWatch.update({ where: { id: w.id }, data: { active: false } });
  }
  return watches.length;
}
