// Integração contra o banco de desenvolvimento (precisa do seed). Dados de teste com prefixo "ZZ Agente".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { decideAction, listPendingActions, listPolicies, setAgentEnabled, setPolicy } from "@/server/agent/service";
import { getConversation, listConversations, sendHumanMessage, setConversationMode } from "@/server/conversations/service";
import { listCustomers, restockInfo } from "@/server/customers/service";
import { isAgentEnabled } from "@/server/settings";

const PREFIX = "ZZ Agente";
let admin: Actor, comercial: Actor, rep: Actor, leitura: Actor;
let leadRS = "", leadSC = "";
const actionIds: string[] = [];
const convIds: string[] = [];

async function actor(email: string): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { id: u.id, role: u.role, states: u.states };
}
async function expectError(p: Promise<unknown>, code: ServiceError["code"]) {
  await expect(p).rejects.toMatchObject({ name: "ServiceError", code });
}
async function newAction(leadId: string, draft = "Olá! Podemos enviar uma cotação sem compromisso?") {
  const a = await db.agentAction.create({ data: { leadId, tool: "rascunhar_mensagem", kind: "primeiro_contato_frio", draft, confidence: 80, reason: "teste" } });
  actionIds.push(a.id);
  return a;
}

beforeAll(async () => {
  [admin, comercial, rep, leitura] = await Promise.all([
    actor("admin@flurtek.local"),
    actor("comercial@flurtek.local"),
    actor("representante@flurtek.local"),
    actor("leitura@flurtek.local"),
  ]);
  const co = await db.company.create({ data: { name: `${PREFIX} RS`, uf: "RS" } });
  const cs = await db.company.create({ data: { name: `${PREFIX} SC`, uf: "SC" } });
  leadRS = (await db.lead.create({ data: { title: `${PREFIX} RS`, companyId: co.id, uf: "RS" } })).id;
  leadSC = (await db.lead.create({ data: { title: `${PREFIX} SC`, companyId: cs.id, uf: "SC" } })).id;
});

afterAll(async () => {
  await db.agentAction.deleteMany({ where: { id: { in: actionIds } } });
  await db.conversation.deleteMany({ where: { id: { in: convIds } } });
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  await db.lead.deleteMany({ where: { companyId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("aprovações do agente", () => {
  it("aprovar marca como aprovada, registra quem decidiu e entra na linha do tempo", async () => {
    const a = await newAction(leadRS);
    const done = await decideAction(comercial, a.id, "APROVAR");
    expect(done.status).toBe("APROVADA");
    expect(done.decidedById).toBe(comercial.id);
    expect(done.executedAt).toBeNull(); // aprovar não envia
    const ev = await db.leadEvent.findFirst({ where: { leadId: leadRS, kind: "agente" }, orderBy: { createdAt: "desc" } });
    expect(ev?.text).toContain("Aprovou");
    const audit = await db.auditLog.findFirst({ where: { entityId: a.id, action: "agente.acao_aprovada" } });
    expect(audit?.actorId).toBe(comercial.id);
  });

  it("aprova com o texto editado e guarda a edição", async () => {
    const a = await newAction(leadRS);
    const done = await decideAction(comercial, a.id, "APROVAR", "Texto ajustado pela equipe comercial.");
    expect(done.draft).toBe("Texto ajustado pela equipe comercial.");
    const ev = await db.leadEvent.findFirst({ where: { leadId: leadRS, kind: "agente" }, orderBy: { createdAt: "desc" } });
    expect(ev?.text).toContain("com edição");
  });

  it("rejeita texto editado muito curto", async () => {
    const a = await newAction(leadRS);
    await expectError(decideAction(comercial, a.id, "APROVAR", "oi"), "INVALIDO");
    expect((await db.agentAction.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("PENDENTE");
  });

  it("rejeitar não altera o texto e não envia", async () => {
    const a = await newAction(leadRS);
    const done = await decideAction(comercial, a.id, "REJEITAR");
    expect(done.status).toBe("REJEITADA");
    expect(done.draft).toBe(a.draft);
  });

  it("não decide duas vezes, nem em decisões simultâneas", async () => {
    const a = await newAction(leadRS);
    const results = await Promise.allSettled([decideAction(comercial, a.id, "APROVAR"), decideAction(admin, a.id, "REJEITAR")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expectError(decideAction(comercial, a.id, "APROVAR"), "INVALIDO");
  });

  it("só administrador e comercial revisam", async () => {
    const a = await newAction(leadRS);
    await expectError(decideAction(rep, a.id, "APROVAR"), "SEM_PERMISSAO");
    await expectError(decideAction(leitura, a.id, "APROVAR"), "SEM_PERMISSAO");
    await expectError(listPendingActions(rep), "SEM_PERMISSAO");
    expect((await listPendingActions(admin)).some((x) => x.id === a.id)).toBe(true);
  });

  it("ação inexistente", async () => {
    await expectError(decideAction(comercial, "nao-existe", "APROVAR"), "NAO_ENCONTRADO");
  });
});

describe("autonomia e chave geral", () => {
  it("administrador altera o nível e fica registrado", async () => {
    const before = (await db.autonomyPolicy.findUniqueOrThrow({ where: { task: "follow_up" } })).level;
    const target = before === "HUMANO" ? "APROVACAO" : "HUMANO";
    await setPolicy(admin, "follow_up", target);
    expect((await db.autonomyPolicy.findUniqueOrThrow({ where: { task: "follow_up" } })).level).toBe(target);
    expect(await db.auditLog.count({ where: { action: "agente.autonomia_alterada", entityId: "follow_up" } })).toBeGreaterThan(0);
    await setPolicy(admin, "follow_up", before);
  });

  it("preço e desconto nunca podem ser automáticos", async () => {
    await expectError(setPolicy(admin, "negociar_preco", "AUTOMATICO"), "INVALIDO");
    expect((await db.autonomyPolicy.findUniqueOrThrow({ where: { task: "negociar_preco" } })).level).not.toBe("AUTOMATICO");
  });

  it("só administrador muda autonomia; nível e tarefa inválidos são rejeitados", async () => {
    await expectError(setPolicy(comercial, "follow_up", "AUTOMATICO"), "SEM_PERMISSAO");
    await expectError(setPolicy(admin, "follow_up", "TUDO"), "INVALIDO");
    await expectError(setPolicy(admin, "tarefa_que_nao_existe", "HUMANO"), "NAO_ENCONTRADO");
    expect((await listPolicies(comercial)).length).toBeGreaterThanOrEqual(9);
  });

  it("chave geral: só administrador pausa e retoma", async () => {
    const was = await isAgentEnabled();
    await setAgentEnabled(admin, false);
    expect(await isAgentEnabled()).toBe(false);
    await expectError(setAgentEnabled(comercial, true), "SEM_PERMISSAO");
    expect(await isAgentEnabled()).toBe(false);
    await setAgentEnabled(admin, was);
    expect(await isAgentEnabled()).toBe(was);
  });
});

describe("conversas", () => {
  async function newConv(leadId: string | null) {
    const c = await db.conversation.create({ data: { leadId, channel: "WHATSAPP", mode: "AGENTE", unread: 2 } });
    convIds.push(c.id);
    await db.message.create({ data: { conversationId: c.id, author: "CLIENTE", body: "Quero uma cotação" } });
    return c;
  }

  it("equipe responde: a mensagem fica aguardando envio e o agente sai da conversa", async () => {
    const c = await newConv(leadRS);
    const msg = await sendHumanMessage(comercial, c.id, "Olá, aqui é o comercial.");
    expect(msg.author).toBe("EQUIPE");
    expect((msg.meta as { entrega: string }).entrega).toBe("aguardando_canal");
    const { conv, messages } = await getConversation(comercial, c.id);
    expect(conv.mode).toBe("HUMANO");
    expect(messages.map((m) => m.author)).toEqual(["CLIENTE", "EQUIPE"]);
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadRS } })).lastContactAt).not.toBeNull();
  });

  it("devolve ao agente e registra a troca", async () => {
    const c = await newConv(leadRS);
    await setConversationMode(comercial, c.id, "HUMANO");
    await setConversationMode(comercial, c.id, "AGENTE");
    const { conv, messages } = await getConversation(comercial, c.id);
    expect(conv.mode).toBe("AGENTE");
    expect(messages.filter((m) => m.author === "SISTEMA")).toHaveLength(2);
  });

  it("mensagem vazia e papéis sem permissão", async () => {
    const c = await newConv(leadRS);
    await expectError(sendHumanMessage(comercial, c.id, "   "), "INVALIDO");
    await expectError(sendHumanMessage(leitura, c.id, "oi"), "SEM_PERMISSAO");
    await expectError(setConversationMode(rep, c.id, "HUMANO"), "SEM_PERMISSAO");
  });

  it("representante só vê conversas de leads do estado dele", async () => {
    const inRS = await newConv(leadRS);
    const inSC = await newConv(leadSC);
    const noLead = await newConv(null);
    const ids = (await listConversations(rep)).map((c) => c.id);
    expect(ids).toContain(inSC.id);
    expect(ids).not.toContain(inRS.id);
    expect(ids).not.toContain(noLead.id);
    await expectError(getConversation(rep, inRS.id), "NAO_ENCONTRADO");
    await expectError(getConversation(rep, noLead.id), "NAO_ENCONTRADO");
    expect((await listConversations(comercial)).map((c) => c.id)).toEqual(expect.arrayContaining([inRS.id, inSC.id, noLead.id]));
  });
});

describe("clientes e recompra", () => {
  it("calcula a próxima reposição pelo ciclo", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const last = new Date("2026-10-07T12:00:00Z");
    const r = restockInfo(last, 30, now);
    expect(r.daysToRestock).toBe(10);
    expect(r.nextRestockAt.toISOString()).toBe("2026-11-06T12:00:00.000Z");
    expect(restockInfo(new Date("2026-09-01T12:00:00Z"), 30, now).daysToRestock).toBeLessThan(0);
  });

  it("lista ordenada pelos mais urgentes", async () => {
    const rows = await listCustomers(comercial);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.daysToRestock).toBeGreaterThanOrEqual(rows[i - 1]!.daysToRestock);
  });

  it("representante sem clientes nos estados dele não vê nenhum", async () => {
    const rows = await listCustomers(rep);
    expect(rows.every((r) => r.uf === "SC" || r.uf === "PR")).toBe(true);
  });
});

describe("corte de resposta no fim da frase", () => {
  it("não termina no meio de uma frase e mantém textos curtos intactos", async () => {
    const { clipAtSentence } = await import("@/server/agent/brain");
    const long = "Primeira frase completa sobre o processo. Segunda frase completa sobre a pureza da água. " + "Terceira frase longa ".repeat(60);
    const cut = clipAtSentence(long, 120);
    expect(cut.endsWith(".")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(120);
    expect(clipAtSentence("Texto curto.", 900)).toBe("Texto curto.");
  });
});
