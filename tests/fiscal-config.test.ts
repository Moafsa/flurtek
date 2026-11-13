// Configuração fiscal: regime selecionável e emissão real condicionada à configuração. Prefixo "ZZ Fis".
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { DEFAULT_FISCAL, FISCAL_CONFIG_KEY, fiscalMissing, getFiscalConfig, saveFiscalConfig, type FiscalConfig } from "@/server/finance/fiscal-config";
import { REGIMES } from "@/server/finance/fiscal-regimes";
import { resetFinanceForTests } from "@/server/finance";
import { MockPayment } from "@/server/finance/mock";
import { emitInvoice } from "@/server/finance/service";
import type { FiscalProvider, FiscalRequest } from "@/server/finance/types";
import type { Actor } from "@/server/leads/rules";

const PREFIX = "ZZ Fis";
let admin: Actor, comercial: Actor;
let backup: unknown = null;

const full: FiscalConfig = {
  regime: "SIMPLES_NACIONAL",
  environment: "HOMOLOGACAO",
  series: 1,
  nextNumber: 100,
  cfopInState: "5102",
  cfopOutState: "6102",
  taxCode: "102",
  ncmWater: "22019000",
  ncmFluid: "38200000",
  stateRegistration: "0960000000",
};

async function actor(email: string): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { id: u.id, role: u.role, states: u.states };
}

async function cleanup() {
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  const custs = await db.customer.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
  const orders = await db.order.findMany({ where: { customerId: { in: custs.map((c) => c.id) } }, select: { id: true } });
  await db.fiscalDoc.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await db.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await db.customer.deleteMany({ where: { companyId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
}

async function setConfig(c: Partial<FiscalConfig> | null) {
  if (c === null) await db.setting.deleteMany({ where: { key: FISCAL_CONFIG_KEY } });
  else await db.setting.upsert({ where: { key: FISCAL_CONFIG_KEY }, update: { value: { ...full, ...c } as never }, create: { key: FISCAL_CONFIG_KEY, value: { ...full, ...c } as never } });
}

async function newOrder(uf: string, product: string) {
  const company = await db.company.create({ data: { name: `${PREFIX} ${uf} ${Math.random().toString(16).slice(2, 6)}`, uf, cnpj: String(Math.floor(Math.random() * 1e14)).padStart(14, "0") } });
  const customer = await db.customer.create({ data: { companyId: company.id } });
  return db.order.create({ data: { customerId: customer.id, product, volume: "1", value: 500, orderedAt: new Date() } });
}

class RealLike implements FiscalProvider {
  readonly name = "sefaz-teste";
  requests: FiscalRequest[] = [];
  async emit(req: FiscalRequest) {
    this.requests.push(req);
    return { externalId: `x${this.requests.length}`, number: String(req.fiscal?.number), series: String(req.fiscal?.series), status: "EMITIDA" as const };
  }
  async cancel() {}
}

beforeAll(async () => {
  [admin, comercial] = await Promise.all([actor("admin@flurtek.local"), actor("comercial@flurtek.local")]);
  backup = (await db.setting.findUnique({ where: { key: FISCAL_CONFIG_KEY } }))?.value ?? null;
});
beforeEach(async () => {
  await cleanup();
  await setConfig(null);
});
afterEach(() => resetFinanceForTests());
afterAll(async () => {
  await cleanup();
  if (backup) await setConfig(backup as FiscalConfig);
  else await setConfig(null);
});

describe("regime selecionável", () => {
  it("o padrão não tem regime e lista o que falta", async () => {
    const c = await getFiscalConfig();
    expect(c).toEqual(DEFAULT_FISCAL);
    expect(fiscalMissing(c)).toContain("regime tributário");
  });

  it("o ADMIN escolhe e troca o regime quando quiser, com auditoria do antes e depois", async () => {
    await saveFiscalConfig(admin, { ...full, regime: "LUCRO_PRESUMIDO", taxCode: "00" });
    expect((await getFiscalConfig()).regime).toBe("LUCRO_PRESUMIDO");
    await saveFiscalConfig(admin, { ...full, regime: "SIMPLES_NACIONAL", taxCode: "102" });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "financeiro.fiscal_configurado" }, orderBy: { createdAt: "desc" } });
    expect(log.meta).toMatchObject({ regimeAntes: "LUCRO_PRESUMIDO", regimeDepois: "SIMPLES_NACIONAL" });
  });

  it("o código muda conforme o regime: CSOSN (3 dígitos) no Simples, CST (2) no Presumido", () => {
    expect(REGIMES.SIMPLES_NACIONAL.taxCode).toBe("CSOSN");
    expect(REGIMES.MEI.taxCode).toBe("CSOSN");
    expect(REGIMES.LUCRO_PRESUMIDO.taxCode).toBe("CST");
    expect(fiscalMissing({ ...full, regime: "SIMPLES_NACIONAL", taxCode: "00" })).toContain("CSOSN deve ter 3 dígitos");
    expect(fiscalMissing({ ...full, regime: "LUCRO_REAL", taxCode: "102" })).toContain("CST deve ter 2 dígitos");
    expect(fiscalMissing({ ...full, regime: "LUCRO_REAL", taxCode: "00" })).toEqual([]);
  });

  it("só o ADMIN altera; valores inválidos são recusados", async () => {
    await expect(saveFiscalConfig(comercial, full)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await expect(saveFiscalConfig(admin, { ...full, regime: "OUTRO" })).rejects.toMatchObject({ code: "INVALIDO" });
    await expect(saveFiscalConfig(admin, { ...full, ncmWater: "123" })).rejects.toThrow(/NCM/);
    await expect(saveFiscalConfig(admin, { ...full, cfopInState: "51" })).rejects.toThrow(/CFOP/);
  });

  it("produção só com tudo preenchido, e a numeração não volta para trás", async () => {
    await expect(saveFiscalConfig(admin, { ...DEFAULT_FISCAL, environment: "PRODUCAO" })).rejects.toThrow(/Para ir à produção falta/);
    await saveFiscalConfig(admin, { ...full, environment: "PRODUCAO" });
    await expect(saveFiscalConfig(admin, { ...full, environment: "PRODUCAO", nextNumber: 50 })).rejects.toThrow(/numeração/);
    await saveFiscalConfig(admin, { ...full, environment: "PRODUCAO", nextNumber: 150 });
    expect((await getFiscalConfig()).nextNumber).toBe(150);
  });
});

describe("emissão usa a configuração", () => {
  it("provedor real é bloqueado com configuração incompleta, sem criar nota nem gastar número", async () => {
    resetFinanceForTests(new MockPayment(), new RealLike());
    await setConfig({ regime: null });
    const o = await newOrder("RS", "Água 20L");
    await expect(emitInvoice(comercial, o.id)).rejects.toThrow(/Configuração fiscal incompleta.*regime/);
    expect(await db.fiscalDoc.count({ where: { orderId: o.id } })).toBe(0);
    expect((await getFiscalConfig()).nextNumber).toBe(100);
  });

  it("envia regime, CRT, CFOP por estado, NCM por produto e numeração sequencial", async () => {
    const real = new RealLike();
    resetFinanceForTests(new MockPayment(), real);
    await setConfig({});
    const rs = await newOrder("RS", "Água desmineralizada 20L");
    const sp = await newOrder("SP", "Fluido de radiador 1L");
    await emitInvoice(comercial, rs.id);
    await emitInvoice(comercial, sp.id);
    expect(real.requests[0]!.fiscal).toMatchObject({ regime: "SIMPLES_NACIONAL", crt: 1, cfop: "5102", ncm: "22019000", number: 100, series: 1, taxCode: "102", environment: "HOMOLOGACAO" });
    expect(real.requests[1]!.fiscal).toMatchObject({ cfop: "6102", ncm: "38200000", number: 101 });
    expect((await getFiscalConfig()).nextNumber).toBe(102);
  });

  it("trocar o regime muda o CRT usado na próxima nota", async () => {
    const real = new RealLike();
    resetFinanceForTests(new MockPayment(), real);
    await setConfig({ regime: "LUCRO_PRESUMIDO", taxCode: "00" });
    const o = await newOrder("RS", "Água 20L");
    await emitInvoice(comercial, o.id);
    expect(real.requests[0]!.fiscal).toMatchObject({ regime: "LUCRO_PRESUMIDO", crt: 3, taxCode: "00" });
  });

  it("no modo simulado a configuração é opcional", async () => {
    const o = await newOrder("RS", "Água 20L");
    resetFinanceForTests();
    const doc = await emitInvoice(comercial, o.id);
    expect(doc.status).toBe("EMITIDA");
  });
});
