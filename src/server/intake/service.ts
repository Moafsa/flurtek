// Entrada dos formulários do site no CRM: cria ou reaproveita contato, empresa e lead, com consentimento.
import { createHash } from "node:crypto";
import type { LeadSource } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { writeAudit } from "@/server/audit";
import { preScore } from "@/server/intake/score";
import type { IntakeInput } from "@/server/intake/schema";

export type IntakeResult = { ok: true; reference: string; created: boolean; duplicate?: boolean };

const DEFAULT_CONSENT = "Aceite da Política de Privacidade no formulário do site.";
const DAY = 86_400_000;

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`${ip}|${process.env.AUTH_SECRET ?? ""}`).digest("hex").slice(0, 16);
}

const ref = (id: string) => id.slice(-8).toUpperCase();

function productFor(i: IntakeInput): string | undefined {
  if (i.form === "representante") return "Candidatura a representante";
  if (i.form === "lista_espera") return i.product ? `Fluido de radiador (${i.product})` : "Fluido de radiador";
  return i.product;
}

export async function processIntake(input: IntakeInput, ctx: { ip?: string | null } = {}): Promise<IntakeResult> {
  // Reenvio do mesmo formulário: devolve o mesmo protocolo e não cria nada de novo.
  if (input.submissionId) {
    const seen = await db.intakeSubmission.findUnique({ where: { submissionId: input.submissionId } });
    if (seen) return { ok: true, reference: ref(seen.leadId ?? seen.id), created: false, duplicate: true };
  }

  const phoneKey = normalizePhone(input.phone);
  const ipHash = hashIp(ctx.ip);
  const now = new Date();

  // Contato existente (mesmo e-mail ou telefone) mantém o histórico no mesmo lugar.
  const existingContact =
    (input.email ? await db.contact.findFirst({ where: { email: input.email }, orderBy: { createdAt: "desc" } }) : null) ??
    (phoneKey ? await db.contact.findFirst({ where: { phoneKey }, orderBy: { createdAt: "desc" } }) : null);

  // Assuntos que não são comerciais viram conversa para a equipe, não lead.
  if (input.form === "contato" && input.subject && !/comercial/i.test(input.subject)) {
    const lead = existingContact
      ? await db.lead.findFirst({ where: { contactId: existingContact.id }, orderBy: { createdAt: "desc" } })
      : null;
    const conv = await db.conversation.create({
      data: {
        leadId: lead?.id,
        channel: "EMAIL",
        mode: "HUMANO",
        unread: 1,
        lastInboundAt: now,
        messages: {
          create: {
            author: "CLIENTE",
            status: "recebida",
            body: `[${input.subject}] ${input.name}${input.company ? ` (${input.company})` : ""}\n${input.email ?? ""} ${input.phone ?? ""}\n\n${input.message ?? "(sem mensagem)"}`.trim(),
            meta: { form: input.form, assunto: input.subject, pageUrl: input.pageUrl, ipHash },
          },
        },
      },
    });
    const sub = input.submissionId ? await db.intakeSubmission.create({ data: { submissionId: input.submissionId, form: input.form, leadId: lead?.id } }) : null;
    await writeAudit({ action: "intake.contato", actorType: "SISTEMA", entity: "Conversation", entityId: conv.id, meta: { assunto: input.subject, submission: sub?.id } });
    return { ok: true, reference: ref(conv.id), created: true };
  }

  const product = productFor(input);
  const source: LeadSource = input.form === "lista_espera" ? "SITE_LISTA_ESPERA" : "SITE_FORMULARIO";
  const pre = preScore({ form: input.form, product, volume: input.volume, hasPhone: Boolean(phoneKey), frequency: input.frequency });

  const eventText = [
    input.form === "cotacao" ? "Pediu cotação pelo site" : input.form === "lista_espera" ? "Entrou na lista de espera do fluido de radiador" : input.form === "representante" ? "Candidatou-se a representante pelo site" : "Contato comercial pelo site",
    product ? `· ${product}` : "",
    input.volume ? `· ${input.volume}` : "",
    input.frequency ? `· ${input.frequency}` : "",
    input.message ? `\n“${input.message}”` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(" \n", "\n");
  const meta = { form: input.form, pageUrl: input.pageUrl, ipHash, utm: input.utm ?? null };

  // Pedido repetido do mesmo contato para o mesmo produto em 30 dias: soma na linha do tempo, não duplica o lead.
  if (existingContact) {
    const open = await db.lead.findFirst({
      where: {
        contactId: existingContact.id,
        stage: { notIn: ["FECHADO", "PERDIDO"] },
        product: product ?? null,
        createdAt: { gte: new Date(now.getTime() - 30 * DAY) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (open) {
      await db.$transaction([
        db.leadEvent.create({ data: { leadId: open.id, actorType: "SISTEMA", kind: "criado", text: `Novo pedido pelo site. ${eventText}`, meta } }),
        db.lead.update({ where: { id: open.id }, data: { lastContactAt: now, nextAction: "Cliente voltou a pedir pelo site. Responder agora." } }),
      ]);
      if (input.submissionId) await db.intakeSubmission.create({ data: { submissionId: input.submissionId, form: input.form, leadId: open.id } });
      return { ok: true, reference: ref(open.id), created: false };
    }
  }

  const companyName = input.company ?? existingContact?.name ?? input.name;
  const company =
    (await db.company.findFirst({ where: { name: { equals: companyName, mode: "insensitive" }, uf: input.uf ?? null } })) ??
    (await db.company.create({
      data: { name: companyName, uf: input.uf, city: input.city, segment: input.form === "representante" ? "Candidato a representante" : input.segment, cnpj: undefined },
    }));
  const contact =
    existingContact ??
    (await db.contact.create({ data: { companyId: company.id, name: input.name, email: input.email, phone: input.phone, phoneKey } }));
  if (existingContact && !existingContact.companyId) await db.contact.update({ where: { id: existingContact.id }, data: { companyId: company.id } });

  const lead = await db.lead.create({
    data: {
      title: companyName,
      companyId: company.id,
      contactId: contact.id,
      source,
      sourceDetail: input.form,
      product,
      volume: input.volume,
      uf: input.uf,
      city: input.city,
      score: pre.score,
      temperature: pre.temperature,
      nextAction: pre.nextAction,
      agentOwned: true,
      utmSource: input.utm?.source,
      utmMedium: input.utm?.medium,
      utmCampaign: input.utm?.campaign,
      consentAt: now,
      consentText: input.consentText ?? DEFAULT_CONSENT,
      consentSource: `site:${input.form}`,
      events: { create: { actorType: "SISTEMA", kind: "criado", text: eventText, meta } },
    },
  });
  if (input.submissionId) await db.intakeSubmission.create({ data: { submissionId: input.submissionId, form: input.form, leadId: lead.id } });
  await writeAudit({ action: "intake.lead_criado", actorType: "SISTEMA", entity: "Lead", entityId: lead.id, meta: { form: input.form } });
  return { ok: true, reference: ref(lead.id), created: true };
}
