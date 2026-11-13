import { db } from "@/lib/db";
import { can } from "@/server/rbac";
import { ServiceError, type Actor } from "@/server/leads/rules";

export type CustomerRow = {
  id: string;
  name: string;
  uf: string | null;
  product: string;
  lastOrderAt: Date;
  cycleDays: number;
  nextRestockAt: Date;
  daysToRestock: number; // negativo = atrasada
  totalOrders: number;
};

const DAY = 86_400_000;

export function restockInfo(lastOrderAt: Date, cycleDays: number, now = new Date()) {
  const nextRestockAt = new Date(lastOrderAt.getTime() + cycleDays * DAY);
  return { nextRestockAt, daysToRestock: Math.ceil((nextRestockAt.getTime() - now.getTime()) / DAY) };
}

export async function listCustomers(actor: Actor): Promise<CustomerRow[]> {
  if (!can(actor.role, "lead:read")) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
  const rows = await db.customer.findMany({
    where: actor.role === "REPRESENTANTE" ? { company: { uf: { in: actor.states } } } : {},
    include: { company: { select: { name: true, uf: true } }, orders: { orderBy: { orderedAt: "desc" } } },
  });
  return rows
    .filter((c) => c.orders.length > 0)
    .map((c) => {
      const last = c.orders[0]!;
      return {
        id: c.id,
        name: c.company.name,
        uf: c.company.uf,
        product: last.product,
        lastOrderAt: last.orderedAt,
        cycleDays: c.cycleDays,
        totalOrders: c.orders.length,
        ...restockInfo(last.orderedAt, c.cycleDays),
      };
    })
    .sort((a, b) => a.daysToRestock - b.daysToRestock);
}
