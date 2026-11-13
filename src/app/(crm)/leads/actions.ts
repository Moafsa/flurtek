"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/session";
import { ServiceError } from "@/server/leads/rules";
import {
  addNote,
  assignLead,
  createLead,
  createTask,
  moveLead,
  setTaskStatus,
  updateLead,
} from "@/server/leads/service";
import { isStage } from "@/server/leads/rules";

export type ActionState = { ok?: boolean; error?: string };

function fail(error: unknown): ActionState {
  if (error instanceof ServiceError) return { error: error.message };
  console.error("[leads/actions]", error);
  return { error: "Não foi possível concluir. Tente novamente." };
}

function refresh(leadId?: string) {
  revalidatePath("/funil");
  revalidatePath("/painel");
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

// Chamada direta pelo quadro kanban (arrastar e soltar) e pelo seletor de etapa.
export async function moveLeadAction(leadId: string, stage: string, lostReason?: string): Promise<ActionState> {
  try {
    const user = await requireUser();
    if (!isStage(stage)) return { error: "Etapa inválida." };
    await moveLead(user, leadId, stage, lostReason);
    refresh(leadId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function addNoteAction(leadId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    await addNote(user, leadId, String(formData.get("text") ?? ""));
    refresh(leadId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function createTaskAction(leadId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const due = String(formData.get("dueAt") ?? "");
    await createTask(user, leadId, {
      title: String(formData.get("title") ?? ""),
      // Data escolhida vale até o fim do dia no horário de Brasília.
      dueAt: due ? new Date(`${due}T23:59:00-03:00`) : null,
      assigneeId: String(formData.get("assigneeId") ?? "") || null,
    });
    refresh(leadId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function setTaskStatusAction(leadId: string, taskId: string, status: "ABERTA" | "CONCLUIDA" | "CANCELADA"): Promise<ActionState> {
  try {
    const user = await requireUser();
    await setTaskStatus(user, taskId, status);
    refresh(leadId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function updateLeadAction(leadId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const user = await requireUser();
    const value = String(formData.get("estimatedValue") ?? "").replace(/\./g, "").replace(",", ".").trim();
    await updateLead(user, leadId, {
      product: String(formData.get("product") ?? "") || null,
      volume: String(formData.get("volume") ?? "") || null,
      estimatedValue: value === "" ? null : Number(value),
      nextAction: String(formData.get("nextAction") ?? "") || null,
      temperature: String(formData.get("temperature") ?? "") || undefined,
      uf: String(formData.get("uf") ?? "") || null,
      city: String(formData.get("city") ?? "") || null,
    });
    refresh(leadId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function assignLeadAction(leadId: string, owner: string): Promise<ActionState> {
  try {
    const user = await requireUser();
    await assignLead(user, leadId, owner === "" ? null : owner);
    refresh(leadId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function createLeadAction(_prev: ActionState & { fieldError?: string }, formData: FormData): Promise<ActionState> {
  let leadId: string;
  try {
    const user = await requireUser();
    const value = String(formData.get("estimatedValue") ?? "").replace(/\./g, "").replace(",", ".").trim();
    const lead = await createLead(user, {
      company: String(formData.get("company") ?? ""),
      uf: String(formData.get("uf") ?? ""),
      city: String(formData.get("city") ?? ""),
      segment: String(formData.get("segment") ?? ""),
      contactName: String(formData.get("contactName") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      product: String(formData.get("product") ?? ""),
      volume: String(formData.get("volume") ?? ""),
      estimatedValue: value === "" ? null : Number(value),
      source: String(formData.get("source") ?? ""),
      consentBase: String(formData.get("consentBase") ?? ""),
    });
    leadId = lead.id;
  } catch (e) {
    return fail(e);
  }
  refresh();
  redirect(`/leads/${leadId}`);
}
