"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/session";
import { ServiceError } from "@/server/leads/rules";
import { CryptoConfigError } from "@/server/crypto";
import { removeAiKey, saveAiConfig, testAiConnection, type AiTestResult } from "@/server/agent/ai-config";

export type IaState = { ok?: boolean; error?: string };
export type IaTestState = { result?: AiTestResult; error?: string };

export async function saveIaAction(_prev: IaState, fd: FormData): Promise<IaState> {
  const admin = await requirePermission("agent:configure");
  const text = (k: string) => String(fd.get(k) ?? "").trim();
  try {
    await saveAiConfig(admin, { provider: text("provider"), apiKey: String(fd.get("apiKey") ?? ""), model: text("model"), ownerModel: text("ownerModel"), dataCollection: text("dataCollection") });
  } catch (e) {
    if (e instanceof ServiceError || e instanceof CryptoConfigError) return { error: e.message };
    throw e;
  }
  revalidatePath("/config/ia");
  return { ok: true };
}

export async function removeIaKeyAction(): Promise<void> {
  const admin = await requirePermission("agent:configure");
  await removeAiKey(admin);
  revalidatePath("/config/ia");
}

export async function testIaAction(): Promise<IaTestState> {
  const admin = await requirePermission("agent:configure");
  try {
    return { result: await testAiConnection(admin) };
  } catch (e) {
    if (e instanceof ServiceError) return { error: e.message };
    throw e;
  }
}
