// Regras de negócio dos leads. Sem dependência do Next.js: roda igual nas páginas, nas ações e nos testes.
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  CONSENT_BASES,
  MANUAL_SOURCES,
  STAGE_LABEL,
  STAGES,
  TEMPERATURES,
  type StageName,
} from "@/lib/crm-constants";
import { UF_LIST } from "@/lib/validators";
import { can, type Permission } from "@/server/rbac";
import { writeAudit } from "@/server/audit";
import { inScope, leadScope, ServiceError, validateMove, type Actor } from "@/server/leads/rules";

function need(actor: Actor, permission: Permission) {
  if (!can(actor.role, permission)) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
}

async function loadScoped(actor: Actor, id: string) {
  const lead = await db.lead.findUnique({ where: { id }, include: { company: true } });
  // Mesma resposta para "não existe" e "não é seu": não revela leads de outros estados.
  if (!lead || !inScope(actor, lead)) throw new ServiceError("NAO_ENCONTRADO", "Lead não encontrado.");
  return lead;
}

// ---------- Consulta ----------

export type LeadFilters = {
  q?: string;
  temperature?: string;
  owner?: "agente" | "equipe" | "meus" | "sem";
  uf?: string;
  segment?: string;
  includeClosed?: boolean;
};

export async function listLeads(actor: Actor, f: LeadFilters = {}) {
  need(actor, "lead:read");
  const and: Prisma.LeadWhereInput[] = [leadScope(actor)];
  const q = f.q?.trim();
  if (q) {
    and.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { product: { contains: q, mode: "insensitive" } },
        { city: { contains: q, mode: "insensitive" } },
        { company: { name: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  if (f.temperature && (TEMPERATURES as readonly string[]).includes(f.temperature)) {
    and.push({ temperature: f.temperature as (typeof TEMPERATURES)[number] });
  }
  if (f.uf && (UF_LIST as readonly string[]).includes(f.uf)) and.push({ uf: f.uf });
  if (f.segment) and.push({ company: { segment: f.segment } });
  if (f.owner === "agente") and.push({ agentOwned: true });
  if (f.owner === "equipe") and.push({ agentOwned: false, ownerId: { not: null } });
  if (f.owner === "meus") and.push({ ownerId: actor.id });
  if (f.owner === "sem") and.push({ agentOwned: false, ownerId: null });
  if (!f.includeClosed) and.push({ stage: { notIn: ["PERDIDO", "FRIO"] } });

  return db.lead.findMany({
    where: { AND: and },
    include: { company: { select: { name: true, segment: true } }, owner: { select: { id: true, name: true } } },
    orderBy: [{ score: "desc" }, { updatedAt: "desc" }],
    take: 500,
  });
}

export async function listSegments(actor: Actor): Promise<string[]> {
  need(actor, "lead:read");
  const rows = await db.company.findMany({
    where: { segment: { not: null }, leads: { some: leadScope(actor) } },
    select: { segment: true },
    distinct: ["segment"],
    orderBy: { segment: "asc" },
  });
  return rows.map((r) => r.segment!).filter(Boolean);
}

export async function getLead(actor: Actor, id: string) {
  need(actor, "lead:read");
  const lead = await db.lead.findUnique({
    where: { id },
    include: {
      company: true,
      contact: true,
      owner: { select: { id: true, name: true, role: true } },
      events: { orderBy: { createdAt: "desc" }, include: { actor: { select: { name: true } } }, take: 200 },
      tasks: { orderBy: [{ status: "asc" }, { dueAt: "asc" }], include: { assignee: { select: { id: true, name: true } } } },
      actions: { where: { status: "PENDENTE" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!lead || !inScope(actor, lead)) return null;
  return lead;
}

export async function listAssignees() {
  return db.user.findMany({
    where: { active: true, role: { in: ["ADMIN", "COMERCIAL", "REPRESENTANTE"] } },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" },
  });
}

// ---------- Mudanças ----------

export async function moveLead(actor: Actor, id: string, to: StageName, lostReason?: string | null) {
  need(actor, "lead:move");
  if (!(STAGES as readonly string[]).includes(to)) throw new ServiceError("INVALIDO", "Etapa inválida.");
  const problem = validateMove(to, lostReason);
  if (problem) throw new ServiceError("INVALIDO", problem);

  const lead = await loadScoped(actor, id);
  if (lead.stage === to) return lead;

  const reason = to === "PERDIDO" ? lostReason!.trim() : null;
  const [updated] = await db.$transaction([
    db.lead.update({ where: { id }, data: { stage: to, lostReason: reason } }),
    db.leadEvent.create({
      data: {
        leadId: id,
        actorType: "USUARIO",
        actorId: actor.id,
        kind: "etapa",
        text: `Moveu de "${STAGE_LABEL[lead.stage]}" para "${STAGE_LABEL[to]}".${reason ? ` Motivo: ${reason}` : ""}`,
        meta: { from: lead.stage, to },
      },
    }),
  ]);
  await writeAudit({ action: "lead.etapa", actorId: actor.id, entity: "Lead", entityId: id, meta: { from: lead.stage, to } });
  return updated;
}

const noteSchema = z.string().trim().min(2, "Escreva a nota.").max(2000, "Nota muito longa.");

export async function addNote(actor: Actor, id: string, text: string) {
  need(actor, "lead:note");
  const parsed = noteSchema.safeParse(text);
  if (!parsed.success) throw new ServiceError("INVALIDO", parsed.error.issues[0]!.message);
  await loadScoped(actor, id);
  const ev = await db.leadEvent.create({
    data: { leadId: id, actorType: "USUARIO", actorId: actor.id, kind: "nota", text: parsed.data },
  });
  await db.lead.update({ where: { id }, data: { lastContactAt: new Date() } });
  return ev;
}

export const updateLeadSchema = z.object({
  product: z.string().trim().max(120).nullable().optional(),
  volume: z.string().trim().max(120).nullable().optional(),
  estimatedValue: z.number().min(0).max(100_000_000).nullable().optional(),
  nextAction: z.string().trim().max(300).nullable().optional(),
  temperature: z.enum(TEMPERATURES).optional(),
  uf: z.enum(UF_LIST).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
});
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

const FIELD_LABEL: Record<string, string> = {
  product: "produto",
  volume: "volume",
  estimatedValue: "valor estimado",
  nextAction: "próxima ação",
  temperature: "temperatura",
  uf: "estado",
  city: "cidade",
};

export async function updateLead(actor: Actor, id: string, input: unknown) {
  need(actor, "lead:write");
  const parsed = updateLeadSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError("INVALIDO", parsed.error.issues[0]!.message);
  const lead = await loadScoped(actor, id);

  const data: Prisma.LeadUpdateInput = {};
  const changed: string[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    const normalized = typeof value === "string" && value === "" ? null : value;
    const current = (lead as Record<string, unknown>)[key];
    const same = String(current ?? "") === String(normalized ?? "");
    if (same) continue;
    (data as Record<string, unknown>)[key] = normalized;
    changed.push(FIELD_LABEL[key] ?? key);
  }
  if (!changed.length) return lead;

  const [updated] = await db.$transaction([
    db.lead.update({ where: { id }, data }),
    db.leadEvent.create({
      data: { leadId: id, actorType: "USUARIO", actorId: actor.id, kind: "edicao", text: `Atualizou: ${changed.join(", ")}.` },
    }),
  ]);
  await writeAudit({ action: "lead.editado", actorId: actor.id, entity: "Lead", entityId: id, meta: { campos: changed } });
  return updated;
}

// owner: id de usuário, "AGENTE" ou null (sem responsável)
export async function assignLead(actor: Actor, id: string, owner: string | null) {
  need(actor, "lead:write");
  const lead = await loadScoped(actor, id);
  let label = "sem responsável";
  const data: Prisma.LeadUpdateInput = {};
  if (owner === "AGENTE") {
    data.agentOwned = true;
    data.owner = { disconnect: true };
    label = "Agente IA";
  } else if (owner) {
    const user = await db.user.findFirst({ where: { id: owner, active: true, role: { in: ["ADMIN", "COMERCIAL", "REPRESENTANTE"] } } });
    if (!user) throw new ServiceError("INVALIDO", "Responsável inválido.");
    data.agentOwned = false;
    data.owner = { connect: { id: user.id } };
    label = user.name;
  } else {
    data.agentOwned = false;
    data.owner = { disconnect: true };
  }
  const [updated] = await db.$transaction([
    db.lead.update({ where: { id }, data }),
    db.leadEvent.create({
      data: { leadId: id, actorType: "USUARIO", actorId: actor.id, kind: "atribuicao", text: `Responsável: ${label}.`, meta: { owner } },
    }),
  ]);
  await writeAudit({ action: "lead.atribuido", actorId: actor.id, entity: "Lead", entityId: lead.id, meta: { owner } });
  return updated;
}

const taskSchema = z.object({
  title: z.string().trim().min(2, "Escreva o título da tarefa.").max(160),
  dueAt: z.date().nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
});

export async function createTask(actor: Actor, leadId: string, input: unknown) {
  need(actor, "task:write");
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError("INVALIDO", parsed.error.issues[0]!.message);
  await loadScoped(actor, leadId);
  const assigneeId = parsed.data.assigneeId ?? actor.id;
  if (!(await db.user.findFirst({ where: { id: assigneeId, active: true } }))) {
    throw new ServiceError("INVALIDO", "Responsável pela tarefa inválido.");
  }
  const task = await db.task.create({
    data: { leadId, assigneeId, title: parsed.data.title, dueAt: parsed.data.dueAt ?? null },
  });
  await db.leadEvent.create({
    data: { leadId, actorType: "USUARIO", actorId: actor.id, kind: "tarefa", text: `Criou a tarefa "${task.title}".` },
  });
  return task;
}

export async function setTaskStatus(actor: Actor, taskId: string, status: "ABERTA" | "CONCLUIDA" | "CANCELADA") {
  need(actor, "task:write");
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task || !task.leadId) throw new ServiceError("NAO_ENCONTRADO", "Tarefa não encontrada.");
  await loadScoped(actor, task.leadId);
  const updated = await db.task.update({ where: { id: taskId }, data: { status } });
  await db.leadEvent.create({
    data: {
      leadId: task.leadId,
      actorType: "USUARIO",
      actorId: actor.id,
      kind: "tarefa",
      text: `${status === "CONCLUIDA" ? "Concluiu" : status === "CANCELADA" ? "Cancelou" : "Reabriu"} a tarefa "${task.title}".`,
    },
  });
  return updated;
}

// ---------- Criação ----------

export const createLeadSchema = z.object({
  company: z.string().trim().min(2, "Informe o nome da empresa.").max(120),
  uf: z.enum(UF_LIST, { error: "Escolha o estado." }),
  city: z.string().trim().max(120).optional(),
  segment: z.string().trim().max(80).optional(),
  contactName: z.string().trim().max(120).optional(),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().pipe(z.email("E-mail inválido"))]).optional(),
  phone: z.string().trim().max(40).optional(),
  product: z.string().trim().max(120).optional(),
  volume: z.string().trim().max(120).optional(),
  estimatedValue: z.number().min(0).max(100_000_000).nullable().optional(),
  source: z.enum(MANUAL_SOURCES),
  consentBase: z.enum(Object.keys(CONSENT_BASES) as [keyof typeof CONSENT_BASES, ...(keyof typeof CONSENT_BASES)[]], {
    error: "Informe de onde veio o contato (base legal).",
  }),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export async function createLead(actor: Actor, input: unknown) {
  need(actor, "lead:write");
  const parsed = createLeadSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError("INVALIDO", parsed.error.issues[0]!.message);
  const v = parsed.data;

  const company =
    (await db.company.findFirst({ where: { name: { equals: v.company, mode: "insensitive" }, uf: v.uf } })) ??
    (await db.company.create({ data: { name: v.company, uf: v.uf, city: v.city || null, segment: v.segment || null } }));

  const contact =
    v.contactName || v.email || v.phone
      ? await db.contact.create({
          data: { companyId: company.id, name: v.contactName || v.company, email: v.email || null, phone: v.phone || null },
        })
      : null;

  const lead = await db.lead.create({
    data: {
      title: v.company,
      companyId: company.id,
      contactId: contact?.id,
      source: v.source,
      product: v.product || null,
      volume: v.volume || null,
      estimatedValue: v.estimatedValue ?? null,
      uf: v.uf,
      city: v.city || null,
      ownerId: actor.id,
      consentAt: new Date(),
      consentText: CONSENT_BASES[v.consentBase],
      consentSource: v.consentBase,
      events: {
        create: { actorType: "USUARIO", actorId: actor.id, kind: "criado", text: `Lead cadastrado manualmente. Base: ${CONSENT_BASES[v.consentBase]}.` },
      },
    },
  });
  await writeAudit({ action: "lead.criado", actorId: actor.id, entity: "Lead", entityId: lead.id, meta: { source: v.source } });
  return lead;
}
