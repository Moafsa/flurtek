// Chat do site: visitante ↔ agente (canal CHAT_SITE). Prefixo "ZZ Chat"; worker parado.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { MockAdapter } from "@/server/channels";
import { runExecutor } from "@/server/channels/executor";
import { ChatError, chatState, sendVisitorMessage } from "@/server/chat/service";
import { processConversation } from "@/server/agent/operation";
import { MockBrain } from "@/server/agent/brain";
import { putSetting, QUIET_HOURS_KEY } from "@/server/settings";
import { resetRateLimits } from "@/server/ratelimit";
import { GET as chatGet, POST as chatPost } from "@/app/api/public/chat/route";

const PREFIX = "ZZ Chat";
const ORIGIN = "http://localhost:3100";

async function cleanup() {
  const convs = await db.conversation.findMany({ where: { channel: "CHAT_SITE" }, select: { id: true, leadId: true } });
  const leadIds = convs.map((c) => c.leadId).filter(Boolean) as string[];
  const leads = await db.lead.findMany({ where: { id: { in: leadIds } }, select: { contactId: true } });
  await db.agentAction.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { conversationId: { in: convs.map((c) => c.id) } }] } });
  await db.task.deleteMany({ where: { leadId: { in: leadIds } } });
  await db.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await db.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.id) } } });
  await db.lead.deleteMany({ where: { id: { in: leadIds } } });
  await db.contact.deleteMany({ where: { id: { in: leads.map((l) => l.contactId).filter(Boolean) as string[] } } });
}

beforeEach(async () => {
  await cleanup();
  resetRateLimits();
  await putSetting(QUIET_HOURS_KEY, null);
});
afterAll(cleanup);

const hello = (extra: object = {}) => ({ message: "Para que serve a água desmineralizada?", consent: true, ...extra });

describe("sessão e consentimento", () => {
  it("sem aceitar a política não cria nada; aceitando, cria contato, lead e conversa", async () => {
    await expect(sendVisitorMessage({ message: "oi" })).rejects.toMatchObject({ code: "CONSENTIMENTO" });
    expect(await db.conversation.count({ where: { channel: "CHAT_SITE" } })).toBe(0);
    const r = await sendVisitorMessage(hello({ pageUrl: "https://x/agua" }));
    expect(r.sessionId).toMatch(/^[a-f0-9]{32}$/);
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: r.sessionId } }, include: { lead: true } });
    expect(conv.mode).toBe("AGENTE");
    expect(conv.lead).toMatchObject({ source: "CHAT_SITE", agentOwned: true, consentSource: "chat_site" });
    expect(conv.lead!.consentText).toMatch(/Política de Privacidade/);
    expect(r.state.waiting).toBe(true);
  });

  it("continua a mesma sessão; dados de contato informados atualizam o contato e o título do lead", async () => {
    const a = await sendVisitorMessage(hello());
    const b = await sendVisitorMessage({ sessionId: a.sessionId, message: "Sou da Oficina Teste", name: `${PREFIX} Maria`, email: "Maria@Teste.com", phone: "(54) 99111-2222" });
    expect(b.sessionId).toBe(a.sessionId);
    const lead = await db.lead.findFirstOrThrow({ where: { source: "CHAT_SITE" }, include: { contact: true } });
    expect(lead.title).toBe(`${PREFIX} Maria · chat do site`);
    expect(lead.contact).toMatchObject({ name: `${PREFIX} Maria`, email: "maria@teste.com", phoneKey: "5554991112222" });
    expect(await db.conversation.count({ where: { channel: "CHAT_SITE" } })).toBe(1);
  });

  it("valida a mensagem: vazia, longa demais, isca preenchida", async () => {
    await expect(sendVisitorMessage({ message: "   ", consent: true })).rejects.toBeInstanceOf(ChatError);
    await expect(sendVisitorMessage({ message: "x".repeat(1001), consent: true })).rejects.toThrow(/longa demais/);
    await expect(sendVisitorMessage(hello({ website: "http://spam" }))).rejects.toThrow(/recusada/);
    expect(await db.conversation.count({ where: { channel: "CHAT_SITE" } })).toBe(0);
  });

  it("limita o número de mensagens por sessão no dia", async () => {
    const a = await sendVisitorMessage(hello());
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: a.sessionId } } });
    await db.message.createMany({ data: Array.from({ length: 80 }, () => ({ conversationId: conv.id, author: "CLIENTE" as const, body: "spam" })) });
    await expect(sendVisitorMessage({ sessionId: a.sessionId, message: "mais uma" })).rejects.toMatchObject({ code: "LIMITE" });
  });

  it("o token da sessão é a credencial: id inventado ou formato errado não lê nada", async () => {
    await sendVisitorMessage(hello());
    await expect(chatState("0".repeat(32))).rejects.toMatchObject({ code: "NAO_ENCONTRADO" });
    await expect(chatState("../../etc")).rejects.toMatchObject({ code: "NAO_ENCONTRADO" });
  });

  it("pedido de saída no chat marca o contato como opt-out", async () => {
    const a = await sendVisitorMessage(hello());
    await sendVisitorMessage({ sessionId: a.sessionId, message: "sair" });
    const lead = await db.lead.findFirstOrThrow({ where: { source: "CHAT_SITE" }, include: { contact: true } });
    expect(lead.contact!.optOutAt).not.toBeNull();
  });
});

describe("agente responde no chat", () => {
  it("dúvida técnica: o agente responde sozinho e a resposta chega ao visitante, sem WhatsApp", async () => {
    const r = await sendVisitorMessage(hello());
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: r.sessionId } } });
    await processConversation(conv.id, { brain: new MockBrain() });
    const wa = new MockAdapter();
    const ex = await runExecutor({ channel: wa });
    expect(ex.actionsSent).toBeGreaterThanOrEqual(1);
    expect(wa.sent).toHaveLength(0); // nada foi para o WhatsApp
    const s = await chatState(r.sessionId);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ author: "AGENTE" });
    expect(s.messages[0]!.text.length).toBeGreaterThan(20);
    expect(s.waiting).toBe(false);
    // o cursor devolve só o que é novo
    expect((await chatState(r.sessionId, s.messages[0]!.id)).messages).toHaveLength(0);
  });

  it("assunto sensível (preço e desconto) vai para a equipe com aviso padrão ao visitante", async () => {
    const r = await sendVisitorMessage({ message: "Quanto custa o IBC? Tem desconto?", consent: true });
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: r.sessionId } } });
    await processConversation(conv.id, { brain: new MockBrain() });
    await runExecutor({ channel: new MockAdapter() });
    const s = await chatState(r.sessionId);
    expect(s.mode).toBe("HUMANO");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.text).toMatch(/equipe/i);
    expect(await db.task.count({ where: { leadId: conv.leadId!, title: { startsWith: "Retornar ao cliente" } } })).toBe(1);
  });

  it("não vaza notas internas nem mensagens do sistema para o visitante", async () => {
    const r = await sendVisitorMessage({ message: "Quanto custa o IBC? Tem desconto?", consent: true });
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: r.sessionId } } });
    await processConversation(conv.id, { brain: new MockBrain() });
    await runExecutor({ channel: new MockAdapter() });
    const texts = (await chatState(r.sessionId)).messages.map((m) => m.text).join(" ");
    expect(texts).not.toMatch(/Conversa entregue à equipe|Assunto sensível/);
  });

  it("a equipe responde pelo CRM e o visitante recebe como 'Equipe'", async () => {
    const r = await sendVisitorMessage({ message: "Quanto custa o IBC? Tem desconto?", consent: true });
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: r.sessionId } } });
    await processConversation(conv.id, { brain: new MockBrain() });
    await db.message.create({ data: { conversationId: conv.id, author: "EQUIPE", body: "Olá! Aqui é a equipe comercial, já preparo a cotação." } });
    const wa = new MockAdapter();
    const ex = await runExecutor({ channel: wa });
    expect(ex.teamSent).toBe(1);
    expect(wa.sent).toHaveLength(0);
    const s = await chatState(r.sessionId);
    expect(s.messages.some((m) => m.author === "EQUIPE" && /equipe comercial/.test(m.text))).toBe(true);
  });

  it("o horário de silêncio não segura o chat, mas segura o WhatsApp", async () => {
    await putSetting(QUIET_HOURS_KEY, { start: 0, end: 23 });
    const r = await sendVisitorMessage(hello());
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "CHAT_SITE", externalId: r.sessionId } } });
    await processConversation(conv.id, { brain: new MockBrain() });
    const ex = await runExecutor({ channel: new MockAdapter(), now: new Date("2026-10-27T15:00:00Z") });
    expect(ex.actionsSent).toBeGreaterThanOrEqual(1);
    expect((await chatState(r.sessionId)).messages).toHaveLength(1);
  });
});

describe("API pública do chat", () => {
  const key = () => process.env.INTAKE_SITE_KEY!;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    chatPost(new Request("http://x/api/public/chat", { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-site-key": key(), "x-forwarded-for": "10.9.9.9", ...headers }, body: JSON.stringify(body) }));
  const get = (qs: string, headers: Record<string, string> = {}) => chatGet(new Request(`http://x/api/public/chat${qs}`, { headers: { "x-forwarded-for": "10.9.9.9", ...headers } }));

  it("exige origem permitida e a chave do site", async () => {
    expect((await post(hello(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(hello(), { "x-site-key": "errada" })).status).toBe(401);
    expect((await get("?s=" + "a".repeat(32), { origin: "https://evil.example" })).status).toBe(403);
  });

  it("envia, busca e devolve 404 para sessão desconhecida", async () => {
    const res = await post(hello());
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, mode: "AGENTE", waiting: true });
    const poll = await (await get(`?s=${j.sessionId}`)).json();
    expect(poll).toMatchObject({ ok: true, messages: [] });
    expect((await get(`?s=${"b".repeat(32)}`)).status).toBe(404);
    expect((await post({ message: "oi" })).status).toBe(422);
  });

  it("limita sessões novas por IP e corpo grande", async () => {
    for (let i = 0; i < 6; i++) expect((await post(hello())).status).toBe(200);
    expect((await post(hello())).status).toBe(429);
    resetRateLimits();
    expect((await post({ message: "x".repeat(9000), consent: true })).status).toBe(413);
  });
});
