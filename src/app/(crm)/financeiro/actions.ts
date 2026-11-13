"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/session";
import { ServiceError } from "@/server/leads/rules";
import { cancelCharge, cancelInvoice, createCharge, createOrder, emitInvoice } from "@/server/finance/service";

function back(msg?: { erro?: string; ok?: string }): never {
  const q = msg?.erro ? `?erro=${encodeURIComponent(msg.erro)}` : msg?.ok ? `?ok=${encodeURIComponent(msg.ok)}` : "";
  redirect(`/financeiro${q}`);
}

// Erros de regra viram mensagem na tela; o resto sobe.
async function run(fn: () => Promise<string>): Promise<never> {
  let msg: { erro?: string; ok?: string };
  try {
    msg = { ok: await fn() };
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    msg = { erro: e.message };
  }
  revalidatePath("/financeiro");
  return back(msg);
}

const orderSchema = z.object({
  customerId: z.string().min(1, "Escolha o cliente."),
  product: z.string().trim().min(2, "Informe o produto."),
  volume: z.string().trim().optional(),
  value: z.coerce.number().positive("Informe um valor maior que zero.").max(10_000_000),
});

export async function createOrderAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = orderSchema.safeParse({ customerId: fd.get("customerId"), product: fd.get("product"), volume: String(fd.get("volume") ?? ""), value: String(fd.get("value") ?? "").replace(/\./g, "").replace(",", ".") });
  if (!parsed.success) return back({ erro: parsed.error.issues[0]!.message });
  await run(async () => {
    await createOrder(user, parsed.data);
    return "Pedido criado.";
  });
}

const chargeSchema = z.object({ orderId: z.string().min(1), billingType: z.enum(["PIX", "BOLETO", "CREDIT_CARD", "UNDEFINED"]), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Informe o vencimento.") });

export async function createChargeAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const parsed = chargeSchema.safeParse({ orderId: fd.get("orderId"), billingType: fd.get("billingType"), due: fd.get("due") });
  if (!parsed.success) return back({ erro: parsed.error.issues[0]!.message });
  await run(async () => {
    await createCharge(user, parsed.data.orderId, { billingType: parsed.data.billingType, dueDate: new Date(`${parsed.data.due}T12:00:00Z`) });
    return "Cobrança criada.";
  });
}

export async function emitInvoiceAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const orderId = String(fd.get("orderId") ?? "");
  await run(async () => {
    const doc = await emitInvoice(user, orderId);
    return doc.status === "EMITIDA" ? `Nota emitida${doc.number ? ` (nº ${doc.number})` : ""}.` : "Nota enviada para emissão.";
  });
}

export async function cancelChargeAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  await run(async () => {
    await cancelCharge(user, String(fd.get("chargeId") ?? ""));
    return "Cobrança cancelada.";
  });
}

export async function cancelInvoiceAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  await run(async () => {
    await cancelInvoice(user, String(fd.get("docId") ?? ""), String(fd.get("reason") ?? ""));
    return "Nota cancelada.";
  });
}
