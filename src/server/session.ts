import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { can, isRole, type Permission, type RoleName } from "@/server/rbac";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  states: string[];
};

// Lê a sessão e confirma no banco: conta desativada ou papel alterado valem na hora,
// sem esperar o token expirar.
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await db.user.findUnique({ where: { id } });
  if (!user || !user.active || !isRole(user.role)) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role, states: user.states };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

// Exige permissão. Sem ela, volta ao painel (páginas) ou lança erro (ações).
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user.role, permission)) redirect("/painel?negado=1");
  return user;
}
