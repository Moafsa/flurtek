// Gabinete: trata as mensagens do dono pelo WhatsApp. Verifica quem é, interpreta o pedido, pede
// confirmação em dois passos nas ações sensíveis e executa com as permissões do usuário vinculado.
import { createHash, randomInt } from "node:crypto";
import type { AuthorizedNumber, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { maskPhone } from "@/lib/phone";
import { ago, brl } from "@/lib/format";
import { STAGE_LABEL, TEMPERATURE_LABEL, type StageName, type TemperatureName } from "@/lib/crm-constants";
import { writeAudit } from "@/server/audit";
import type { RoleName } from "@/server/rbac";
import { allow } from "@/server/ratelimit";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { decideAction, listPendingActions, setAgentEnabled, setPolicy } from "@/server/agent/service";
import { runFollowUps } from "@/server/agent/operation";
import { getOwnerBrain, type OwnerBrain, type OwnerIntent } from "@/server/owner/intents";
import { buildReport, formatReport, PERIODS } from "@/server/owner/report";
import { ownerConversation, queueOwnerMessage } from "@/server/owner/notify";
import { hourInSP, putSetting, QUIET_HOURS_KEY } from "@/server/settings";
import { financeSummary, listCharges } from "@/server/finance/service";
import { dateOnly } from "@/lib/format";

const CONFIRM_MINUTES = 5;
export const code = (id: string) => id.slice(-4).toUpperCase();
const hashCode = (c: string) => createHash("sha256").update(`${c}|${process.env.AUTH_SECRET ?? ""}`).digest("hex");

// ---------- verificação do número ----------

export async function issueVerificationCode(numberId: string, now = new Date()): Promise<string> {
  const c = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.authorizedNumber.update({ where: { id: numberId }, data: { verifyCodeHash: hashCode(c), verifyExpiresAt: new Date(now.getTime() + 30 * 60_000), verifiedAt: null } });
  return c;
}

async function tryVerify(n: AuthorizedNumber, text: string, now: Date): Promise<string | null> {
  const m = text.trim().match(/^verificar\s+(\d{6})$/i);
  if (!m) return null;
  if (!n.verifyCodeHash || !n.verifyExpiresAt || n.verifyExpiresAt < now) return "O código expirou ou não existe. Peça um novo ao administrador do CRM.";
  if (hashCode(m[1]!) !== n.verifyCodeHash) {
    await writeAudit({ action: "dono.verificacao_falhou", actorType: "SISTEMA", entity: "AuthorizedNumber", entityId: n.id });
    return "Código incorreto.";
  }
  await db.authorizedNumber.update({ where: { id: n.id }, data: { verifiedAt: now, verifyCodeHash: null, verifyExpiresAt: null } });
  await writeAudit({ action: "dono.numero_verificado", actorType: "SISTEMA", entity: "AuthorizedNumber", entityId: n.id });
  return `Número verificado, ${n.name.split(" ")[0]}! Já posso ajudar. Envie AJUDA para ver o que eu faço.`;
}

// ---------- permissões por papel ----------

const READ_ONLY: OwnerIntent["intent"][] = ["relatorio", "pendencias", "status_lead", "avisar_quando_responder", "ajuda", "confirmar", "cancelar", "desconhecido", "aprovar", "rejeitar"];
const SENSITIVE = new Set<OwnerIntent["intent"]>(["pausar_agente", "retomar_agente", "pausar_contato_frio", "retomar_contato_frio", "followup_cotacoes", "horario_silencio"]);

async function actorOf(n: AuthorizedNumber): Promise<Actor | null> {
  if (!n.userId) return null;
  const u = await db.user.findFirst({ where: { id: n.userId, active: true } });
  return u ? { id: u.id, role: u.role as RoleName, states: u.states } : null;
}

export const HELP = [
  "*O que posso fazer por você:*",
  "• RELATÓRIO (hoje, ontem, semana, mês)",
  "• PENDÊNCIAS: o que aguarda sua aprovação",
  "• FINANCEIRO: a receber, vencido e recebido no mês",
  "• SIM #CÓDIGO / NÃO #CÓDIGO: aprovar ou rejeitar uma mensagem",
  "• STATUS <cliente>: como está um lead",
  "• Me avise quando <cliente> responder",
  "• Faça follow-up das cotações sem resposta",
  "• Não envie mensagens depois das 20h",
  "• PAUSAR AGENTE / RETOMAR AGENTE",
  "• Pare as mensagens frias / retome as mensagens frias",
  "Ações sensíveis pedem que você responda CONFIRMO.",
].join("\n");

// ---------- execução ----------

async function findLeads(query: string) {
  return db.lead.findMany({
    where: { OR: [{ title: { contains: query, mode: "insensitive" } }, { company: { name: { contains: query, mode: "insensitive" } } }] },
    include: { owner: { select: { name: true } }, tasks: { where: { status: "ABERTA" } } },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
}

function describeLead(l: Awaited<ReturnType<typeof findLeads>>[number]): string {
  return [
    `*${l.title}*: ${STAGE_LABEL[l.stage as StageName]}, ${TEMPERATURE_LABEL[l.temperature as TemperatureName]} (pontuação ${l.score})`,
    l.product ? `Produto: ${l.product}${l.volume ? ` · ${l.volume}` : ""}${l.estimatedValue ? ` · ${brl(Number(l.estimatedValue))}/mês` : ""}` : null,
    `Último contato: ${l.lastContactAt ? ago(l.lastContactAt) : "sem registro"}`,
    l.nextAction ? `Próxima ação: ${l.nextAction}` : null,
    `Responsável: ${l.agentOwned ? "Agente IA" : (l.owner?.name ?? "ninguém")} · Tarefas abertas: ${l.tasks.length}`,
  ].filter(Boolean).join("\n");
}

async function execute(intent: OwnerIntent, n: AuthorizedNumber, actor: Actor | null, now: Date): Promise<string> {
  const needActor = () => {
    if (!actor) throw new ServiceError("SEM_PERMISSAO", "Este número ainda não está ligado a um usuário do CRM. Peça ao administrador para vincular em Config > Números autorizados.");
    return actor;
  };

  switch (intent.intent) {
    case "ajuda":
      return HELP;

    case "relatorio":
      return formatReport(await buildReport(intent.period, now));

    case "pendencias": {
      const a = needActor();
      const list = await listPendingActions(a);
      if (!list.length) return "Nada aguardando a sua aprovação.";
      const lines = list.slice(0, 8).map((x) => {
        const tpl = (x.output as { needsTemplate?: boolean } | null)?.needsTemplate ? " (precisa de modelo)" : "";
        return `*#${code(x.id)}* · ${x.kind.replaceAll("_", " ")} · ${x.lead?.title ?? "—"}${tpl}\n“${(x.draft ?? "").slice(0, 110)}${(x.draft ?? "").length > 110 ? "…" : ""}”`;
      });
      return `*${list.length} aguardando você:*\n${lines.join("\n\n")}\n\nResponda SIM #CÓDIGO para aprovar ou NÃO #CÓDIGO para rejeitar.`;
    }

    case "financeiro": {
      const a = needActor();
      const s = await financeSummary(a, now);
      const late = await listCharges(a, { status: "VENCIDA" });
      const top = late.slice(0, 5).map((c) => `• ${c.order.customer.company.name}: ${brl(Number(c.value), 2)} (venceu ${dateOnly(c.dueDate)})`);
      return [
        "*Financeiro*",
        `A receber: ${brl(s.aReceber, 2)} (${s.qtdAberta} cobrança(s))`,
        `Vencido: ${brl(s.vencido, 2)} (${s.qtdVencida})`,
        `Recebido no mês: ${brl(s.recebidoMes, 2)}`,
        s.semNota ? `Pagos sem nota fiscal: ${s.semNota}` : "",
        top.length ? `\n*Vencidas:*\n${top.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "aprovar":
    case "rejeitar": {
      const a = needActor();
      const approve = intent.intent === "aprovar";
      const pending = await listPendingActions(a);
      let targets = pending;
      if (intent.refs === "todas") {
        // Aprovar tudo pula o que depende de modelo: isso precisa ser visto uma a uma.
        targets = approve ? pending.filter((x) => !(x.output as { needsTemplate?: boolean } | null)?.needsTemplate) : pending;
      } else if (intent.refs.length) {
        targets = pending.filter((x) => intent.refs.includes(code(x.id)));
        const unknown = intent.refs.filter((r) => !pending.some((x) => code(x.id) === r));
        if (!targets.length) return `Não achei pendência com ${unknown.map((u) => "#" + u).join(", ")}. Envie PENDÊNCIAS para ver a lista.`;
      } else if (pending.length === 1) {
        targets = pending;
      } else if (pending.length === 0) {
        return "Nada aguardando a sua aprovação.";
      } else {
        return `Há ${pending.length} pendências. Diga qual: SIM #CÓDIGO. Envie PENDÊNCIAS para ver os códigos.`;
      }
      const out: string[] = [];
      for (const t of targets) {
        try {
          await decideAction(a, t.id, approve ? "APROVAR" : "REJEITAR");
          out.push(`${approve ? "Aprovado" : "Rejeitado"}: ${t.kind.replaceAll("_", " ")} · ${t.lead?.title ?? "—"}`);
        } catch (e) {
          out.push(`#${code(t.id)}: ${e instanceof ServiceError ? e.message : "não consegui decidir"}`);
        }
      }
      const skipped = intent.refs === "todas" && approve ? pending.length - targets.length : 0;
      return `${out.join("\n")}${approve ? "\nO envio acontece na próxima rodada, se a janela de 24 h estiver aberta." : ""}${skipped ? `\n${skipped} pendência(s) ficaram de fora por dependerem de modelo. Veja em PENDÊNCIAS.` : ""}`;
    }

    case "status_lead": {
      const leads = await findLeads(intent.query);
      if (!leads.length) return `Não encontrei nenhum lead com “${intent.query}”.`;
      if (leads.length > 1) return `Achei ${leads.length}: ${leads.map((l) => l.title).join("; ")}. Diga o nome completo.`;
      return describeLead(leads[0]!);
    }

    case "avisar_quando_responder": {
      const leads = await findLeads(intent.query);
      if (!leads.length) return `Não encontrei nenhum lead com “${intent.query}”.`;
      if (leads.length > 1) return `Achei ${leads.length}: ${leads.map((l) => l.title).join("; ")}. Diga o nome completo.`;
      await db.ownerWatch.create({ data: { phoneKey: n.phoneKey, leadId: leads[0]!.id } });
      return `Combinado. Aviso você assim que *${leads[0]!.title}* responder.`;
    }

    case "pausar_agente":
      await setAgentEnabled(needActor(), false);
      return "Agente pausado. Nenhuma ação automática será executada até você pedir RETOMAR AGENTE. A equipe continua podendo enviar mensagens.";
    case "retomar_agente":
      await setAgentEnabled(needActor(), true);
      return "Agente retomado.";

    case "pausar_contato_frio": {
      const a = needActor();
      await setPolicy(a, "primeiro_contato_frio", "HUMANO");
      await setPolicy(a, "criar_leads_prospeccao", "HUMANO");
      return "Mensagens frias e prospecção ficaram somente com pessoas. Para voltar: RETOMAR MENSAGENS FRIAS.";
    }
    case "retomar_contato_frio": {
      const a = needActor();
      await setPolicy(a, "primeiro_contato_frio", "APROVACAO");
      await setPolicy(a, "criar_leads_prospeccao", "APROVACAO");
      return "Mensagens frias e prospecção voltaram para o modo “com aprovação”.";
    }

    case "followup_cotacoes": {
      needActor();
      const r = await runFollowUps(now, { force: true });
      return r.followUps ? `Preparei ${r.followUps} follow-up(s): ${r.pending} aguardam a sua aprovação e ${r.autoApproved} saem sozinhos. Envie PENDÊNCIAS para ver.` : "Não há cotações sem resposta que precisem de follow-up agora.";
    }

    case "horario_silencio": {
      needActor();
      if (intent.startHour === null) {
        await putSetting(QUIET_HOURS_KEY, null);
        return "Tirei o horário de silêncio. O agente pode enviar a qualquer hora (respeitando a janela de 24 h).";
      }
      await putSetting(QUIET_HOURS_KEY, { start: intent.startHour, end: intent.endHour ?? 8 });
      return `Combinado: o agente não envia mensagens a clientes das ${intent.startHour}h às ${intent.endHour ?? 8}h (horário de Brasília).`;
    }

    default:
      return "Não entendi. Envie AJUDA para ver o que posso fazer.";
  }
}

function summaryOf(i: OwnerIntent): string {
  switch (i.intent) {
    case "pausar_agente": return "pausar o agente (nenhuma ação automática será executada)";
    case "retomar_agente": return "retomar o agente";
    case "pausar_contato_frio": return "deixar mensagens frias e prospecção somente com pessoas";
    case "retomar_contato_frio": return "voltar mensagens frias e prospecção para o modo com aprovação";
    case "followup_cotacoes": return "preparar follow-up para todas as cotações sem resposta";
    case "horario_silencio": return i.startHour === null ? "liberar o envio em qualquer horário" : `bloquear envios a clientes das ${i.startHour}h às ${i.endHour ?? 8}h`;
    case "aprovar": return "aprovar TODAS as pendências que não dependem de modelo";
    default: return i.intent;
  }
}

// ---------- ponto de entrada ----------

export async function handleOwnerText(n: AuthorizedNumber, text: string, opts: { now?: Date; brain?: OwnerBrain } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  if (!n.active) return "Este número não está autorizado.";

  const verified = await tryVerify(n, text, now);
  if (verified) return verified;
  if (!n.verifiedAt) return "Este número ainda não foi verificado. Peça o código ao administrador do CRM e envie: VERIFICAR 123456";
  if (!allow(`owner:${n.phoneKey}`, 30, 60_000)) return "Muitas mensagens seguidas. Aguarde um minuto.";

  const brain = opts.brain ?? getOwnerBrain();
  let intent: OwnerIntent;
  try {
    intent = await brain.parse(text);
  } catch {
    intent = { intent: "desconhecido" };
  }
  const actor = await actorOf(n);
  const audit = (extra: Record<string, unknown> = {}) =>
    writeAudit({ action: "dono.comando", actorType: "USUARIO", actorId: actor?.id ?? null, entity: "AuthorizedNumber", entityId: n.id, meta: { intent: intent.intent, numero: maskPhone(n.phoneKey), papel: n.role, ...extra } as Prisma.InputJsonValue });

  try {
    // Confirmar ou cancelar um comando sensível pendente
    if (intent.intent === "confirmar" || intent.intent === "cancelar") {
      const pending = await db.ownerCommand.findFirst({ where: { phoneKey: n.phoneKey, usedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
      if (!pending) return "Não há nada aguardando confirmação.";
      await db.ownerCommand.update({ where: { id: pending.id }, data: { usedAt: now } });
      if (intent.intent === "cancelar") {
        await audit({ cancelado: pending.kind });
        return "Cancelado. Nada foi feito.";
      }
      const stored = pending.payload as OwnerIntent;
      const reply = await execute(stored, n, actor, now);
      await audit({ confirmado: pending.kind });
      return reply;
    }

    // Papéis: gestor só consulta e decide mensagens; ações sensíveis são do dono.
    const needsOwnerRole = SENSITIVE.has(intent.intent) || (intent.intent === "aprovar" && intent.refs === "todas");
    if (needsOwnerRole && n.role !== "DONO") {
      await audit({ negado: "papel" });
      return "Essa ação é só do dono. Posso ajudar com relatórios, pendências e status.";
    }
    if (n.role === "GESTOR" && !READ_ONLY.includes(intent.intent)) return "Essa ação é só do dono.";

    // Ações sensíveis pedem confirmação em dois passos
    if (needsOwnerRole) {
      if (!actor) throw new ServiceError("SEM_PERMISSAO", "Este número ainda não está ligado a um usuário do CRM. Peça ao administrador para vincular em Config > Números autorizados.");
      await db.ownerCommand.updateMany({ where: { phoneKey: n.phoneKey, usedAt: null }, data: { usedAt: now } });
      await db.ownerCommand.create({ data: { phoneKey: n.phoneKey, kind: intent.intent, payload: intent as Prisma.InputJsonValue, summary: summaryOf(intent), expiresAt: new Date(now.getTime() + CONFIRM_MINUTES * 60_000) } });
      await audit({ aguardandoConfirmacao: true });
      return `Você quer ${summaryOf(intent)}.\nResponda *CONFIRMO* em até ${CONFIRM_MINUTES} minutos, ou CANCELAR.`;
    }

    const reply = await execute(intent, n, actor, now);
    await audit();
    return reply;
  } catch (e) {
    if (e instanceof ServiceError) return e.message;
    console.error("[dono]", e);
    return "Não consegui concluir agora. Tente de novo em instantes.";
  }
}

// Processa as mensagens novas das conversas do dono e enfileira as respostas.
export async function processOwnerConversations(opts: { now?: Date; brain?: OwnerBrain } = {}): Promise<number> {
  const convs = await db.conversation.findMany({ where: { kind: "DONO", lastInboundAt: { not: null } }, take: 20 });
  let replies = 0;
  for (const c of convs) {
    const claim = await db.conversation.updateMany({ where: { id: c.id, agentProcessedAt: c.agentProcessedAt }, data: { agentProcessedAt: new Date() } });
    if (claim.count === 0) continue;
    const n = c.externalId ? await db.authorizedNumber.findUnique({ where: { phoneKey: c.externalId } }) : null;
    const msgs = await db.message.findMany({ where: { conversationId: c.id, author: "CLIENTE", ...(c.agentProcessedAt ? { receivedAt: { gt: c.agentProcessedAt } } : {}) }, orderBy: { receivedAt: "asc" }, take: 10 });
    if (!n || !msgs.length) continue;
    for (const m of msgs) {
      const reply = await handleOwnerText(n, m.body, opts);
      await queueOwnerMessage(n.phoneKey, reply, { resposta: m.id });
      replies++;
    }
    await db.conversation.update({ where: { id: c.id }, data: { unread: 0 } });
  }
  return replies;
}

// ---------- resumo diário ----------

export async function runDailySummary(now = new Date(), hour = 8): Promise<number> {
  if (hourInSP(now) < hour) return 0;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
  const owners = await db.authorizedNumber.findMany({ where: { active: true, verifiedAt: { not: null }, role: "DONO" } });
  if (!owners.length) return 0;
  const report = formatReport(await buildReport("ontem", now));
  let n = 0;
  for (const o of owners) {
    const key = `resumo:${today}`;
    const dup = await db.message.findFirst({ where: { conversation: { kind: "DONO", externalId: o.phoneKey }, meta: { path: ["dedupeKey"], equals: key } } });
    if (dup) continue;
    await ownerConversation(o.phoneKey);
    await queueOwnerMessage(o.phoneKey, `Bom dia, ${o.name.split(" ")[0]}!\n\n${report}`, { notificacao: true, dedupeKey: key });
    n++;
  }
  return n;
}

export { PERIODS };
