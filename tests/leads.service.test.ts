// Testes de integração contra o Postgres de desenvolvimento (precisa do seed rodado).
// Tudo que criam usa o prefixo "ZZ Teste" e é apagado no final.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ServiceError, type Actor } from "@/server/leads/rules";
import {
  addNote,
  assignLead,
  createLead,
  createTask,
  getLead,
  listLeads,
  moveLead,
  setTaskStatus,
  updateLead,
} from "@/server/leads/service";

const PREFIX = "ZZ Teste";
let admin: Actor, comercial: Actor, rep: Actor, leitura: Actor;
let leadRS = "", leadSC = "";

async function actor(email: string): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { id: u.id, role: u.role, states: u.states };
}

const base = { source: "MANUAL", consentBase: "SOLICITACAO_CLIENTE" } as const;

async function expectError(promise: Promise<unknown>, code: ServiceError["code"]) {
  await expect(promise).rejects.toMatchObject({ name: "ServiceError", code });
}

beforeAll(async () => {
  [admin, comercial, rep, leitura] = await Promise.all([
    actor("admin@flurtek.local"),
    actor("comercial@flurtek.local"),
    actor("representante@flurtek.local"),
    actor("leitura@flurtek.local"),
  ]);
  leadRS = (await createLead(comercial, { ...base, company: `${PREFIX} RS`, uf: "RS", city: "Caxias do Sul", product: "Água 20L" })).id;
  leadSC = (await createLead(comercial, { ...base, company: `${PREFIX} SC`, uf: "SC", city: "Joinville" })).id;
});

afterAll(async () => {
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  await db.lead.deleteMany({ where: { companyId: { in: ids } } });
  await db.contact.deleteMany({ where: { companyId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

describe("criar lead", () => {
  it("grava empresa, consentimento e linha do tempo", async () => {
    const lead = await getLead(comercial, leadRS);
    expect(lead?.stage).toBe("NOVO");
    expect(lead?.consentAt).not.toBeNull();
    expect(lead?.consentSource).toBe("SOLICITACAO_CLIENTE");
    expect(lead?.events[0]?.kind).toBe("criado");
    expect(lead?.ownerId).toBe(comercial.id);
  });

  it("exige a base legal do contato", async () => {
    await expectError(createLead(comercial, { company: `${PREFIX} X`, uf: "RS", source: "MANUAL" }), "INVALIDO");
  });

  it("reaproveita a empresa com o mesmo nome e estado", async () => {
    const again = await createLead(comercial, { ...base, company: `${PREFIX} rs`, uf: "RS" });
    const a = await db.lead.findUniqueOrThrow({ where: { id: again.id } });
    const b = await db.lead.findUniqueOrThrow({ where: { id: leadRS } });
    expect(a.companyId).toBe(b.companyId);
  });

  it("leitura e representante não criam leads", async () => {
    await expectError(createLead(leitura, { ...base, company: `${PREFIX} Y`, uf: "RS" }), "SEM_PERMISSAO");
    await expectError(createLead(rep, { ...base, company: `${PREFIX} Y`, uf: "SC" }), "SEM_PERMISSAO");
  });
});

describe("mover etapa", () => {
  it("comercial move e a mudança vira evento e auditoria", async () => {
    await moveLead(comercial, leadRS, "QUALIFICADO");
    const lead = await getLead(comercial, leadRS);
    expect(lead?.stage).toBe("QUALIFICADO");
    expect(lead?.events[0]?.kind).toBe("etapa");
    expect(lead?.events[0]?.text).toContain("Qualificados");
    const audit = await db.auditLog.findFirst({ where: { entity: "Lead", entityId: leadRS, action: "lead.etapa" } });
    expect(audit?.actorId).toBe(comercial.id);
  });

  it("perdido exige motivo e limpa ao sair", async () => {
    await expectError(moveLead(comercial, leadRS, "PERDIDO"), "INVALIDO");
    await moveLead(comercial, leadRS, "PERDIDO", "Fechou com concorrente");
    expect((await getLead(comercial, leadRS))?.lostReason).toBe("Fechou com concorrente");
    await moveLead(comercial, leadRS, "COTACAO");
    expect((await getLead(comercial, leadRS))?.lostReason).toBeNull();
  });

  it("mover para a mesma etapa não gera evento", async () => {
    const before = (await getLead(comercial, leadRS))!.events.length;
    await moveLead(comercial, leadRS, "COTACAO");
    expect((await getLead(comercial, leadRS))!.events.length).toBe(before);
  });

  it("leitura e representante não movem", async () => {
    await expectError(moveLead(leitura, leadRS, "NEGOCIACAO"), "SEM_PERMISSAO");
    await expectError(moveLead(rep, leadSC, "NEGOCIACAO"), "SEM_PERMISSAO");
  });

  it("etapa inexistente é rejeitada", async () => {
    // @ts-expect-error etapa inválida de propósito
    await expectError(moveLead(comercial, leadRS, "INEXISTENTE"), "INVALIDO");
  });
});

describe("escopo do representante", () => {
  it("vê o lead do estado dele e não vê o dos outros", async () => {
    expect(await getLead(rep, leadSC)).not.toBeNull();
    expect(await getLead(rep, leadRS)).toBeNull();
    const list = await listLeads(rep, { q: PREFIX, includeClosed: true });
    expect(list.map((l) => l.uf)).toEqual(expect.not.arrayContaining(["RS"]));
    expect(list.some((l) => l.id === leadSC)).toBe(true);
  });

  it("anota e cria tarefa só em lead do escopo", async () => {
    await addNote(rep, leadSC, "Visitei o cliente hoje.");
    await createTask(rep, leadSC, { title: "Enviar amostra" });
    await expectError(addNote(rep, leadRS, "tentativa fora do escopo"), "NAO_ENCONTRADO");
    await expectError(createTask(rep, leadRS, { title: "fora do escopo" }), "NAO_ENCONTRADO");
  });

  it("não edita nem atribui", async () => {
    await expectError(updateLead(rep, leadSC, { product: "x" }), "SEM_PERMISSAO");
    await expectError(assignLead(rep, leadSC, null), "SEM_PERMISSAO");
  });
});

describe("notas e tarefas", () => {
  it("nota entra na linha do tempo e atualiza o último contato", async () => {
    await addNote(comercial, leadRS, "Cliente pediu ficha técnica.");
    const lead = await getLead(comercial, leadRS);
    expect(lead?.events[0]).toMatchObject({ kind: "nota", text: "Cliente pediu ficha técnica." });
    expect(lead?.lastContactAt).not.toBeNull();
  });

  it("rejeita nota vazia e leitura não anota", async () => {
    await expectError(addNote(comercial, leadRS, "  "), "INVALIDO");
    await expectError(addNote(leitura, leadRS, "oi"), "SEM_PERMISSAO");
  });

  it("cria, conclui e reabre tarefa, com histórico", async () => {
    const t = await createTask(comercial, leadRS, { title: "Ligar para confirmar volume", dueAt: new Date(Date.now() + 86_400_000) });
    expect(t.status).toBe("ABERTA");
    await setTaskStatus(comercial, t.id, "CONCLUIDA");
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("CONCLUIDA");
    await setTaskStatus(comercial, t.id, "ABERTA");
    const kinds = (await getLead(comercial, leadRS))!.events.filter((e) => e.kind === "tarefa").length;
    expect(kinds).toBe(3);
  });

  it("não mexe em tarefa de lead fora do escopo", async () => {
    const t = await createTask(comercial, leadRS, { title: "Tarefa do RS" });
    await expectError(setTaskStatus(rep, t.id, "CONCLUIDA"), "NAO_ENCONTRADO");
  });

  it("título curto é rejeitado e responsável inativo também", async () => {
    await expectError(createTask(comercial, leadRS, { title: "a" }), "INVALIDO");
    await expectError(createTask(comercial, leadRS, { title: "ok ok", assigneeId: "nao-existe" }), "INVALIDO");
  });
});

describe("editar e atribuir", () => {
  it("edita campos e registra só o que mudou", async () => {
    await updateLead(comercial, leadRS, { product: "Água 1.000L (IBC)", estimatedValue: 2600, temperature: "QUENTE" });
    const lead = await getLead(comercial, leadRS);
    expect(lead?.product).toBe("Água 1.000L (IBC)");
    expect(Number(lead?.estimatedValue)).toBe(2600);
    expect(lead?.events[0]?.text).toContain("produto");
    expect(lead?.events[0]?.text).toContain("valor estimado");
    expect(lead?.events[0]?.text).toContain("temperatura");
    const n = lead!.events.length;
    await updateLead(comercial, leadRS, { product: "Água 1.000L (IBC)" });
    expect((await getLead(comercial, leadRS))!.events.length).toBe(n);
  });

  it("rejeita estado e valor inválidos", async () => {
    await expectError(updateLead(comercial, leadRS, { uf: "XX" }), "INVALIDO");
    await expectError(updateLead(comercial, leadRS, { estimatedValue: -5 }), "INVALIDO");
  });

  it("atribui ao agente, a uma pessoa e remove o responsável", async () => {
    await assignLead(admin, leadRS, "AGENTE");
    let l = await getLead(admin, leadRS);
    expect(l?.agentOwned).toBe(true);
    expect(l?.ownerId).toBeNull();
    await assignLead(admin, leadRS, comercial.id);
    l = await getLead(admin, leadRS);
    expect(l?.agentOwned).toBe(false);
    expect(l?.ownerId).toBe(comercial.id);
    await assignLead(admin, leadRS, null);
    expect((await getLead(admin, leadRS))?.ownerId).toBeNull();
    await expectError(assignLead(admin, leadRS, leitura.id), "INVALIDO");
  });
});

describe("filtros da lista", () => {
  it("filtra por temperatura, responsável e encerrados", async () => {
    const quentes = await listLeads(comercial, { q: PREFIX, temperature: "QUENTE", includeClosed: true });
    expect(quentes.every((l) => l.temperature === "QUENTE")).toBe(true);
    expect(quentes.some((l) => l.id === leadRS)).toBe(true);

    const sem = await listLeads(comercial, { q: PREFIX, owner: "sem", includeClosed: true });
    expect(sem.some((l) => l.id === leadRS)).toBe(true);

    await moveLead(comercial, leadSC, "FRIO");
    expect((await listLeads(comercial, { q: PREFIX })).some((l) => l.id === leadSC)).toBe(false);
    expect((await listLeads(comercial, { q: PREFIX, includeClosed: true })).some((l) => l.id === leadSC)).toBe(true);
  });

  it("busca por texto ignora maiúsculas", async () => {
    const r = await listLeads(comercial, { q: "zz teste sc", includeClosed: true });
    expect(r.some((l) => l.id === leadSC)).toBe(true);
  });
});
