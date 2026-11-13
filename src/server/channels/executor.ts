// Executor de envios. Pega o que já foi decidido por uma pessoa (mensagens da equipe e ações aprovadas
// do agente) e envia pelo canal, respeitando as travas. Nunca envia sem decisão registrada.
import { db } from "@/lib/db";
import { writeAudit } from "@/server/audit";
import { getChannel } from "@/server/channels";
import { ChannelError, insideWindow, type ChannelAdapter } from "@/server/channels/types";
import { getQuietHours, isAgentEnabled, isQuietNow } from "@/server/settings";

export type ExecutorOptions = { channel?: ChannelAdapter; now?: Date; maxAgentMessagesPerLeadPerDay?: number };
export type ExecutorSummary = {
  skipped?: string;
  teamSent: number;
  teamFailed: number;
  actionsSent: number;
  actionsFailed: number;
  ownerSent: number;
  ownerQueued: number;
};

const CHAT_DAILY_CAP = 60;
const FREEFORM_BLOCKED ="fora_da_janela_24h: só é possível enviar modelo aprovado. Peça ao cliente para responder ou use um modelo.";

async function resolveConversation(action: { conversationId: string | null; leadId: string | null }) {
  if (action.conversationId) return db.conversation.findUnique({ where: { id: action.conversationId } });
  if (!action.leadId) return null;
  const existing = await db.conversation.findFirst({ where: { leadId: action.leadId, channel: "WHATSAPP", kind: "CLIENTE" }, orderBy: { updatedAt: "desc" } });
  if (existing) return existing;
  // Sem conversa ainda: só cria se o lead tem telefone. Ela nasce sem janela aberta (o cliente ainda não escreveu).
  const lead = await db.lead.findUnique({ where: { id: action.leadId }, include: { contact: true } });
  const key = lead?.contact?.phoneKey;
  if (!key) return null;
  return db.conversation.upsert({
    where: { channel_externalId: { channel: "WHATSAPP", externalId: key } },
    update: {},
    create: { channel: "WHATSAPP", externalId: key, leadId: action.leadId, mode: "AGENTE" },
  });
}

async function blocked(conv: { leadId: string | null; externalId: string | null; lastInboundAt: Date | null; channel: string }, now: Date): Promise<string | null> {
  if (conv.channel === "CHAT_SITE") return null; // a conversa vive na página: sem janela de 24 h
  if (conv.channel !== "WHATSAPP" || !conv.externalId) return "canal_nao_suportado: só WhatsApp e o chat do site estão conectados.";
  if (!insideWindow(conv.lastInboundAt, now)) return FREEFORM_BLOCKED;
  if (conv.leadId) {
    const lead = await db.lead.findUnique({ where: { id: conv.leadId }, include: { contact: true } });
    if (lead?.contact?.optOutAt) return "contato_pediu_para_nao_receber (opt-out).";
  }
  return null;
}

export async function runExecutor(opts: ExecutorOptions = {}): Promise<ExecutorSummary> {
  const channel = opts.channel ?? getChannel();
  const now = opts.now ?? new Date();
  const cap = opts.maxAgentMessagesPerLeadPerDay ?? 3;
  const out: ExecutorSummary = { teamSent: 0, teamFailed: 0, actionsSent: 0, actionsFailed: 0, ownerSent: 0, ownerQueued: 0 };

  // 1) Mensagens escritas pela equipe, aguardando envio. Não dependem da chave do agente.
  const pendingTeam = await db.message.findMany({
    where: { author: "EQUIPE", status: null, conversation: { kind: "CLIENTE" } },
    include: { conversation: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const m of pendingTeam) {
    // Reivindica a mensagem antes de enviar (evita envio duplo se dois executores rodarem juntos).
    const claim = await db.message.updateMany({ where: { id: m.id, status: null }, data: { status: "enviando" } });
    if (claim.count === 0) continue;
    const why = await blocked(m.conversation, now);
    if (why) {
      await db.message.update({ where: { id: m.id }, data: { status: "falhou", error: why } });
      out.teamFailed++;
      continue;
    }
    try {
      // No chat do site a mensagem é entregue quando o visitante a busca; basta marcá-la como enviada.
      const sent = m.conversation.channel === "CHAT_SITE" ? { externalId: null } : await channel.sendText({ to: m.conversation.externalId!, body: m.body });
      await db.message.update({ where: { id: m.id }, data: { status: "enviada", externalId: sent.externalId, error: null } });
      out.teamSent++;
    } catch (e) {
      const retry = e instanceof ChannelError && e.retryable;
      await db.message.update({ where: { id: m.id }, data: { status: retry ? null : "falhou", error: String(e instanceof Error ? e.message : e).slice(0, 300) } });
      out.teamFailed++;
    }
  }

  // 1b) Mensagens do agente para o dono (relatórios, avisos, respostas). Só saem com a janela de 24 h aberta;
  // fora dela ficam esperando e saem quando o dono escrever.
  const ownerPending = await db.message.findMany({
    where: { author: "AGENTE", status: null, conversation: { kind: "DONO" } },
    include: { conversation: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const m of ownerPending) {
    const claim = await db.message.updateMany({ where: { id: m.id, status: null }, data: { status: "enviando" } });
    if (claim.count === 0) continue;
    if (!m.conversation.externalId || !insideWindow(m.conversation.lastInboundAt, now)) {
      await db.message.update({ where: { id: m.id }, data: { status: "aguardando_janela" } });
      out.ownerQueued++;
      continue;
    }
    try {
      const sent = await channel.sendText({ to: m.conversation.externalId, body: m.body });
      await db.message.update({ where: { id: m.id }, data: { status: "enviada", externalId: sent.externalId, error: null } });
      out.ownerSent++;
    } catch (e) {
      const retry = e instanceof ChannelError && e.retryable;
      await db.message.update({ where: { id: m.id }, data: { status: retry ? null : "falhou", error: String(e instanceof Error ? e.message : e).slice(0, 300) } });
    }
  }

  // 2) Ações do agente já aprovadas. Chave geral pausada: nada do agente é enviado.
  if (!(await isAgentEnabled())) return { ...out, skipped: "agente_pausado (a equipe continua enviando)" };

  // Horário de silêncio definido pelo dono: nada do agente sai para clientes nesse período.
  // O chat do site é atendimento ao vivo (o visitante está na página), então não entra nessa regra.
  const quiet = isQuietNow(now, await getQuietHours());
  let skippedQuiet = false;

  const approved = await db.agentAction.findMany({
    where: { status: "APROVADA", executedAt: null, draft: { not: null } },
    orderBy: { decidedAt: "asc" },
    take: 25,
  });
  for (const a of approved) {
    if (quiet) {
      const c = await resolveConversation(a);
      if (c?.channel !== "CHAT_SITE") {
        skippedQuiet = true;
        continue;
      }
    }
    // executedAt funciona como trava de reivindicação.
    const claim = await db.agentAction.updateMany({ where: { id: a.id, status: "APROVADA", executedAt: null }, data: { executedAt: now } });
    if (claim.count === 0) continue;

    const fail = async (error: string) => {
      await db.agentAction.update({ where: { id: a.id }, data: { status: "FALHOU", executedAt: null, error: error.slice(0, 300) } });
      if (a.leadId) await db.leadEvent.create({ data: { leadId: a.leadId, actorType: "SISTEMA", kind: "agente", text: `Não foi possível enviar a mensagem aprovada: ${error.slice(0, 160)}` } });
      out.actionsFailed++;
    };

    const conv = await resolveConversation(a);
    if (!conv) {
      await fail("sem_canal: o lead não tem conversa nem telefone de WhatsApp.");
      continue;
    }
    const why = await blocked(conv, now);
    if (why) {
      await fail(why);
      continue;
    }
    // Teto diário por lead (proteção do número contra excesso de envio).
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const sentToday = await db.message.count({ where: { conversationId: conv.id, author: "AGENTE", createdAt: { gte: since } } });
    const chat = conv.channel === "CHAT_SITE";
    const limit = chat ? CHAT_DAILY_CAP : cap; // conversa ao vivo tem teto maior
    if (sentToday >= limit) {
      await fail(`limite_diario: o agente já enviou ${sentToday} mensagens a este lead nas últimas 24 h.`);
      continue;
    }

    try {
      const sent = chat ? { externalId: null } : await channel.sendText({ to: conv.externalId!, body: a.draft! });
      await db.$transaction([
        db.message.create({ data: { conversationId: conv.id, author: "AGENTE", body: a.draft!, externalId: sent.externalId, status: "enviada", meta: { actionId: a.id } } }),
        db.agentAction.update({ where: { id: a.id }, data: { status: "EXECUTADA", executedAt: now, error: null, conversationId: conv.id } }),
        ...(a.leadId
          ? [db.leadEvent.create({ data: { leadId: a.leadId, actorType: "AGENTE", kind: "agente", text: `Enviou a mensagem aprovada (${a.kind.replaceAll("_", " ")}) ${chat ? "pelo chat do site" : "pelo WhatsApp"}.` } }), db.lead.update({ where: { id: a.leadId }, data: { lastContactAt: now } })]
          : []),
      ]);
      await writeAudit({ action: "agente.acao_executada", actorType: "AGENTE", entity: "AgentAction", entityId: a.id, meta: { canal: channel.name } });
      out.actionsSent++;
    } catch (e) {
      await fail(String(e instanceof Error ? e.message : e));
    }
  }
  return skippedQuiet ? { ...out, skipped: "horario_de_silencio" } : out;
}
