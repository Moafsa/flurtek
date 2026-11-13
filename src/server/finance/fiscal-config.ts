// Parâmetros fiscais da empresa. O regime é escolhido pelo ADMIN e pode ser trocado a qualquer momento.
// Nada aqui calcula imposto: o contador confirma os códigos e a emissão real só roda com tudo preenchido.
import { z } from "zod";
import { db } from "@/lib/db";
import { writeAudit } from "@/server/audit";
import { can } from "@/server/rbac";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { getSetting, putSetting } from "@/server/settings";
import { REGIMES, REGIME_KEYS } from "@/server/finance/fiscal-regimes";

export const FISCAL_CONFIG_KEY = "finance.fiscal";

export { REGIMES, REGIME_KEYS, type Regime } from "@/server/finance/fiscal-regimes";

const digits = (n: number, label: string) => z.string().trim().regex(new RegExp(`^\\d{${n}}$`), `${label}: use ${n} dígitos.`);

export const fiscalConfigSchema = z.object({
  regime: z.enum(REGIME_KEYS).nullable(),
  environment: z.enum(["HOMOLOGACAO", "PRODUCAO"]),
  series: z.coerce.number().int().min(1).max(999),
  nextNumber: z.coerce.number().int().min(1).max(999_999_999),
  cfopInState: digits(4, "CFOP dentro do estado").or(z.literal("")),
  cfopOutState: digits(4, "CFOP fora do estado").or(z.literal("")),
  // CSOSN (3 dígitos, Simples/MEI) ou CST (2 dígitos, Presumido/Real), conforme o regime.
  taxCode: z.string().trim().regex(/^\d{2,3}$/, "Código de tributação: 2 ou 3 dígitos.").or(z.literal("")),
  ncmWater: digits(8, "NCM da água").or(z.literal("")),
  ncmFluid: digits(8, "NCM do fluido").or(z.literal("")),
  stateRegistration: z.string().trim().max(20),
});
export type FiscalConfig = z.infer<typeof fiscalConfigSchema>;

export const DEFAULT_FISCAL: FiscalConfig = {
  regime: null,
  environment: "HOMOLOGACAO",
  series: 1,
  nextNumber: 1,
  cfopInState: "",
  cfopOutState: "",
  taxCode: "",
  ncmWater: "",
  ncmFluid: "",
  stateRegistration: "",
};

export async function getFiscalConfig(): Promise<FiscalConfig> {
  const stored = await getSetting<unknown>(FISCAL_CONFIG_KEY, null);
  const parsed = fiscalConfigSchema.safeParse({ ...DEFAULT_FISCAL, ...(stored as object | null) });
  return parsed.success ? parsed.data : DEFAULT_FISCAL;
}

// O que ainda falta preencher. A emissão real (fora do modo simulado) só roda com a lista vazia.
export function fiscalMissing(c: FiscalConfig): string[] {
  const out: string[] = [];
  if (!c.regime) out.push("regime tributário");
  if (!c.stateRegistration) out.push("inscrição estadual");
  if (!c.cfopInState) out.push("CFOP dentro do estado");
  if (!c.cfopOutState) out.push("CFOP fora do estado");
  if (!c.taxCode) out.push(c.regime ? `código ${REGIMES[c.regime].taxCode}` : "código de tributação");
  if (!c.ncmWater) out.push("NCM da água");
  if (!c.ncmFluid) out.push("NCM do fluido");
  if (c.regime && c.taxCode) {
    const expected = REGIMES[c.regime].taxCode === "CSOSN" ? 3 : 2;
    if (c.taxCode.length !== expected) out.push(`${REGIMES[c.regime].taxCode} deve ter ${expected} dígitos`);
  }
  return out;
}

export async function saveFiscalConfig(actor: Actor, input: unknown): Promise<FiscalConfig> {
  if (!can(actor.role, "finance:admin")) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
  const parsed = fiscalConfigSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError("INVALIDO", parsed.error.issues[0]!.message);
  const before = await getFiscalConfig();
  const next = parsed.data;
  // Produção só depois de tudo preenchido: evita ligar a emissão real pela metade.
  if (next.environment === "PRODUCAO") {
    const missing = fiscalMissing(next);
    if (missing.length) throw new ServiceError("INVALIDO", `Para ir à produção falta: ${missing.join(", ")}.`);
  }
  // A numeração nunca volta para trás no mesmo ambiente e série (a SEFAZ não aceita número repetido).
  if (before.environment === next.environment && before.series === next.series && next.nextNumber < before.nextNumber) {
    throw new ServiceError("INVALIDO", `A numeração não pode diminuir (atual: ${before.nextNumber}).`);
  }
  await putSetting(FISCAL_CONFIG_KEY, next, actor.id);
  await writeAudit({
    action: "financeiro.fiscal_configurado",
    actorId: actor.id,
    entity: "Setting",
    entityId: FISCAL_CONFIG_KEY,
    meta: { regimeAntes: before.regime, regimeDepois: next.regime, ambiente: next.environment },
  });
  return next;
}

// Usado só para exibir o estado da configuração (sem expor nada sensível).
export async function fiscalStatus() {
  const config = await getFiscalConfig();
  return { config, missing: fiscalMissing(config), lastChange: await db.auditLog.findFirst({ where: { action: "financeiro.fiscal_configurado" }, orderBy: { createdAt: "desc" } }) };
}
