"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/session";
import { setAgentEnabled } from "@/server/agent/service";
import { isAgentEnabled } from "@/server/settings";

// Chave geral do agente (só administrador). Quando pausado, nenhuma ação automática roda.
export async function toggleAgentAction(): Promise<void> {
  const user = await requireUser();
  const next = !(await isAgentEnabled());
  try {
    await setAgentEnabled(user, next);
  } catch {
    return; // sem permissão: nada muda
  }
  revalidatePath("/", "layout");
}
