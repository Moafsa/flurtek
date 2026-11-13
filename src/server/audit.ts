import { db } from "@/lib/db";
import type { ActorType, Prisma } from "@prisma/client";

type AuditInput = {
  action: string;
  actorType?: ActorType;
  actorId?: string | null;
  entity?: string;
  entityId?: string;
  meta?: Prisma.InputJsonValue;
  ip?: string | null;
};

// Registro de auditoria: nada é apagado. Falha de gravação nunca derruba a operação principal.
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: input.action,
        actorType: input.actorType ?? "USUARIO",
        actorId: input.actorId ?? null,
        entity: input.entity,
        entityId: input.entityId,
        meta: input.meta,
        ip: input.ip ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] falha ao gravar", error);
  }
}
