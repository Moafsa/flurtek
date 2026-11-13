// Financeiro (M7): pedido → cobrança → conciliação → nota fiscal. Prefixo "ZZ Fin"; worker parado.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AsaasProvider, parseAsaasWebhook } from "@/server/finance/asaas";
import { MockFiscal, MockPayment } from "@/server/finance/mock";
import { resetFinanceForTests } from "@/server/finance";
import { ProviderError, type PaymentProvider } from "@/server/finance/types";
import { applyPaymentEvent, AUTO_INVOICE_KEY, cancelCharge, cancelInvoice, createCharge, createOrder, emitInvoice, financeSummary, markOverdue } from "@/server/finance/service";
import { runDunning } from "@/server/finance/dunning";
import { MockOwnerBrain } from "@/server/owner/intents";
import { putSetting } from "@/server/settings";
import { POST as asaasWebhook } from "@/app/api/webhooks/asaas/route";
import type { Actor } from "@/server/leads/rules";

const PREFIX = "ZZ Fin";
const DAY = 86_400_000;
let admin: Actor, comercial: Actor, leitura: Actor, rep: Actor;
let customerId = "";
let companyId = "";
let pay: MockPayment, fiscal: MockFiscal;

async function actor(email: string): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { id: u.id, role: u.role, states: u.states };
}

async function cleanup() {
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  const custs = await db.customer.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
  const orders = await db.order.findMany({ where: { customerId: { in: custs.map((c) => c.id) } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  await db.fiscalDoc.deleteMany({ where: { orderId: { in: oids } } });
  await db.charge.deleteMany({ where: { orderId: { in: oids } } });
  await db.order.deleteMany({ where: { id: { in: oids } } });
  await db.customer.deleteMany({ where: { companyId: { in: ids } } });
  const leads = await db.lead.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
  await db.agentAction.deleteMany({ where: { leadId: { in: leads.map((l) => l.id) } } });
  await db.leadEvent.deleteMany({ where: { leadId: { in: leads.map((l) => l.id) } } });
  await db.lead.deleteMany({ where: { companyId: { in: ids } } });
  await db.contact.deleteMany({ where: { companyId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
  await db.webhookEvent.deleteMany({ where: { dedupeKey: { startsWith: "asaas:zz-fin" } } });
  await db.message.deleteMany({ where: { conversation: { kind: "DONO" }, meta: { path: ["dedupeKey"], string_starts_with: "pago:" } } }).catch(() => {});
}

async function newOrder(opts: { cnpj?: string | null; value?: number } = {}) {
  const order = await db.order.create({ data: { customerId, product: "Água 20L", volume: "10 galões", value: opts.value ?? 1450, orderedAt: new Date() } });
  await db.company.update({ where: { id: companyId }, data: { cnpj: opts.cnpj === undefined ? null : opts.cnpj } });
  return order;
}

beforeAll(async () => {
  [admin, comercial, leitura, rep] = await Promise.all([actor("admin@flurtek.local"), actor("comercial@flurtek.local"), actor("leitura@flurtek.local"), actor("representante@flurtek.local")]);
});

beforeEach(async () => {
  await cleanup();
  const company = await db.company.create({ data: { name: `${PREFIX} Cliente`, uf: "RS" } });
  companyId = company.id;
  customerId = (await db.customer.create({ data: { companyId } })).id;
  await db.contact.create({ data: { companyId, name: `${PREFIX} Contato`, email: "fin@zz.test" } });
  pay = new MockPayment();
  fiscal = new MockFiscal();
  resetFinanceForTests(pay, fiscal);
  await putSetting(AUTO_INVOICE_KEY, false);
});

afterEach(() => resetFinanceForTests());
afterAll(async () => {
  await cleanup();
  await putSetting(AUTO_INVOICE_KEY, false);
});

const tomorrow = () => new Date(Date.now() + DAY);

describe("permissões", () => {
  it("só ADMIN e COMERCIAL mexem no financeiro", async () => {
    await expect(createOrder(leitura, { customerId, product: "x", value: 10 })).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await expect(createOrder(rep, { customerId, product: "x", value: 10 })).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await expect(financeSummary(leitura)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    const o = await createOrder(comercial, { customerId, product: "Água 20L", value: 100 });
    expect(Number(o.value)).toBe(100);
  });

  it("cancelar cobrança e nota é só do ADMIN", async () => {
    const o = await newOrder();
    const c = await createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() });
    await expect(cancelCharge(comercial, c.id)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await cancelCharge(admin, c.id);
    expect(pay.cancelled).toContain(c.externalId);
  });

  it("pedido sem valor ou com valor zero é recusado", async () => {
    await expect(createOrder(comercial, { customerId, product: "x", value: 0 })).rejects.toMatchObject({ code: "INVALIDO" });
    await expect(createOrder(comercial, { customerId: "nao-existe", product: "x", value: 5 })).rejects.toMatchObject({ code: "NAO_ENCONTRADO" });
  });
});

describe("cobrança", () => {
  it("cria no gateway, guarda o link e marca o pedido como faturado", async () => {
    const o = await newOrder({ cnpj: "12345678000195" });
    const c = await createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() });
    expect(c.externalId).toMatch(/^pay_mock_/);
    expect(c.paymentUrl).toBeTruthy();
    expect(c.pixPayload).toBeTruthy();
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("FATURADO");
    expect(pay.created[0]).toMatchObject({ value: 1450, billingType: "PIX", externalReference: c.id });
    expect(pay.created[0]!.payer).toMatchObject({ name: `${PREFIX} Cliente`, cnpj: "12345678000195", email: "fin@zz.test" });
    expect(await db.auditLog.count({ where: { action: "financeiro.cobranca_criada", entityId: c.id } })).toBe(1);
  });

  it("não cria duas cobranças em aberto, nem com vencimento no passado", async () => {
    const o = await newOrder();
    await expect(createCharge(comercial, o.id, { billingType: "PIX", dueDate: new Date(Date.now() - 3 * DAY) })).rejects.toMatchObject({ code: "INVALIDO" });
    await createCharge(comercial, o.id, { billingType: "BOLETO", dueDate: tomorrow() });
    await expect(createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() })).rejects.toThrow(/em aberto/);
    expect(pay.created).toHaveLength(1);
  });

  it("se o gateway falha, a cobrança fica cancelada com o erro e o pedido segue aberto", async () => {
    const failing: PaymentProvider = { name: "falha", createCharge: async () => { throw new ProviderError("Asaas 400: CNPJ inválido", 400); }, cancelCharge: async () => {} };
    resetFinanceForTests(failing, fiscal);
    const o = await newOrder();
    await expect(createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() })).rejects.toThrow(/CNPJ inválido/);
    const charges = await db.charge.findMany({ where: { orderId: o.id } });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ status: "CANCELADA" });
    expect(charges[0]!.error).toMatch(/CNPJ inválido/);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ABERTO");
    // depois de corrigido, dá para tentar de novo
    resetFinanceForTests(pay, fiscal);
    await expect(createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() })).resolves.toBeTruthy();
  });

  it("pedido pago não gera nova cobrança", async () => {
    const o = await newOrder();
    await db.order.update({ where: { id: o.id }, data: { status: "PAGO" } });
    await expect(createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() })).rejects.toThrow(/já pago/);
  });
});

describe("adaptador do Asaas", () => {
  function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
    const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const key = Object.keys(routes).find((k) => `${init.method} ${new URL(url).pathname}` === k);
      const r = key ? routes[key]! : { status: 404, body: { errors: [{ description: "rota" }] } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const payer = { externalReference: "cust1", name: "Oficina Teste", cnpj: "12.345.678/0001-95", email: "a@b.c", phone: "+5554999990000" };

  it("cria cliente, cobrança e QR Pix com a chave no cabeçalho", async () => {
    const { f, calls } = fakeFetch({
      "GET /api/v3/customers": { body: { data: [] } },
      "POST /api/v3/customers": { body: { id: "cus_1" } },
      "POST /api/v3/payments": { body: { id: "pay_1", invoiceUrl: "https://asaas.test/i/1" } },
      "GET /api/v3/payments/pay_1/pixQrCode": { body: { payload: "000201PIX" } },
    });
    const a = new AsaasProvider("https://sandbox.asaas.com/api/v3", "chave-teste", f);
    const r = await a.createCharge({ payer, billingType: "PIX", value: 1450, dueDate: new Date("2026-11-05T12:00:00Z"), description: "Água", externalReference: "ch1" });
    expect(r).toEqual({ externalId: "pay_1", paymentUrl: "https://asaas.test/i/1", pixPayload: "000201PIX" });
    expect(calls.every((c) => c.headers.access_token === "chave-teste")).toBe(true);
    const customer = calls.find((c) => c.method === "POST" && c.url.endsWith("/customers"))!;
    expect(customer.body).toMatchObject({ cpfCnpj: "12345678000195", mobilePhone: "54999990000", notificationDisabled: true });
    expect(calls.find((c) => c.url.endsWith("/payments") && c.method === "POST")!.body).toMatchObject({ customer: "cus_1", billingType: "PIX", value: 1450, dueDate: "2026-11-05", externalReference: "ch1" });
  });

  it("reaproveita o cliente que já existe e não falha se o QR Pix falhar", async () => {
    const { f, calls } = fakeFetch({
      "GET /api/v3/customers": { body: { data: [{ id: "cus_9" }] } },
      "POST /api/v3/payments": { body: { id: "pay_2", invoiceUrl: "https://asaas.test/i/2" } },
    });
    const r = await new AsaasProvider("https://x/api/v3", "k", f).createCharge({ payer, billingType: "PIX", value: 10, dueDate: new Date(), description: "d", externalReference: "c" });
    expect(r.externalId).toBe("pay_2");
    expect(r.pixPayload).toBeUndefined();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/customers"))).toBe(false);
  });

  it("traduz o erro do Asaas", async () => {
    const { f } = fakeFetch({ "GET /api/v3/customers": { status: 401, body: { errors: [{ description: "A chave de API informada não pertence a esta conta" }] } } });
    await expect(new AsaasProvider("https://x/api/v3", "k", f).createCharge({ payer, billingType: "PIX", value: 1, dueDate: new Date(), description: "d", externalReference: "c" })).rejects.toThrow(/401.*chave de API/);
  });

  it("lê o webhook de pagamento", () => {
    expect(parseAsaasWebhook({ id: "evt_1", event: "PAYMENT_RECEIVED", payment: { id: "pay_1", value: 1450, paymentDate: "2026-10-28" } })).toEqual({ event: "PAYMENT_RECEIVED", paymentId: "pay_1", value: 1450, paidAt: new Date("2026-10-28T12:00:00Z") });
    expect(parseAsaasWebhook({ event: "X" })).toBeNull();
    expect(parseAsaasWebhook("lixo")).toBeNull();
  });
});

describe("conciliação", () => {
  async function charged() {
    const o = await newOrder({ cnpj: "12345678000195" });
    const c = await createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() });
    return { o, c };
  }

  it("pagamento recebido baixa a cobrança, marca o pedido como pago e é idempotente", async () => {
    const { o, c } = await charged();
    expect(await applyPaymentEvent({ event: "PAYMENT_RECEIVED", paymentId: c.externalId!, value: 1450 })).toBe("atualizada");
    const paid = await db.charge.findUniqueOrThrow({ where: { id: c.id } });
    expect(paid.status).toBe("PAGA");
    expect(Number(paid.paidValue)).toBe(1450);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAGO");
    expect(await applyPaymentEvent({ event: "PAYMENT_CONFIRMED", paymentId: c.externalId! })).toBe("sem_mudanca");
    expect(await db.auditLog.count({ where: { action: "financeiro.cobranca_paga", entityId: c.id } })).toBe(1);
  });

  it("evento atrasado não desfaz um pagamento, e cobrança desconhecida é ignorada", async () => {
    const { c } = await charged();
    await applyPaymentEvent({ event: "PAYMENT_RECEIVED", paymentId: c.externalId! });
    expect(await applyPaymentEvent({ event: "PAYMENT_OVERDUE", paymentId: c.externalId! })).toBe("sem_mudanca");
    expect((await db.charge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAGA");
    expect(await applyPaymentEvent({ event: "PAYMENT_RECEIVED", paymentId: "pay_que_nao_existe" })).toBe("desconhecida");
    expect(await applyPaymentEvent({ event: "PAYMENT_CREATED", paymentId: c.externalId! })).toBe("ignorado");
  });

  it("estorno devolve o pedido para faturado", async () => {
    const { o, c } = await charged();
    await applyPaymentEvent({ event: "PAYMENT_RECEIVED", paymentId: c.externalId! });
    await applyPaymentEvent({ event: "PAYMENT_REFUNDED", paymentId: c.externalId! });
    expect((await db.charge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ESTORNADA");
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("FATURADO");
  });

  it("emite a nota sozinho ao receber, só quando a opção está ligada", async () => {
    const a = await charged();
    await applyPaymentEvent({ event: "PAYMENT_RECEIVED", paymentId: a.c.externalId! });
    expect(await db.fiscalDoc.count({ where: { orderId: a.o.id } })).toBe(0);

    await putSetting(AUTO_INVOICE_KEY, true);
    const b = await charged();
    await applyPaymentEvent({ event: "PAYMENT_RECEIVED", paymentId: b.c.externalId! });
    const docs = await db.fiscalDoc.findMany({ where: { orderId: b.o.id } });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: "NFE", status: "EMITIDA", chargeId: b.c.id });
  });

  it("vencimento: marca como vencida a cobrança que passou do prazo", async () => {
    const { c } = await charged();
    await db.charge.update({ where: { id: c.id }, data: { dueDate: new Date(Date.now() - 3 * DAY) } });
    expect(await markOverdue()).toBeGreaterThanOrEqual(1);
    expect((await db.charge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("VENCIDA");
    const s = await financeSummary(admin);
    expect(s.vencido).toBeGreaterThanOrEqual(1450);
  });

  it("lembrete de cobrança vencida vai para aprovação, nunca direto, e não repete em 5 dias", async () => {
    const { c } = await charged();
    const lead = await db.lead.create({ data: { title: `${PREFIX} Lead`, companyId, contactId: (await db.contact.findFirstOrThrow({ where: { companyId } })).id } });
    await db.contact.updateMany({ where: { companyId }, data: { phone: "+5554990007777", phoneKey: "5554990007777" } });
    await db.charge.update({ where: { id: c.id }, data: { status: "VENCIDA", dueDate: new Date(Date.now() - 3 * DAY) } });
    expect(await runDunning()).toBe(1);
    const act = await db.agentAction.findFirstOrThrow({ where: { leadId: lead.id, kind: "lembrete_cobranca" } });
    expect(act.status).toBe("PENDENTE");
    expect(act.draft).toContain(c.paymentUrl!);
    expect(await runDunning()).toBe(0);
  });
});

describe("nota fiscal", () => {
  it("exige CNPJ do cliente", async () => {
    const o = await newOrder({ cnpj: null });
    await expect(emitInvoice(comercial, o.id)).rejects.toThrow(/CNPJ/);
    expect(await db.fiscalDoc.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("emite NF-e de produto e não duplica a nota do mesmo pedido", async () => {
    const o = await newOrder({ cnpj: "12345678000195" });
    const a = await emitInvoice(comercial, o.id);
    const b = await emitInvoice(comercial, o.id);
    expect(a).toMatchObject({ kind: "NFE", status: "EMITIDA" });
    expect(b.id).toBe(a.id);
    expect(fiscal.emitted).toHaveLength(1);
    expect(fiscal.emitted[0]).toMatchObject({ total: 1450, cnpj: "12345678000195" });
  });

  it("falha do provedor fica registrada e permite nova tentativa", async () => {
    resetFinanceForTests(pay, { name: "mock", emit: async () => { throw new ProviderError("SEFAZ fora do ar"); }, cancel: async () => {} });
    const o = await newOrder({ cnpj: "12345678000195" });
    await expect(emitInvoice(comercial, o.id)).rejects.toThrow(/SEFAZ/);
    expect((await db.fiscalDoc.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("ERRO");
    resetFinanceForTests(pay, fiscal);
    const ok = await emitInvoice(comercial, o.id);
    expect(ok.status).toBe("EMITIDA");
  });

  it("cancelar nota: só ADMIN, só emitida, e com motivo", async () => {
    const o = await newOrder({ cnpj: "12345678000195" });
    const doc = await emitInvoice(comercial, o.id);
    await expect(cancelInvoice(comercial, doc.id, "Cliente devolveu o pedido inteiro")).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await expect(cancelInvoice(admin, doc.id, "curto")).rejects.toThrow(/motivo/);
    await cancelInvoice(admin, doc.id, "Cliente devolveu o pedido inteiro");
    expect((await db.fiscalDoc.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe("CANCELADA");
    await expect(cancelInvoice(admin, doc.id, "Cliente devolveu o pedido inteiro")).rejects.toThrow(/emitida/);
  });
});

describe("webhook do Asaas", () => {
  const OLD = process.env.ASAAS_WEBHOOK_TOKEN;
  afterAll(() => {
    process.env.ASAAS_WEBHOOK_TOKEN = OLD;
  });
  const post = (body: unknown, token?: string) =>
    asaasWebhook(new Request("http://x/api/webhooks/asaas", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "asaas-access-token": token } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }));

  it("sem token configurado responde 503; token errado, 401", async () => {
    delete process.env.ASAAS_WEBHOOK_TOKEN;
    expect((await post({}, "x")).status).toBe(503);
    process.env.ASAAS_WEBHOOK_TOKEN = "segredo-teste";
    expect((await post({}, "errado")).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect((await post("{", "segredo-teste")).status).toBe(400);
  });

  it("concilia o pagamento e ignora o reenvio do mesmo evento", async () => {
    process.env.ASAAS_WEBHOOK_TOKEN = "segredo-teste";
    const o = await newOrder();
    const c = await createCharge(comercial, o.id, { billingType: "PIX", dueDate: tomorrow() });
    const evt = { id: "zz-fin-evt-1", event: "PAYMENT_RECEIVED", payment: { id: c.externalId, value: 1450, paymentDate: "2026-10-28" } };
    const r1 = await (await post(evt, "segredo-teste")).json();
    expect(r1).toMatchObject({ ok: true, result: "atualizada" });
    const r2 = await (await post(evt, "segredo-teste")).json();
    expect(r2).toMatchObject({ ok: true, duplicate: true });
    expect((await db.charge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PAGA");
  });
});

describe("dono pelo WhatsApp", () => {
  it("entende pedidos de financeiro sem confundir com follow-up", async () => {
    const b = new MockOwnerBrain();
    for (const t of ["como está o financeiro?", "quem está me devendo", "cobranças em aberto", "quanto tenho a receber"]) {
      expect(await b.parse(t), t).toEqual({ intent: "financeiro" });
    }
    expect((await b.parse("faça follow-up das cotações sem resposta")).intent).toBe("followup_cotacoes");
  });
});
