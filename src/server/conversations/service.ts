import { z } from "zod";
import { db } from "@/lib/db";
import { can, type Permission } from "@/server/rbac";
import { writeAudit } from "@/server/audit";
import { inScope, ServiceError, type Actor } from "@/server/leads/rules";

function need(actor: Actor, permission: Permission) {
  if (!can(actor.role, permission)) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
}

// Representante só vê conversas de leads dos estados dele (conversa sem lead fica oculta).
async function loadScoped(actor: Actor, id: string) {
  const conv = await db.conversation.findUnique({ where: { id }, include: { lead: { select: { id: true, title: true, uf: true } } } });
  if (!conv) throw new ServiceError("NAO_ENCONTRADO", "Conversa não encontrada.");
  if (conv.kind === "DONO" && actor.role !== "ADMIN") throw new ServiceError("NAO_ENCONTRADO", "Conversa não encontrada.");
  if (actor.role === "REPRESENTANTE" && (!conv.lead || !inScope(actor, conv.lead))) {
    throw new ServiceError("NAO_ENCONTRADO", "Conversa não encontrada.");
  }
  return conv;
}

export async function listConversations(actor: Actor) {
  need(actor, "conversation:read");
  const where = {
    ...(actor.role === "REPRESENTANTE" ? { lead: { uf: { in: actor.states } } } : {}),
    ...(actor.role === "ADMIN" ? {} : { kind: "CLIENTE" }),
  };
  return db.conversation.findMany({
    where,
    include: { lead: { select: { id: true, title: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
}

export async function getConversation(actor: Actor, id: string) {
  need(actor, "conversation:read");
  const conv = await loadScoped(actor, id);
  const messages = await db.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" }, take: 500 });
  return { conv, messages };
}

export async function markRead(actor: Actor, id: string) {
  need(actor, "conversation:read");
  await loadScoped(actor, id);
  await db.conversation.update({ where: { id }, data: { unread: 0 } });
}

const bodySchema = z.string().trim().min(1, "Escreva a mensagem.").max(4000, "Mensagem muito longa.");

// Mensagem da equipe. Sem canal conectado, fica registrada como "aguardando envio";
// ao enviar, o agente sai da conversa (modo HUMANO).
export async function sendHumanMessage(actor: Actor, id: string, body: string) {
  need(actor, "conversation:write");
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw new ServiceError("INVALIDO", parsed.error.issues[0]!.message);
  const conv = await loadScoped(actor, id);
  const [msg] = await db.$transaction([
    db.message.create({
      data: { conversationId: id, author: "EQUIPE", body: parsed.data, meta: { autorId: actor.id, entrega: "aguardando_canal" } },
    }),
    db.conversation.update({ where: { id }, data: { mode: "HUMANO", unread: 0 } }),
  ]);
  if (conv.leadId) await db.lead.update({ where: { id: conv.leadId }, data: { lastContactAt: new Date() } });
  await writeAudit({ action: "conversa.mensagem_equipe", actorId: actor.id, entity: "Conversation", entityId: id });
  return msg;
}

export async function setConversationMode(actor: Actor, id: string, mode: "AGENTE" | "HUMANO") {
  need(actor, "conversation:write");
  const conv = await loadScoped(actor, id);
  if (conv.mode === mode) return conv;
  const [updated] = await db.$transaction([
    db.conversation.update({ where: { id }, data: { mode } }),
    db.message.create({
      data: { conversationId: id, author: "SISTEMA", body: mode === "HUMANO" ? "Conversa assumida pela equipe." : "Conversa devolvida ao agente." },
    }),
  ]);
  await writeAudit({ action: "conversa.modo", actorId: actor.id, entity: "Conversation", entityId: id, meta: { mode } });
  return updated;
}
