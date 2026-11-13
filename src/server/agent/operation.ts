// Agente de operação: transforma mensagens e eventos em classificação, respostas, escalonamentos,
// follow-ups e lembretes de recompra, SEMPRE dentro da política de autonomia e das travas.
// Ele nunca envia nada: cria ações que o executor (canal) envia depois, quando permitido.
import type { AutonomyLevel, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/server/audit";
import { getBrain } from "@/server/agent/brain-select";
import { type Brain, type BrainContext, type Decision, type ReplyKind } from "@/server/agent/brain";
import { BrainError } from "@/server/agent/claude-brain";
import { detectSensitive, draftIssues, ESCALATION_HOLD, TOPIC_LABEL, type DraftIssue } from "@/server/agent/guardrails";
import { searchKnowledge } from "@/server/agent/knowledge";
import { insideWindow } from "@/server/channels/types";
import { restockInfo } from "@/server/customers/service";
import { isAgentEnabled } from "@/server/settings";
import { notifyOwners } from "@/server/owner/notify";

export type OperationSummary = {
  skipped?: string;
  conversations: number;
  replies: number;
  autoApproved: number;
  pending: number;
  escalations: number;
  classified: number;
  followUps: number;
  repurchase: number;
  newLeads: number;
  errors: number;
};
const empty = (): OperationSummary => ({ conversations: 0, replies: 0, autoApproved: 0, pending: 0, escalations: 0, classified: 0, followUps: 0, repurchase: 0, newLeads: 0, errors: 0 });

export const POLICY_BY_KIND: Record<Exclude<ReplyKind, "escalonamento">, string> = {
  duvida_tecnica: "responder_duvida_tecnica",
  qualificacao: "primeiro_contato_inbound",
  cotacao: "enviar_cotacao",
  followup: "follow_up",
  suporte: "suporte_pos_venda",
};

export async function levelFor(task: string): Promise<AutonomyLevel> {
  return (await db.autonomyPolicy.findUnique({ where: { task } }))?.level ?? "APROVACAO";
}

// Nível final de uma resposta. As travas valem acima da configuração do administrador.
export function resolveLevel(input: { policy: AutonomyLevel; kind: ReplyKind; confidence: number; issues: DraftIssue[]; needsTemplate?: boolean }): { level: AutonomyLevel; forcedBy: string[] } {
  const forcedBy: string[] = [];
  if (input.kind === "escalonamento") return { level: "AUTOMATICO", forcedBy }; // texto fixo, sem conteúdo
  if (input.policy === "HUMANO") return { level: "HUMANO", forcedBy };
  if (input.issues.some((i) => i === "contem_valor" || i === "contem_desconto" || i === "contem_promessa")) forcedBy.push(`texto: ${input.issues.join(", ")}`);
  if (input.issues.includes("muito_longo")) forcedBy.push("texto longo");
  if (input.confidence < 60) forcedBy.push(`confiança baixa (${input.confidence}%)`);
  if (input.needsTemplate) forcedBy.push("fora da janela de 24 h (precisa de modelo)");
  if (input.kind === "cotacao") forcedBy.push("cotação sempre passa por uma pessoa");
  if (forcedBy.length) return { level: "APROVACAO", forcedBy };
  return { level: input.policy, forcedBy };
}

async function firstCommercial(): Promise<string | null> {
  return (await db.user.findFirst({ where: { active: true, role: "COMERCIAL" }, orderBy: { createdAt: "asc" } }))?.id ?? null;
}

type LeadRow = NonNullable<Awaited<ReturnType<typeof loadLead>>>;
async function loadLead(id: string) {
  return db.lead.findUnique({ where: { id }, include: { company: true, contact: true } });
}

async function applyClassification(lead: LeadRow, d: Decision, brain: Brain): Promise<boolean> {
  if ((await levelFor("classificar_lead")) !== "AUTOMATICO") return false;
  const c = d.classification;
  const data: Prisma.LeadUpdateInput = {};
  const changes: string[] = [];
  const set = <K extends "product" | "volume" | "city" | "uf">(k: K, v: string | null) => {
    if (v && lead[k] !== v) {
      (data as Record<string, unknown>)[k] = v;
      changes.push(`${k === "product" ? "produto" : k === "volume" ? "volume" : k === "city" ? "cidade" : "estado"}: ${v}`);
    }
  };
  set("product", c.product);
  set("volume", c.volume);
  set("city", c.city);
  if (!lead.uf) set("uf", c.uf);
  if (lead.temperature !== c.temperature) {
    data.temperature = c.temperature;
    changes.push(`temperatura: ${c.temperature.toLowerCase()}`);
  }
  if (Math.abs(lead.score - c.score) >= 5) {
    data.score = c.score;
    changes.push(`pontuação: ${c.score}`);
  }
  if (c.segment && !lead.company?.segment && lead.companyId) {
    await db.company.update({ where: { id: lead.companyId }, data: { segment: c.segment } });
    changes.push(`segmento: ${c.segment}`);
  }
  if (!changes.length) return false;
  await db.$transaction([
    db.lead.update({ where: { id: lead.id }, data }),
    db.leadEvent.create({ data: { leadId: lead.id, actorType: "AGENTE", kind: "agente", text: `Classificou o lead (${changes.join("; ")}).`, meta: { brain: brain.name, intent: d.intent } } }),
  ]);
  return true;
}

export async function createAction(a: {
  leadId: string;
  conversationId: string | null;
  kind: string;
  draft: string;
  confidence: number;
  reason: string;
  level: AutonomyLevel;
  forcedBy: string[];
  decision?: Decision;
  needsTemplate?: boolean;
  brain: string;
}): Promise<"auto" | "pending" | "human"> {
  const auto = a.level === "AUTOMATICO";
  if (a.level === "HUMANO") return "human";
  const row = await db.agentAction.create({
    data: {
      leadId: a.leadId,
      conversationId: a.conversationId,
      tool: "agente_operacao",
      kind: a.kind,
      draft: a.draft,
      confidence: a.confidence,
      reason: a.reason,
      status: auto ? "APROVADA" : "PENDENTE",
      decidedAt: auto ? new Date() : null,
      output: { brain: a.brain, level: a.level, forcedBy: a.forcedBy, needsTemplate: a.needsTemplate ?? false, intent: a.decision?.intent ?? null } as Prisma.InputJsonValue,
    },
  });
  await writeAudit({ action: auto ? "agente.acao_automatica" : "agente.acao_proposta", actorType: "AGENTE", entity: "AgentAction", entityId: row.id, meta: { kind: a.kind, forcedBy: a.forcedBy } });
  return auto ? "auto" : "pending";
}

async function escalate(lead: LeadRow, convId: string | null, reason: string, opts: { hold: boolean; brain: string; sensitive?: string[] }) {
  const assignee = lead.ownerId ?? (await firstCommercial());
  const ops: Prisma.PrismaPromise<unknown>[] = [
    db.task.create({ data: { leadId: lead.id, assigneeId: assignee, title: `Retornar ao cliente: ${reason}`.slice(0, 160), dueAt: new Date(Date.now() + 4 * 3_600_000) } }),
    db.leadEvent.create({ data: { leadId: lead.id, actorType: "AGENTE", kind: "agente", text: `Escalou para a equipe: ${reason}`, meta: { brain: opts.brain, sensitive: opts.sensitive ?? [] } } }),
  ];
  if (convId) {
    ops.push(db.conversation.update({ where: { id: convId }, data: { mode: "HUMANO" } }));
    ops.push(db.message.create({ data: { conversationId: convId, author: "SISTEMA", body: `Conversa entregue à equipe: ${reason}` } }));
  }
  await db.$transaction(ops);
  if (opts.hold && convId) {
    await createAction({ leadId: lead.id, conversationId: convId, kind: "escalonamento", draft: ESCALATION_HOLD, confidence: 100, reason: "Aviso padrão ao cliente enquanto a equipe assume.", level: "AUTOMATICO", forcedBy: [], brain: opts.brain });
  }
  await writeAudit({ action: "agente.escalou", actorType: "AGENTE", entity: "Lead", entityId: lead.id, meta: { reason } });
  // O dono fica sabendo, uma vez por dia por lead, sem repetir.
  await notifyOwners(`*${lead.title}* precisa de uma pessoa: ${reason}
Criei a tarefa para a equipe. Responda STATUS ${lead.title} para ver o andamento.`, { dedupeKey: `esc:${lead.id}:${new Date().toISOString().slice(0, 10)}` });
}

// ------------------------------------------------------------------------------------------------

export async function processConversation(conversationId: string, opts: { brain?: Brain } = {}): Promise<OperationSummary> {
  const out = empty();
  const brain = opts.brain ?? getBrain();
  const conv = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conv || conv.kind !== "CLIENTE" || conv.mode !== "AGENTE" || !conv.lastInboundAt) return out;
  const fresh = await db.message.count({ where: { conversationId: conv.id, author: "CLIENTE", ...(conv.agentProcessedAt ? { receivedAt: { gt: conv.agentProcessedAt } } : {}) } });
  if (fresh === 0) return out;

  // Trava otimista: só um processador por mensagem nova.
  const claim = await db.conversation.updateMany({ where: { id: conv.id, agentProcessedAt: conv.agentProcessedAt }, data: { agentProcessedAt: new Date() } });
  if (claim.count === 0) return out;
  out.conversations = 1;

  const lead = conv.leadId ? await loadLead(conv.leadId) : null;
  if (!lead) return out;
  if (lead.contact?.optOutAt) return out;

  const history = await db.message.findMany({ where: { conversationId: conv.id, author: { in: ["CLIENTE", "AGENTE", "EQUIPE"] } }, orderBy: { createdAt: "desc" }, take: 12 });
  const messages = history.reverse().map((m) => ({ author: m.author as "CLIENTE" | "AGENTE" | "EQUIPE", text: m.body }));
  const lastClient = [...messages].reverse().find((m) => m.author === "CLIENTE")?.text ?? "";
  const knowledge = await searchKnowledge(lastClient, 3);
  const isFirstContact = !messages.some((m) => m.author === "AGENTE");
  const ctx: BrainContext = {
    lead: { title: lead.title, stage: lead.stage, product: lead.product, volume: lead.volume, uf: lead.uf, city: lead.city, segment: lead.company?.segment ?? null, isFirstContact },
    messages,
    knowledge,
  };

  let decision: Decision;
  try {
    decision = await brain.decide(ctx);
  } catch (e) {
    out.errors++;
    const why = e instanceof BrainError ? e.message : "Erro inesperado no agente.";
    await escalate(lead, conv.id, `IA indisponível (${why})`, { hold: false, brain: brain.name });
    out.escalations++;
    return out;
  }

  // Trava: assunto sensível na mensagem do cliente sempre vai para uma pessoa, mesmo que a IA discorde.
  const sensitive = detectSensitive(lastClient);
  if (sensitive.length) {
    decision = { ...decision, reply: null, escalate: { reason: `Assunto sensível: ${sensitive.map((t) => TOPIC_LABEL[t]).join(", ")}.` } };
  }

  if (await applyClassification(lead, decision, brain)) out.classified++;

  if (decision.escalate) {
    const suspicious = sensitive.includes("ordem_suspeita");
    await escalate(lead, conv.id, decision.escalate.reason, { hold: !suspicious, brain: brain.name, sensitive });
    out.escalations++;
    await writeAudit({ action: "agente.decisao", actorType: "AGENTE", entity: "Conversation", entityId: conv.id, meta: { intent: decision.intent, escalou: true, brain: brain.name } });
    return out;
  }

  if (decision.reply) {
    const issues = draftIssues(decision.reply.text);
    if (issues.includes("vazio")) {
      await escalate(lead, conv.id, "Resposta do agente veio vazia.", { hold: false, brain: brain.name });
      out.escalations++;
      return out;
    }
    const kind = decision.reply.kind;
    const policyTask = kind === "escalonamento" ? "classificar_lead" : POLICY_BY_KIND[kind];
    const { level, forcedBy } = resolveLevel({ policy: await levelFor(policyTask), kind, confidence: decision.confidence, issues });
    const reason = `Intenção: ${decision.intent}.${knowledge.length ? ` Base: ${knowledge.map((k) => k.title).join("; ")}.` : ""}${forcedBy.length ? ` Aprovação exigida: ${forcedBy.join("; ")}.` : ""}`;
    const result = await createAction({ leadId: lead.id, conversationId: conv.id, kind: policyTask, draft: decision.reply.text, confidence: decision.confidence, reason, level, forcedBy, decision, brain: brain.name });
    if (result === "human") {
      await db.$transaction([
        db.conversation.update({ where: { id: conv.id }, data: { mode: "HUMANO" } }),
        db.leadEvent.create({ data: { leadId: lead.id, actorType: "AGENTE", kind: "agente", text: `Tarefa só para pessoas (${policyTask.replaceAll("_", " ")}). Sugestão do agente: “${decision.reply.text.slice(0, 300)}”` } }),
        db.task.create({ data: { leadId: lead.id, assigneeId: lead.ownerId ?? (await firstCommercial()), title: `Responder ao cliente (${policyTask.replaceAll("_", " ")})`, dueAt: new Date(Date.now() + 4 * 3_600_000) } }),
      ]);
      out.escalations++;
    } else {
      out.replies++;
      if (result === "auto") out.autoApproved++;
      else out.pending++;
    }
  }
  await writeAudit({ action: "agente.decisao", actorType: "AGENTE", entity: "Conversation", entityId: conv.id, meta: { intent: decision.intent, confidence: decision.confidence, brain: brain.name } });
  return out;
}

// ---------- follow-up ----------

export const FOLLOW_UP_HOURS = [24, 72, 168];
export const FOLLOW_UP_TEXTS = [
  "Olá! Passando para saber se a cotação que preparamos ajudou. Posso ajustar o volume ou o prazo de entrega para você?",
  "Olá! Ainda posso ajudar com a sua cotação. Se quiser, envio a ficha técnica do produto e tiro qualquer dúvida.",
  "Olá! Esta é a minha última mensagem sobre a cotação, para não incomodar. Se precisar de água desmineralizada ou aditivo para radiador, é só chamar.",
];

export async function runFollowUps(now = new Date(), opts: { force?: boolean } = {}): Promise<OperationSummary> {
  const out = empty();
  const leads = await db.lead.findMany({ where: { stage: "COTACAO", agentOwned: true, contact: { is: { optOutAt: null } } }, include: { contact: true } });
  for (const lead of leads) {
    const attempts = await db.leadEvent.count({ where: { leadId: lead.id, kind: "followup" } });
    if (attempts >= FOLLOW_UP_HOURS.length) continue;
    const lastFollow = await db.leadEvent.findFirst({ where: { leadId: lead.id, kind: "followup" }, orderBy: { createdAt: "desc" } });
    const touches = [lead.lastContactAt, lastFollow?.createdAt, lead.createdAt].filter(Boolean) as Date[];
    const lastTouch = new Date(Math.max(...touches.map((d) => d.getTime())));
    if (!opts.force && now.getTime() - lastTouch.getTime() < FOLLOW_UP_HOURS[attempts]! * 3_600_000) continue;
    if (await db.agentAction.count({ where: { leadId: lead.id, kind: "follow_up", status: { in: ["PENDENTE", "APROVADA"] }, executedAt: null } })) continue;

    const conv = await db.conversation.findFirst({ where: { leadId: lead.id, channel: "WHATSAPP", kind: "CLIENTE" }, orderBy: { updatedAt: "desc" } });
    if (!conv && !lead.contact?.phoneKey) continue; // sem canal de WhatsApp, a equipe decide
    const needsTemplate = !insideWindow(conv?.lastInboundAt, now);
    const text = FOLLOW_UP_TEXTS[attempts]!;
    const { level, forcedBy } = resolveLevel({ policy: await levelFor("follow_up"), kind: "followup", confidence: 90, issues: draftIssues(text), needsTemplate });
    const result = await createAction({ leadId: lead.id, conversationId: conv?.id ?? null, kind: "follow_up", draft: text, confidence: 90, reason: `Follow-up ${attempts + 1} de ${FOLLOW_UP_HOURS.length}: sem resposta desde ${lastTouch.toISOString().slice(0, 10)}.`, level, forcedBy, needsTemplate, brain: "regras" });
    if (result === "human") continue;
    await db.leadEvent.create({ data: { leadId: lead.id, actorType: "AGENTE", kind: "followup", text: `Preparou o follow-up ${attempts + 1} de ${FOLLOW_UP_HOURS.length}.`, createdAt: now } });
    out.followUps++;
    if (result === "auto") out.autoApproved++;
    else out.pending++;
  }
  return out;
}

// ---------- recompra ----------

export async function runRepurchase(now = new Date()): Promise<OperationSummary> {
  const out = empty();
  const customers = await db.customer.findMany({
    include: { company: { include: { contacts: true, leads: { orderBy: { createdAt: "desc" }, take: 1 } } }, orders: { orderBy: { orderedAt: "desc" }, take: 1 } },
  });
  for (const c of customers) {
    const last = c.orders[0];
    const lead = c.company.leads[0];
    const contact = c.company.contacts.find((x) => x.phoneKey && !x.optOutAt);
    if (!last || !lead || !contact) continue;
    const { daysToRestock } = restockInfo(last.orderedAt, c.cycleDays, now);
    if (daysToRestock > 5 || daysToRestock < -14) continue;
    if (await db.agentAction.count({ where: { leadId: lead.id, kind: "lembrete_recompra", createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } })) continue;
    const conv = await db.conversation.findFirst({ where: { leadId: lead.id, channel: "WHATSAPP", kind: "CLIENTE" }, orderBy: { updatedAt: "desc" } });
    const needsTemplate = !insideWindow(conv?.lastInboundAt, now);
    const text = `Olá! Pelo seu ritmo de consumo, está chegando a hora de repor ${last.product}. Quer que eu prepare uma cotação?`;
    const { level, forcedBy } = resolveLevel({ policy: await levelFor("lembrete_recompra"), kind: "followup", confidence: 85, issues: draftIssues(text), needsTemplate });
    const result = await createAction({ leadId: lead.id, conversationId: conv?.id ?? null, kind: "lembrete_recompra", draft: text, confidence: 85, reason: `Ciclo de ${c.cycleDays} dias: a reposição de ${last.product} ${daysToRestock < 0 ? `está atrasada ${-daysToRestock} dia(s)` : `vence em ${daysToRestock} dia(s)`}.`, level, forcedBy, needsTemplate, brain: "regras" });
    if (result === "human") continue;
    out.repurchase++;
    if (result === "auto") out.autoApproved++;
    else out.pending++;
  }
  return out;
}

// ---------- leads novos do site (sem conversa ainda) ----------

export async function processNewLeads(opts: { brain?: Brain; limit?: number } = {}): Promise<OperationSummary> {
  const out = empty();
  const brain = opts.brain ?? getBrain();
  const leads = await db.lead.findMany({
    where: { agentOwned: true, source: { in: ["SITE_FORMULARIO", "SITE_LISTA_ESPERA"] }, events: { none: { kind: "agente" } } },
    include: { company: true, contact: true, events: { where: { kind: "criado" }, take: 1 } },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 10,
  });
  for (const lead of leads) {
    out.newLeads++;
    const row = (await loadLead(lead.id))!;
    const text = lead.events[0]?.text ?? lead.title;
    let decision: Decision;
    try {
      decision = await brain.decide({
        lead: { title: lead.title, stage: lead.stage, product: lead.product, volume: lead.volume, uf: lead.uf, city: lead.city, segment: lead.company?.segment ?? null, isFirstContact: true },
        messages: [{ author: "CLIENTE", text }],
        knowledge: [],
      });
    } catch {
      out.errors++;
      await db.leadEvent.create({ data: { leadId: lead.id, actorType: "AGENTE", kind: "agente", text: "Pré-análise indisponível; a equipe deve abrir o lead." } });
      continue;
    }
    if (await applyClassification(row, decision, brain)) out.classified++;
    await db.leadEvent.create({ data: { leadId: lead.id, actorType: "AGENTE", kind: "agente", text: `Pré-análise feita (intenção: ${decision.intent}, confiança ${decision.confidence}%).`, meta: { brain: brain.name } } });
    // Lead de formulário não tem janela de 24 h aberta: o primeiro contato por WhatsApp exige modelo aprovado.
    // Sem telefone ou na lista de espera, não há mensagem a propor.
    if (lead.source === "SITE_LISTA_ESPERA" || !lead.contact?.phoneKey) continue;
    const draft = `Olá, ${lead.contact.name.split(" ")[0]}! Aqui é a Flurtek. Recebemos o seu pedido pelo site e já estamos cuidando dele. Para preparar a cotação, pode confirmar o volume mensal e a cidade de entrega?`;
    const { level, forcedBy } = resolveLevel({ policy: await levelFor("primeiro_contato_inbound"), kind: "qualificacao", confidence: 85, issues: draftIssues(draft), needsTemplate: true });
    const r = await createAction({ leadId: lead.id, conversationId: null, kind: "primeiro_contato_inbound", draft, confidence: 85, reason: "Cliente pediu contato pelo site e consentiu. Primeiro contato exige modelo aprovado.", level, forcedBy, needsTemplate: true, brain: brain.name });
    if (r === "pending") out.pending++;
    if (r === "auto") out.autoApproved++;
  }
  return out;
}

export async function runAgentCycle(opts: { brain?: Brain; now?: Date } = {}): Promise<OperationSummary> {
  if (!(await isAgentEnabled())) return { ...empty(), skipped: "agente_pausado" };
  const total = empty();
  const add = (s: OperationSummary) => {
    for (const k of Object.keys(total) as (keyof OperationSummary)[]) if (typeof total[k] === "number") (total[k] as number) += (s[k] as number) ?? 0;
  };
  const candidates = await db.conversation.findMany({
    where: { kind: "CLIENTE", mode: "AGENTE", lastInboundAt: { not: null } },
    select: { id: true, agentProcessedAt: true, messages: { where: { author: "CLIENTE" }, orderBy: { receivedAt: "desc" }, take: 1, select: { receivedAt: true } } },
    take: 100,
  });
  const pending = candidates.filter((c) => c.messages[0] && (!c.agentProcessedAt || c.messages[0].receivedAt > c.agentProcessedAt));
  for (const c of pending.slice(0, 20)) {
    try {
      add(await processConversation(c.id, { brain: opts.brain }));
    } catch (e) {
      console.error("[agente] erro na conversa", c.id, e);
      total.errors++;
    }
  }
  for (const step of [() => processNewLeads({ brain: opts.brain }), () => runFollowUps(opts.now), () => runRepurchase(opts.now)]) {
    try {
      add(await step());
    } catch (e) {
      console.error("[agente] erro", e);
      total.errors++;
    }
  }
  return total;
}
