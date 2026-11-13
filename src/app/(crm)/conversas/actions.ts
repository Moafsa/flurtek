"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/session";
import { ServiceError } from "@/server/leads/rules";
import { sendHumanMessage, setConversationMode } from "@/server/conversations/service";

export type ConvState = { ok?: boolean; error?: string };

function fail(e: unknown): ConvState {
  if (e instanceof ServiceError) return { error: e.message };
  console.error("[conversas]", e);
  return { error: "Não foi possível concluir. Tente novamente." };
}

export async function sendMessageAction(id: string, _prev: ConvState, fd: FormData): Promise<ConvState> {
  try {
    await sendHumanMessage(await requireUser(), id, String(fd.get("body") ?? ""));
    revalidatePath("/conversas");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setModeAction(id: string, mode: "AGENTE" | "HUMANO"): Promise<ConvState> {
  try {
    await setConversationMode(await requireUser(), id, mode);
    revalidatePath("/conversas");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
