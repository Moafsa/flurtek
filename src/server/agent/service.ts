// Fila de aprovações, política de autonomia e registro do agente.
import { z } from "zod";
import { db } from "@/lib/db";
import { can, type Permission } from "@/server/rbac";
import { writeAudit } from "@/server/audit";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { AGENT_ENABLED_KEY, putSetting } from "@/server/settings";

export const AUTONOMY_LEVELS = ["AUTOMATICO", "APROVACAO", "HUMANO"] as const;
export type AutonomyLevelName = (typeof AUTONOMY_LEVELS)[number];

// Tarefas que NUNCA podem ser automáticas, seja qual for a configuração.
export const NEVER_AUTOMATIC = ["negociar_preco"] as const;

function need(actor: Actor, permission: Permission) {
  if (!can(actor.role, permission)) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
}

export async function setAgentEnabled(actor: Actor, enabled: boolean) {
  need(actor, "agent:configure");
  await putSetting(AGENT_ENABLED_KEY, enabled, actor.id);
  await writeAudit({ action: enabled ? "agente.retomado" : "agente.pausado", actorId: actor.id, entity: "Setting", entityId: AGENT_ENABLED_KEY });
}

export async function listPendingActions(actor: Actor) {
  need(actor, "agent:review");
  return db.agentAction.findMany({
    where: { status: "PENDENTE" },
    include: { lead: { select: { id: true, title: true, stage: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function listRecentActions(actor: Actor, take = 50) {
  need(actor, "agent:review");
  return db.agentAction.findMany({
    where: { status: { not: "PENDENTE" } },
    include: { lead: { select: { id: true, title: true } }, decidedBy: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });
}

const draftSchema = z.string().trim().min(5, "O texto está muito curto.").max(4000, "O texto está muito longo.");

// Aprova (opcionalmente com o texto editado) ou rejeita. Aprovar NÃO envia: marca como APROVADA,
// e o executor de canais (WhatsApp/e-mail) é quem envia e marca EXECUTADA.
export async function decideAction(actor: Actor, id: string, decision: "APROVAR" | "REJEITAR", editedDraft?: string | null) {
  need(actor, "agent:review");
  const action = await db.agentAction.findUnique({ where: { id }, include: { lead: { select: { id: true, title: true } } } });
  if (!action) throw new ServiceError("NAO_ENCONTRADO", "Ação não encontrada.");
  if (action.status !== "PENDENTE") throw new ServiceError("INVALIDO", "Esta ação já foi decidida por outra pessoa.");

  let draft = action.draft;
  if (decision === "APROVAR" && editedDraft != null && editedDraft !== action.draft) {
    const parsed = draftSchema.safeParse(editedDraft);
    if (!parsed.success) throw new ServiceError("INVALIDO", parsed.error.issues[0]!.message);
    draft = parsed.data;
  }
  if (decision === "APROVAR" && action.draft && !draft) throw new ServiceError("INVALIDO", "O texto não pode ficar vazio.");

  const status = decision === "APROVAR" ? "APROVADA" : "REJEITADA";
  // Troca de status só se ainda estiver pendente (evita decisão dupla em cliques simultâneos).
  const res = await db.agentAction.updateMany({
    where: { id, status: "PENDENTE" },
    data: { status, draft, decidedById: actor.id, decidedAt: new Date() },
  });
  if (res.count === 0) throw new ServiceError("INVALIDO", "Esta ação já foi decidida por outra pessoa.");

  if (action.leadId) {
    await db.leadEvent.create({
      data: {
        leadId: action.leadId,
        actorType: "USUARIO",
        actorId: actor.id,
        kind: "agente",
        text:
          decision === "APROVAR"
            ? `Aprovou a sugestão do agente (${action.kind.replaceAll("_", " ")})${draft !== action.draft ? " com edição" : ""}.`
            : `Rejeitou a sugestão do agente (${action.kind.replaceAll("_", " ")}).`,
      },
    });
  }
  await writeAudit({
    action: decision === "APROVAR" ? "agente.acao_aprovada" : "agente.acao_rejeitada",
    actorId: actor.id,
    entity: "AgentAction",
    entityId: id,
    meta: { kind: action.kind, editado: draft !== action.draft },
  });
  return db.agentAction.findUniqueOrThrow({ where: { id } });
}

export async function listPolicies(actor: Actor) {
  need(actor, "agent:review");
  return db.autonomyPolicy.findMany({ orderBy: { label: "asc" } });
}

export async function setPolicy(actor: Actor, task: string, level: string) {
  need(actor, "agent:configure");
  if (!(AUTONOMY_LEVELS as readonly string[]).includes(level)) throw new ServiceError("INVALIDO", "Nível inválido.");
  if ((NEVER_AUTOMATIC as readonly string[]).includes(task) && level === "AUTOMATICO") {
    throw new ServiceError("INVALIDO", "Esta tarefa nunca pode ser automática: preço e desconto são sempre decididos por pessoas.");
  }
  const policy = await db.autonomyPolicy.findUnique({ where: { task } });
  if (!policy) throw new ServiceError("NAO_ENCONTRADO", "Tarefa não encontrada.");
  if (policy.level === level) return policy;
  const updated = await db.autonomyPolicy.update({ where: { task }, data: { level: level as AutonomyLevelName, updatedById: actor.id } });
  await writeAudit({ action: "agente.autonomia_alterada", actorId: actor.id, entity: "AutonomyPolicy", entityId: task, meta: { de: policy.level, para: level } });
  return updated;
}
