"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/session";
import { ServiceError } from "@/server/leads/rules";
import { decideAction, setPolicy } from "@/server/agent/service";

export type AgentState = { ok?: boolean; error?: string };

function fail(e: unknown): AgentState {
  if (e instanceof ServiceError) return { error: e.message };
  console.error("[agente]", e);
  return { error: "Não foi possível concluir. Tente novamente." };
}

export async function decideActionAction(id: string, decision: "APROVAR" | "REJEITAR", draft?: string): Promise<AgentState> {
  try {
    await decideAction(await requireUser(), id, decision, draft);
    revalidatePath("/agente");
    revalidatePath("/painel");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setPolicyAction(task: string, level: string): Promise<AgentState> {
  try {
    await setPolicy(await requireUser(), task, level);
    revalidatePath("/agente");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
