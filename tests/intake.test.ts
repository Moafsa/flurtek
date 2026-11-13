// Entrada de formulários do site (M3). Dados de teste usam o domínio "@zz-intake.test" e o prefixo "ZZ Intake".
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { normalizePhone, samePhone } from "@/lib/phone";
import { intakeSchema } from "@/server/intake/schema";
import { processIntake } from "@/server/intake/service";
import { preScore } from "@/server/intake/score";
import { allow, resetRateLimits } from "@/server/ratelimit";

const PREFIX = "ZZ Intake";
const base = { name: `${PREFIX} Fulano`, email: "fulano@zz-intake.test", consent: true as const };
const parse = (v: unknown) => intakeSchema.parse(v);

afterAll(async () => {
  const contacts = await db.contact.findMany({ where: { email: { endsWith: "@zz-intake.test" } }, select: { id: true, companyId: true } });
  await db.lead.deleteMany({ where: { OR: [{ contactId: { in: contacts.map((c) => c.id) } }, { title: { startsWith: PREFIX } }] } });
  await db.conversation.deleteMany({ where: { messages: { some: { body: { contains: PREFIX } } } } });
  await db.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
  await db.company.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.intakeSubmission.deleteMany({ where: { submissionId: { startsWith: "zz-intake-" } } });
  await db.$disconnect();
});

describe("telefone", () => {
  it("normaliza para dígitos com DDI 55", () => {
    expect(normalizePhone("(54) 99126-8955")).toBe("5554991268955");
    expect(normalizePhone("+55 54 99126-8955")).toBe("5554991268955");
    expect(normalizePhone("0055 54 3333-4444")).toBe("555433334444");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
  it("reconhece o celular com e sem o 9", () => {
    expect(samePhone("5554991268955", "555491268955")).toBe(true);
    expect(samePhone("5554991268955", "5554991268956")).toBe(false);
    expect(samePhone(null, "5554991268955")).toBe(false);
  });
});

describe("validação do formulário", () => {
  it("exige consentimento, nome e e-mail ou telefone", () => {
    expect(intakeSchema.safeParse({ ...base, form: "cotacao", consent: false }).success).toBe(false);
    expect(intakeSchema.safeParse({ form: "cotacao", name: "A", email: "a@b.co", consent: true }).success).toBe(false);
    expect(intakeSchema.safeParse({ form: "cotacao", name: "Ana Paula", consent: true }).success).toBe(false);
    expect(intakeSchema.safeParse({ form: "cotacao", name: "Ana Paula", phone: "54991268955", consent: true }).success).toBe(true);
  });
  it("normaliza e-mail e rejeita estado e formulário inventados", () => {
    expect(parse({ ...base, form: "cotacao", email: "  FULANO@ZZ-Intake.TEST " }).email).toBe("fulano@zz-intake.test");
    expect(intakeSchema.safeParse({ ...base, form: "cotacao", uf: "XX" }).success).toBe(false);
    expect(intakeSchema.safeParse({ ...base, form: "invasao" }).success).toBe(false);
  });
  it("campos vazios viram indefinidos", () => {
    const v = parse({ ...base, form: "cotacao", uf: "", phone: "", message: "" });
    expect(v.uf).toBeUndefined();
    expect(v.phone).toBeUndefined();
    expect(v.message).toBeUndefined();
  });
});

describe("pré-classificação", () => {
  it("IBC e frequência esquentam o lead", () => {
    const r = preScore({ form: "cotacao", product: "Água 1.000L (IBC)", volume: "2 IBC/mês", hasPhone: true, frequency: "Mensal" });
    expect(r.temperature).toBe("QUENTE");
    expect(r.score).toBeGreaterThanOrEqual(90);
  });
  it("lista de espera é fria e representante é morno", () => {
    expect(preScore({ form: "lista_espera", hasPhone: false }).temperature).toBe("FRIO");
    expect(preScore({ form: "representante", hasPhone: true }).temperature).toBe("MORNO");
  });
  it("volume pequeno sem frequência fica frio ou morno", () => {
    expect(preScore({ form: "cotacao", product: "Água 1L", volume: "1L", hasPhone: false }).temperature).toBe("FRIO");
  });
});

describe("processIntake", () => {
  it("cotação cria contato, empresa e lead com consentimento e linha do tempo", async () => {
    const r = await processIntake(parse({ ...base, form: "cotacao", company: `${PREFIX} Transportes`, uf: "RS", city: "Caxias do Sul", product: "Água desmineralizada", volume: "1.000L", frequency: "Mensal", phone: "(54) 99126-8955", utm: { source: "google", medium: "cpc" } }), { ip: "10.0.0.1" });
    expect(r.created).toBe(true);
    const lead = await db.lead.findFirstOrThrow({ where: { title: `${PREFIX} Transportes` }, include: { contact: true, events: true } });
    expect(lead.source).toBe("SITE_FORMULARIO");
    expect(lead.stage).toBe("NOVO");
    expect(lead.consentAt).not.toBeNull();
    expect(lead.consentSource).toBe("site:cotacao");
    expect(lead.agentOwned).toBe(true);
    expect(lead.temperature).toBe("QUENTE");
    expect(lead.utmSource).toBe("google");
    expect(lead.contact?.phoneKey).toBe("5554991268955");
    expect(lead.events[0]?.text).toContain("Pediu cotação");
    expect(JSON.stringify(lead.events[0]?.meta)).not.toContain("10.0.0.1"); // IP só em hash
  });

  it("mesmo contato e produto em 30 dias soma na linha do tempo, sem duplicar o lead", async () => {
    const input = parse({ ...base, form: "cotacao", company: `${PREFIX} Dupla`, product: "Água 20L", volume: "10 galões" });
    const a = await processIntake(input);
    const b = await processIntake(parse({ ...base, form: "cotacao", company: `${PREFIX} Dupla`, product: "Água 20L", volume: "12 galões" }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const leads = await db.lead.findMany({ where: { contact: { email: base.email }, product: "Água 20L" }, include: { events: true } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.events.length).toBe(2);
  });

  it("reenvio com o mesmo submissionId devolve o mesmo protocolo", async () => {
    const input = parse({ ...base, email: "unico@zz-intake.test", form: "cotacao", company: `${PREFIX} Unica`, submissionId: "zz-intake-0001" });
    const a = await processIntake(input);
    const b = await processIntake(input);
    expect(b.duplicate).toBe(true);
    expect(b.reference).toBe(a.reference);
    expect(await db.lead.count({ where: { title: `${PREFIX} Unica` } })).toBe(1);
  });

  it("lista de espera do fluido vira lead frio de origem própria", async () => {
    await processIntake(parse({ ...base, email: "espera@zz-intake.test", form: "lista_espera", company: `${PREFIX} Espera`, product: "Concentrado" }));
    const lead = await db.lead.findFirstOrThrow({ where: { title: `${PREFIX} Espera` } });
    expect(lead.source).toBe("SITE_LISTA_ESPERA");
    expect(lead.product).toBe("Fluido de radiador (Concentrado)");
    expect(lead.temperature).toBe("FRIO");
  });

  it("candidatura a representante entra como lead do tipo candidato", async () => {
    await processIntake(parse({ ...base, email: "rep@zz-intake.test", form: "representante", company: `${PREFIX} Revenda`, uf: "SC", segment: "Autopeças" }));
    const lead = await db.lead.findFirstOrThrow({ where: { title: `${PREFIX} Revenda` }, include: { company: true } });
    expect(lead.product).toBe("Candidatura a representante");
    expect(lead.company?.segment).toBe("Candidato a representante");
  });

  it("contato financeiro vira conversa para a equipe e não lead", async () => {
    const before = await db.lead.count();
    const r = await processIntake(parse({ ...base, email: "fin@zz-intake.test", form: "contato", subject: "Financeiro", message: `${PREFIX} preciso da segunda via do boleto` }));
    expect(r.created).toBe(true);
    expect(await db.lead.count()).toBe(before);
    const conv = await db.conversation.findFirstOrThrow({ where: { messages: { some: { body: { contains: "segunda via" } } } }, include: { messages: true } });
    expect(conv.mode).toBe("HUMANO");
    expect(conv.unread).toBe(1);
    expect(conv.messages[0]!.body).toContain("[Financeiro]");
  });

  it("contato comercial vira lead", async () => {
    await processIntake(parse({ ...base, email: "com@zz-intake.test", form: "contato", subject: "Comercial", company: `${PREFIX} Comercial`, message: "Quero cotar" }));
    expect(await db.lead.count({ where: { title: `${PREFIX} Comercial` } })).toBe(1);
  });
});

describe("limitador", () => {
  it("bloqueia depois do limite e libera depois da janela", () => {
    resetRateLimits();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(allow("k", 3, 60_000, t + i)).toBe(true);
    expect(allow("k", 3, 60_000, t + 10)).toBe(false);
    expect(allow("outro", 3, 60_000, t + 10)).toBe(true);
    expect(allow("k", 3, 60_000, t + 61_000)).toBe(true);
  });
});
