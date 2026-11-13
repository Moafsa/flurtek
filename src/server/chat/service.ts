// Chat do site: cada visitante é uma conversa do canal CHAT_SITE ligada a um lead.
// O visitante só conhece o token da sessão (128 bits). O agente responde pelo mesmo fluxo e travas do WhatsApp;
// as respostas ficam na conversa e o widget as busca (polling).
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { writeAudit } from "@/server/audit";
import { isOptOut } from "@/server/channels/types";

export const MAX_MESSAGE = 1000;
export const MAX_PER_SESSION_PER_DAY = 80;
const CONSENT_TEXT = "Aceite da Política de Privacidade para conversar com o assistente virtual no chat do site.";
const SESSION_RE = /^[a-f0-9]{32}$/;

export class ChatError extends Error {
  constructor(
    readonly code: "INVALIDO" | "CONSENTIMENTO" | "LIMITE" | "NAO_ENCONTRADO",
    message: string,
  ) {
    super(message);
  }
}

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+\n/g, "\n").trim();

export const sendSchema = z.object({
  sessionId: z.string().regex(SESSION_RE).optional(),
  message: z.string().max(5000).transform(clean).pipe(z.string().min(1, "Escreva uma mensagem.").max(MAX_MESSAGE, `Mensagem longa demais (máximo ${MAX_MESSAGE} caracteres).`)),
  consent: z.boolean().optional(),
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().max(120).email().optional().or(z.literal("")),
  phone: z.string().trim().max(30).optional(),
  pageUrl: z.string().max(300).optional(),
  website: z.string().max(100).optional(), // isca contra robôs: humanos não preenchem
});
export type SendInput = z.infer<typeof sendSchema>;

export type ChatMessageView = { id: string; author: "AGENTE" | "EQUIPE"; text: string; at: string };
export type ChatState = { messages: ChatMessageView[]; mode: "AGENTE" | "HUMANO"; waiting: boolean };

const newSession = () => randomBytes(16).toString("hex");

async function findConversation(sessionId: string) {
  return db.conversation.findUnique({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: sessionId } } });
}

async function applyVisitorDetails(leadId: string, contactId: string, input: SendInput) {
  const phoneKey = input.phone ? normalizePhone(input.phone) : null;
  const data: Record<string, unknown> = {};
  if (input.name) data.name = input.name;
  if (input.email) data.email = input.email.toLowerCase();
  if (phoneKey) {
    data.phone = `+${phoneKey}`;
    data.phoneKey = phoneKey;
  }
  if (!Object.keys(data).length) return;
  await db.contact.update({ where: { id: contactId }, data });
  if (input.name) await db.lead.update({ where: { id: leadId }, data: { title: `${input.name} · chat do site` } });
  await db.leadEvent.create({ data: { leadId, actorType: "SISTEMA", kind: "contato", text: "O visitante informou dados de contato no chat." } });
}

// Recebe uma mensagem do visitante. Sem sessionId (ou sessão nova), cria contato, lead e conversa.
export async function sendVisitorMessage(raw: unknown): Promise<{ sessionId: string; state: ChatState }> {
  const parsed = sendSchema.safeParse(raw);
  if (!parsed.success) throw new ChatError("INVALIDO", parsed.error.issues[0]!.message);
  const input = parsed.data;
  if (input.website) throw new ChatError("INVALIDO", "Mensagem recusada."); // isca preenchida

  let conv = input.sessionId ? await findConversation(input.sessionId) : null;
  let sessionId = input.sessionId ?? "";

  if (!conv) {
    if (!input.consent) throw new ChatError("CONSENTIMENTO", "Para conversar, aceite a Política de Privacidade.");
    sessionId = newSession();
    const now = new Date();
    const contact = await db.contact.create({ data: { name: "Visitante do site" } });
    const lead = await db.lead.create({
      data: {
        title: `Chat do site #${sessionId.slice(-4).toUpperCase()}`,
        contactId: contact.id,
        source: "CHAT_SITE",
        agentOwned: true,
        nextAction: "Responder ao visitante que iniciou o chat no site.",
        consentAt: now,
        consentText: CONSENT_TEXT,
        consentSource: "chat_site",
        events: { create: { actorType: "SISTEMA", kind: "criado", text: `Visitante iniciou o chat do site${input.pageUrl ? ` (página ${input.pageUrl.slice(0, 120)})` : ""}.` } },
      },
    });
    conv = await db.conversation.create({ data: { leadId: lead.id, channel: "CHAT_SITE", externalId: sessionId, mode: "AGENTE" } });
    await writeAudit({ action: "chat.sessao_criada", actorType: "SISTEMA", entity: "Conversation", entityId: conv.id });
  }

  const since = new Date(Date.now() - 86_400_000);
  if ((await db.message.count({ where: { conversationId: conv.id, author: "CLIENTE", createdAt: { gte: since } } })) >= MAX_PER_SESSION_PER_DAY) {
    throw new ChatError("LIMITE", "Muitas mensagens por hoje. Fale com a gente pelo WhatsApp.");
  }

  const now = new Date();
  await db.message.create({ data: { conversationId: conv.id, author: "CLIENTE", body: input.message, receivedAt: now, status: "recebida" } });
  await db.conversation.update({ where: { id: conv.id }, data: { lastInboundAt: now, unread: { increment: 1 } } });

  if (conv.leadId) {
    const lead = await db.lead.findUnique({ where: { id: conv.leadId } });
    if (lead?.contactId) await applyVisitorDetails(lead.id, lead.contactId, input);
    // Pedido de saída vale também no chat: encerra o contato proativo.
    if (lead?.contactId && isOptOut(input.message)) await db.contact.update({ where: { id: lead.contactId }, data: { optOutAt: now } });
  }
  return { sessionId, state: await chatState(sessionId) };
}

// Mensagens que o visitante pode ver (agente e equipe), a partir de um cursor (id da última recebida).
export async function chatState(sessionId: string, afterId?: string): Promise<ChatState> {
  if (!SESSION_RE.test(sessionId)) throw new ChatError("NAO_ENCONTRADO", "Sessão não encontrada.");
  const conv = await findConversation(sessionId);
  if (!conv) throw new ChatError("NAO_ENCONTRADO", "Sessão não encontrada.");
  const all = await db.message.findMany({ where: { conversationId: conv.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 });
  const visible = all.filter((m) => (m.author === "AGENTE" || m.author === "EQUIPE") && m.status === "enviada");
  const from = afterId ? visible.findIndex((m) => m.id === afterId) + 1 : 0;
  const lastClient = [...all].reverse().find((m) => m.author === "CLIENTE");
  const lastReply = visible.at(-1);
  return {
    messages: visible.slice(from).map((m) => ({ id: m.id, author: m.author as "AGENTE" | "EQUIPE", text: m.body, at: m.createdAt.toISOString() })),
    mode: conv.mode === "HUMANO" ? "HUMANO" : "AGENTE",
    waiting: Boolean(lastClient && (!lastReply || lastReply.createdAt < lastClient.receivedAt)),
  };
}
