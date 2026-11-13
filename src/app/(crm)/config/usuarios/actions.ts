"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { createUserSchema, UF_LIST } from "@/lib/validators";
import { hashPassword } from "@/server/password";
import { writeAudit } from "@/server/audit";
import { isRole } from "@/server/rbac";
import { requirePermission } from "@/server/session";

export type FormState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> };

export async function createUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requirePermission("user:manage");

  const parsed = createUserSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role"),
    states: formData.getAll("states").filter((s) => (UF_LIST as readonly string[]).includes(String(s))),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0] ?? "form")] ??= issue.message;
    return { fieldErrors };
  }

  const { name, email, role, states, password } = parsed.data;
  if (await db.user.findUnique({ where: { email } })) {
    return { fieldErrors: { email: "Já existe um usuário com este e-mail." } };
  }

  const user = await db.user.create({
    data: { name, email, role, states: role === "REPRESENTANTE" ? states : [], passwordHash: await hashPassword(password) },
  });
  await writeAudit({ action: "usuario.criado", actorId: admin.id, entity: "User", entityId: user.id, meta: { role, email } });
  revalidatePath("/config/usuarios");
  return { ok: true };
}

// Impede que o administrador se tranque para fora: não desativa nem rebaixa a si mesmo
// nem o último administrador ativo.
async function guardLastAdmin(targetId: string, adminId: string): Promise<string | null> {
  if (targetId === adminId) return "Você não pode alterar a sua própria conta por aqui.";
  const target = await db.user.findUnique({ where: { id: targetId } });
  if (target?.role === "ADMIN") {
    const admins = await db.user.count({ where: { role: "ADMIN", active: true } });
    if (admins <= 1) return "Este é o último administrador ativo.";
  }
  return null;
}

export async function setActiveAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("user:manage");
  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";
  if (!id) return;
  if (!active && (await guardLastAdmin(id, admin.id))) return;
  await db.user.update({ where: { id }, data: { active, failedLogins: 0, lockedUntil: null } });
  await writeAudit({ action: active ? "usuario.ativado" : "usuario.desativado", actorId: admin.id, entity: "User", entityId: id });
  revalidatePath("/config/usuarios");
}

export async function setRoleAction(formData: FormData): Promise<void> {
  const admin = await requirePermission("user:manage");
  const id = String(formData.get("id") ?? "");
  const role = formData.get("role");
  if (!id || !isRole(role)) return;
  const target = await db.user.findUnique({ where: { id } });
  if (!target || target.role === role) return;
  if (role !== "ADMIN" && (await guardLastAdmin(id, admin.id))) return;
  await db.user.update({ where: { id }, data: { role, states: role === "REPRESENTANTE" ? target.states : [] } });
  await writeAudit({ action: "usuario.papel_alterado", actorId: admin.id, entity: "User", entityId: id, meta: { de: target.role, para: role } });
  revalidatePath("/config/usuarios");
}
