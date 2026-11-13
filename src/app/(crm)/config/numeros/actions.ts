"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { writeAudit } from "@/server/audit";
import { requirePermission } from "@/server/session";
import { issueVerificationCode } from "@/server/owner/handler";

export type NumberState = { ok?: boolean; error?: string; code?: string; name?: string };

const schema = z.object({
  name: z.string().trim().min(2, "Informe o nome.").max(80),
  phone: z.string().trim().min(8, "Informe o telefone."),
  role: z.enum(["DONO", "GESTOR"]),
  userId: z.string().optional(),
});

// O código de verificação aparece UMA vez, aqui. Só o hash fica guardado.
export async function addNumberAction(_prev: NumberState, fd: FormData): Promise<NumberState> {
  const admin = await requirePermission("user:manage");
  const parsed = schema.safeParse({ name: fd.get("name"), phone: fd.get("phone"), role: fd.get("role"), userId: String(fd.get("userId") ?? "") || undefined });
  if (!parsed.success) return { error: parsed.error.issues[0]!.message };
  const phoneKey = normalizePhone(parsed.data.phone);
  if (!phoneKey) return { error: "Telefone inválido. Use DDD, por exemplo (54) 99999-9999." };
  if (await db.authorizedNumber.findUnique({ where: { phoneKey } })) return { error: "Este número já está cadastrado." };
  if (parsed.data.userId && !(await db.user.findFirst({ where: { id: parsed.data.userId, active: true } }))) return { error: "Usuário inválido." };

  const n = await db.authorizedNumber.create({ data: { phoneKey, name: parsed.data.name, role: parsed.data.role, userId: parsed.data.userId } });
  const code = await issueVerificationCode(n.id);
  await writeAudit({ action: "dono.numero_cadastrado", actorId: admin.id, entity: "AuthorizedNumber", entityId: n.id, meta: { role: parsed.data.role } });
  revalidatePath("/config/numeros");
  return { ok: true, code, name: parsed.data.name };
}

export async function newCodeAction(fd: FormData): Promise<void> {
  const admin = await requirePermission("user:manage");
  const id = String(fd.get("id") ?? "");
  if (!id || !(await db.authorizedNumber.findUnique({ where: { id } }))) return;
  await issueVerificationCode(id);
  await writeAudit({ action: "dono.novo_codigo", actorId: admin.id, entity: "AuthorizedNumber", entityId: id });
  revalidatePath("/config/numeros");
}

export async function toggleNumberAction(fd: FormData): Promise<void> {
  const admin = await requirePermission("user:manage");
  const id = String(fd.get("id") ?? "");
  const active = fd.get("active") === "true";
  if (!id) return;
  await db.authorizedNumber.update({ where: { id }, data: { active } });
  await writeAudit({ action: active ? "dono.numero_ativado" : "dono.numero_desativado", actorId: admin.id, entity: "AuthorizedNumber", entityId: id });
  revalidatePath("/config/numeros");
}
