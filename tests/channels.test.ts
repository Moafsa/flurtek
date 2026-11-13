// Canal WhatsApp (ConextBot): leitor de webhook, adaptador, webhook de entrada e executor de envios.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { db } from "@/lib/db";
import { ConextBotAdapter, pickMessageId } from "@/server/channels/conextbot";
import { MockAdapter } from "@/server/channels";
import { parseWebhook } from "@/server/channels/inbound";
import { validSignature } from "@/server/channels/signature";
import { ChannelError, insideWindow, isOptOut } from "@/server/channels/types";
import { handleWebhook } from "@/server/channels/webhook-service";
import { runExecutor } from "@/server/channels/executor";
import { decideAction, setAgentEnabled } from "@/server/agent/service";
import { sendHumanMessage } from "@/server/conversations/service";
import { isAgentEnabled } from "@/server/settings";
import type { Actor } from "@/server/leads/rules";

const PREFIX = "ZZ Canal";
const PH = "5554990001111"; // número de teste
const PH_OWNER = "5554990002222";
let admin: Actor, comercial: Actor;
let n = 0;
const metaMsg = (from: string, body: string, id = `wamid.zz${Date.now()}${n++}`, ts = Math.floor(Date.now() / 1000)) => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: `${PREFIX} Cliente` } }], messages: [{ id, from, timestamp: String(ts), type: "text", text: { body } }] } }] }],
});

async function actor(email: string): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { id: u.id, role: u.role, states: u.states };
}

async function cleanup() {
  const contacts = await db.contact.findMany({ where: { OR: [{ phoneKey: { in: [PH, PH_OWNER] } }, { name: { startsWith: PREFIX } }] }, select: { id: true } });
  const ids = contacts.map((c) => c.id);
  const leads = await db.lead.findMany({ where: { OR: [{ contactId: { in: ids } }, { title: { startsWith: PREFIX } }] }, select: { id: true } });
  await db.agentAction.deleteMany({ where: { leadId: { in: leads.map((l) => l.id) } } });
  await db.conversation.deleteMany({ where: { OR: [{ externalId: { in: [PH, PH_OWNER] } }, { leadId: { in: leads.map((l) => l.id) } }] } });
  await db.lead.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } });
  await db.contact.deleteMany({ where: { id: { in: ids } } });
  await db.authorizedNumber.deleteMany({ where: { phoneKey: PH_OWNER } });
  await db.webhookEvent.deleteMany({ where: { provider: "conextbot", payload: { string_contains: "zz" } as never } }).catch(() => undefined);
}

beforeAll(async () => {
  [admin, comercial] = await Promise.all([actor("admin@flurtek.local"), actor("comercial@flurtek.local")]);
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("leitor de webhook", () => {
  it("lê mensagem e status no formato estilo Meta", () => {
    const p = parseWebhook({
      entry: [{ changes: [{ value: { contacts: [{ wa_id: "5554991268955", profile: { name: "Ana" } }], messages: [{ id: "wamid.1", from: "5554991268955", timestamp: "1790000000", type: "text", text: { body: "Olá" } }], statuses: [{ id: "wamid.0", status: "delivered" }, { id: "wamid.9", status: "failed", errors: [{ message: "fora da janela" }] }] } }] }],
    });
    expect(p.recognized).toBe(true);
    expect(p.messages).toEqual([expect.objectContaining({ id: "wamid.1", from: "5554991268955", name: "Ana", text: "Olá", type: "text" })]);
    expect(p.statuses).toEqual([{ id: "wamid.0", status: "entregue", error: undefined }, { id: "wamid.9", status: "falhou", error: "fora da janela" }]);
  });

  it("lê o formato plano e o envelope data", () => {
    expect(parseWebhook({ event: "message", id: "m1", from: "5554991268955", text: "oi" }).messages[0]).toMatchObject({ id: "m1", text: "oi" });
    expect(parseWebhook({ data: { messages: [{ id: "m2", from: "5554991268955", type: "text", text: { body: "x" } }] } }).messages).toHaveLength(1);
    expect(parseWebhook({ event: "status", id: "m1", status: "read" }).statuses[0]!.status).toBe("lida");
  });

  it("mídia vira marcador e lixo não é reconhecido", () => {
    expect(parseWebhook({ entry: [{ changes: [{ value: { messages: [{ id: "a", from: "5554991268955", type: "audio" }] } }] }] }).messages[0]!.text).toBe("[audio]");
    for (const junk of [null, 42, "x", [], {}, { entry: "no" }, { entry: [{ changes: [{ value: {} }] }] }]) {
      const r = parseWebhook(junk);
      expect(r.messages).toEqual([]);
      expect(r.recognized).toBe(false);
    }
  });

  it("palavras de saída e janela de 24 h", () => {
    for (const t of ["sair", "SAIR!", " Parar ", "pare", "Não quero mais"]) expect(isOptOut(t)).toBe(true);
    expect(isOptOut("quero sair da fila de espera mais tarde")).toBe(false);
    const now = new Date("2026-10-27T12:00:00Z");
    expect(insideWindow(new Date("2026-10-27T00:00:01Z"), now)).toBe(true);
    expect(insideWindow(new Date("2026-10-26T11:59:00Z"), now)).toBe(false);
    expect(insideWindow(null, now)).toBe(false);
  });

  it("assinatura HMAC", () => {
    const raw = '{"a":1}';
    const sig = createHmac("sha256", "segredo").update(raw).digest("hex");
    expect(validSignature(raw, `sha256=${sig}`, "segredo")).toBe(true);
    expect(validSignature(raw, sig, "segredo")).toBe(true);
    expect(validSignature(raw, sig, "outro")).toBe(false);
    expect(validSignature(raw, null, "segredo")).toBe(false);
    expect(validSignature(raw + " ", sig, "segredo")).toBe(false);
  });
});

describe("adaptador do ConextBot", () => {
  it("monta o pedido como no portal e lê o id da resposta", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const a = new ConextBotAdapter("https://app.conext.click/", "cxk_teste", async (url, init) => {
      seen = { url, init: init! };
      return new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 });
    });
    const r = await a.sendText({ to: "5554991268955", body: "Olá!" });
    expect(r.externalId).toBe("wamid.OK");
    expect(seen!.url).toBe("https://app.conext.click/api/v1/messages");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer cxk_teste");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ to: "5554991268955", type: "text", text: { body: "Olá!" } });
  });

  it("erros: 401 não repete, 429 e 500 podem repetir, rede cai em repetível", async () => {
    const mk = (status: number, body = "{}") => new ConextBotAdapter("https://x", "k", async () => new Response(body, { status }));
    await expect(mk(401, '{"error":"chave inválida"}').sendText({ to: "1", body: "x" })).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("chave inválida") });
    await expect(mk(429).sendText({ to: "1", body: "x" })).rejects.toMatchObject({ retryable: true });
    await expect(mk(503).sendText({ to: "1", body: "x" })).rejects.toMatchObject({ retryable: true });
    const net = new ConextBotAdapter("https://x", "k", async () => { throw new Error("rede"); });
    await expect(net.sendText({ to: "1", body: "x" })).rejects.toBeInstanceOf(ChannelError);
  });

  it("aceita formatos comuns de id", () => {
    expect(pickMessageId({ id: "a" })).toBe("a");
    expect(pickMessageId({ data: { message_id: "b" } })).toBe("b");
    expect(pickMessageId({ messages: [{ id: "c" }] })).toBe("c");
    expect(pickMessageId({})).toBeNull();
  });

  it("a chave nunca aparece na mensagem de erro", async () => {
    const a = new ConextBotAdapter("https://x", "cxk_segredo_123", async () => new Response("{}", { status: 400 }));
    await expect(a.sendText({ to: "1", body: "x" })).rejects.not.toMatchObject({ message: expect.stringContaining("cxk_segredo_123") });
  });
});

describe("webhook de entrada", () => {
  it("cliente novo cria contato, lead, conversa e mensagem, e abre a janela de 24 h", async () => {
    const s = await handleWebhook(metaMsg(PH, "Oi, vocês entregam água de 20L?"));
    expect(s).toMatchObject({ recognized: true, messages: 1, duplicates: 0 });
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "WHATSAPP", externalId: PH } }, include: { lead: { include: { contact: true } }, messages: true } });
    expect(conv.kind).toBe("CLIENTE");
    expect(conv.mode).toBe("AGENTE");
    expect(conv.unread).toBe(1);
    expect(insideWindow(conv.lastInboundAt)).toBe(true);
    expect(conv.lead?.source).toBe("WHATSAPP");
    expect(conv.lead?.consentSource).toBe("whatsapp_inbound");
    expect(conv.lead?.contact?.phoneKey).toBe(PH);
    expect(conv.messages[0]).toMatchObject({ author: "CLIENTE", status: "recebida" });
  });

  it("a mesma mensagem duas vezes não duplica", async () => {
    const payload = metaMsg(PH, "repetida", "wamid.zz-dup-1");
    await handleWebhook(payload);
    const again = await handleWebhook(payload);
    expect(again.duplicates).toBe(1);
    expect(await db.message.count({ where: { externalId: "wamid.zz-dup-1" } })).toBe(1);
  });

  it("reaproveita o contato do formulário do site (com e sem o 9)", async () => {
    const co = await db.contact.create({ data: { name: `${PREFIX} do Site`, phone: "(54) 3999-0003", phoneKey: "555439990003" } });
    const lead = await db.lead.create({ data: { title: `${PREFIX} Site`, contactId: co.id, uf: "RS" } });
    await handleWebhook(metaMsg("5554939990003", "vim pelo site"));
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "WHATSAPP", externalId: "5554939990003" } } });
    expect(conv.leadId).toBe(lead.id);
    await db.conversation.delete({ where: { id: conv.id } });
  });

  it("atualiza o status de uma mensagem enviada", async () => {
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "WHATSAPP", externalId: PH } } });
    await db.message.create({ data: { conversationId: conv.id, author: "AGENTE", body: "x", externalId: "wamid.zz-out-1", status: "enviada" } });
    const s = await handleWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.zz-out-1", status: "read" }] } }] }] });
    expect(s.statuses).toBe(1);
    expect((await db.message.findUniqueOrThrow({ where: { externalId: "wamid.zz-out-1" } })).status).toBe("lida");
  });

  it("'sair' bloqueia envios e entrega a conversa à equipe", async () => {
    await handleWebhook(metaMsg(PH, "SAIR"));
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "WHATSAPP", externalId: PH } }, include: { lead: { include: { contact: true } } } });
    expect(conv.mode).toBe("HUMANO");
    expect(conv.lead?.contact?.optOutAt).not.toBeNull();
    expect(await db.leadEvent.count({ where: { leadId: conv.leadId!, kind: "optout" } })).toBe(1);
  });

  it("número autorizado vira conversa do dono e não cria lead", async () => {
    await db.authorizedNumber.create({ data: { phoneKey: PH_OWNER, name: `${PREFIX} Dono`, role: "DONO", verifiedAt: new Date() } });
    const before = await db.lead.count();
    const s = await handleWebhook(metaMsg(PH_OWNER, "Como estão as vendas?"));
    expect(s.ownerMessages).toBe(1);
    expect(await db.lead.count()).toBe(before);
    const conv = await db.conversation.findUniqueOrThrow({ where: { channel_externalId: { channel: "WHATSAPP", externalId: PH_OWNER } } });
    expect(conv.kind).toBe("DONO");
  });

  it("payload desconhecido é guardado bruto e não quebra", async () => {
    const s = await handleWebhook({ coisa: "estranha", zz: true });
    expect(s.recognized).toBe(false);
    expect(await db.webhookEvent.count({ where: { provider: "conextbot", processedAt: { not: null } } })).toBeGreaterThan(0);
  });
});

describe("executor de envios", () => {
  let leadId = "", convId = "";

  async function setup(opts: { inbound?: Date | null; optOut?: boolean } = {}) {
    await cleanup();
    const contact = await db.contact.create({ data: { name: `${PREFIX} Exec`, phone: `+${PH}`, phoneKey: PH, optOutAt: opts.optOut ? new Date() : null } });
    const lead = await db.lead.create({ data: { title: `${PREFIX} Exec`, contactId: contact.id, uf: "RS" } });
    const conv = await db.conversation.create({ data: { leadId: lead.id, channel: "WHATSAPP", externalId: PH, lastInboundAt: opts.inbound === undefined ? new Date() : opts.inbound } });
    leadId = lead.id;
    convId = conv.id;
  }
  const newApproved = async (draft = "Olá! Segue a informação que você pediu.") => {
    const a = await db.agentAction.create({ data: { leadId, conversationId: convId, tool: "rascunhar_mensagem", kind: "follow_up", draft, confidence: 90 } });
    await decideAction(comercial, a.id, "APROVAR");
    return a.id;
  };

  beforeEach(async () => {
    if (!(await isAgentEnabled())) await setAgentEnabled(admin, true);
  });

  it("envia a ação aprovada, registra a mensagem e marca como executada", async () => {
    await setup();
    const id = await newApproved();
    const ch = new MockAdapter();
    const r = await runExecutor({ channel: ch });
    expect(r.actionsSent).toBe(1);
    expect(ch.sent).toEqual([{ to: PH, body: "Olá! Segue a informação que você pediu." }]);
    const a = await db.agentAction.findUniqueOrThrow({ where: { id } });
    expect(a.status).toBe("EXECUTADA");
    expect(a.executedAt).not.toBeNull();
    const m = await db.message.findFirstOrThrow({ where: { conversationId: convId, author: "AGENTE" } });
    expect(m.status).toBe("enviada");
    expect(m.externalId).toMatch(/^mock-/);
    expect(await db.leadEvent.count({ where: { leadId, actorType: "AGENTE", kind: "agente" } })).toBe(1);
  });

  it("não envia duas vezes quando roda de novo", async () => {
    await setup();
    await newApproved();
    const ch = new MockAdapter();
    await runExecutor({ channel: ch });
    const again = await runExecutor({ channel: ch });
    expect(again.actionsSent).toBe(0);
    expect(ch.sent).toHaveLength(1);
  });

  it("dois executores ao mesmo tempo enviam uma vez só", async () => {
    await setup();
    await newApproved();
    const ch = new MockAdapter();
    await Promise.all([runExecutor({ channel: ch }), runExecutor({ channel: ch })]);
    expect(ch.sent).toHaveLength(1);
  });

  it("nunca envia o que ainda está pendente ou foi rejeitado", async () => {
    await setup();
    await db.agentAction.create({ data: { leadId, conversationId: convId, tool: "t", kind: "follow_up", draft: "pendente", confidence: 50 } });
    const rej = await db.agentAction.create({ data: { leadId, conversationId: convId, tool: "t", kind: "follow_up", draft: "rejeitada", confidence: 50 } });
    await decideAction(comercial, rej.id, "REJEITAR");
    const ch = new MockAdapter();
    const r = await runExecutor({ channel: ch });
    expect(r.actionsSent).toBe(0);
    expect(ch.sent).toHaveLength(0);
  });

  it("fora da janela de 24 h falha com motivo e não envia", async () => {
    await setup({ inbound: new Date(Date.now() - 30 * 3_600_000) });
    const id = await newApproved();
    const ch = new MockAdapter();
    const r = await runExecutor({ channel: ch });
    expect(r.actionsFailed).toBe(1);
    expect(ch.sent).toHaveLength(0);
    const a = await db.agentAction.findUniqueOrThrow({ where: { id } });
    expect(a.status).toBe("FALHOU");
    expect(a.error).toContain("fora_da_janela_24h");
  });

  it("quem pediu para sair nunca recebe", async () => {
    await setup({ optOut: true });
    const id = await newApproved();
    const ch = new MockAdapter();
    await runExecutor({ channel: ch });
    expect(ch.sent).toHaveLength(0);
    expect((await db.agentAction.findUniqueOrThrow({ where: { id } })).error).toContain("opt-out");
  });

  it("agente pausado não envia ações, e a equipe continua enviando", async () => {
    await setup();
    const id = await newApproved();
    await sendHumanMessage(comercial, convId, "Mensagem da equipe");
    await setAgentEnabled(admin, false);
    const ch = new MockAdapter();
    const r = await runExecutor({ channel: ch });
    expect(r.skipped).toContain("agente_pausado");
    expect(r.teamSent).toBe(1);
    expect(ch.sent.map((m) => m.body)).toEqual(["Mensagem da equipe"]);
    expect((await db.agentAction.findUniqueOrThrow({ where: { id } })).status).toBe("APROVADA");
  });

  it("teto diário por lead", async () => {
    await setup();
    for (let i = 0; i < 3; i++) await db.message.create({ data: { conversationId: convId, author: "AGENTE", body: `antes ${i}`, status: "enviada" } });
    const id = await newApproved();
    const ch = new MockAdapter();
    await runExecutor({ channel: ch });
    expect(ch.sent).toHaveLength(0);
    expect((await db.agentAction.findUniqueOrThrow({ where: { id } })).error).toContain("limite_diario");
  });

  it("erro do canal: falha definitiva marca FALHOU, e o texto aprovado não se perde", async () => {
    await setup();
    const id = await newApproved();
    const bad = { name: "ruim", sendText: async () => { throw new ChannelError("ConextBot recusou o envio: chave inválida", false); } };
    const r = await runExecutor({ channel: bad });
    expect(r.actionsFailed).toBe(1);
    const a = await db.agentAction.findUniqueOrThrow({ where: { id } });
    expect(a).toMatchObject({ status: "FALHOU", executedAt: null });
    expect(a.draft).toContain("Segue a informação");
  });

  it("mensagem da equipe é enviada e marcada; sem janela, falha com motivo", async () => {
    await setup();
    const msg = await sendHumanMessage(comercial, convId, "Olá, aqui é o comercial.");
    const ch = new MockAdapter();
    expect((await runExecutor({ channel: ch })).teamSent).toBe(1);
    expect((await db.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("enviada");

    await setup({ inbound: null });
    const late = await sendHumanMessage(comercial, convId, "Oi de novo");
    const r = await runExecutor({ channel: new MockAdapter() });
    expect(r.teamFailed).toBe(1);
    expect((await db.message.findUniqueOrThrow({ where: { id: late.id } })).error).toContain("fora_da_janela_24h");
  });

  it("sem telefone nem conversa, a ação falha com motivo", async () => {
    await cleanup();
    const lead = await db.lead.create({ data: { title: `${PREFIX} SemCanal`, uf: "RS" } });
    const a = await db.agentAction.create({ data: { leadId: lead.id, tool: "t", kind: "follow_up", draft: "Olá, tudo bem?", confidence: 80 } });
    await decideAction(comercial, a.id, "APROVAR");
    const ch = new MockAdapter();
    await runExecutor({ channel: ch });
    expect(ch.sent).toHaveLength(0);
    expect((await db.agentAction.findUniqueOrThrow({ where: { id: a.id } })).error).toContain("sem_canal");
  });
});
