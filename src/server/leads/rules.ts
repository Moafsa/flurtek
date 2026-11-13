import type { RoleName } from "@/server/rbac";
import { STAGES, type StageName } from "@/lib/crm-constants";

export type Actor = { id: string; role: RoleName; states: string[] };

export class ServiceError extends Error {
  constructor(
    public code: "NAO_ENCONTRADO" | "SEM_PERMISSAO" | "INVALIDO",
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

// Representante só enxerga leads dos estados dele. Os demais papéis veem tudo.
// Devolve um filtro do Prisma; lead sem UF fica invisível para representante.
export function leadScope(actor: Actor): { uf?: { in: string[] } } {
  return actor.role === "REPRESENTANTE" ? { uf: { in: actor.states } } : {};
}

export function inScope(actor: Actor, lead: { uf: string | null }): boolean {
  if (actor.role !== "REPRESENTANTE") return true;
  return lead.uf !== null && actor.states.includes(lead.uf);
}

export function isStage(value: unknown): value is StageName {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

// Regras de transição: qualquer etapa para qualquer outra, com duas exigências.
export function validateMove(to: StageName, lostReason?: string | null): string | null {
  if (to === "PERDIDO" && (lostReason ?? "").trim().length < 3) {
    return "Informe o motivo da perda (ao menos 3 caracteres).";
  }
  return null;
}

// Valor de exemplo para ordenação do cartão: quente primeiro, depois maior pontuação.
export const TEMPERATURE_RANK: Record<string, number> = { QUENTE: 0, MORNO: 1, FRIO: 2 };
