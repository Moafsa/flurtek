// "Cérebro" do agente: recebe o contexto e devolve uma decisão estruturada. Duas implementações:
// MockBrain (regras, sem IA, usado em desenvolvimento e testes) e ClaudeBrain (IA, quando há chave).
import { z } from "zod";
import { UF_LIST } from "@/lib/validators";
import { tokens, type KnowledgeHit } from "@/server/agent/knowledge";
import { detectSensitive } from "@/server/agent/guardrails";

// Corta no fim de uma frase (nunca no meio), para a resposta não terminar truncada.
export function clipAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (end > max * 0.4) return head.slice(0, end + 1);
  return head.replace(/\s+\S*$/, "") + "…";
}

export const REPLY_KINDS = ["duvida_tecnica", "qualificacao", "cotacao", "followup", "suporte", "escalonamento"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export const INTENTS = ["saudacao", "duvida_tecnica", "pedido_cotacao", "preco_desconto", "reclamacao", "suporte", "fora_de_escopo", "outro"] as const;

export const decisionSchema = z.object({
  intent: z.enum(INTENTS),
  classification: z.object({
    segment: z.string().max(80).nullable(),
    product: z.string().max(120).nullable(),
    volume: z.string().max(120).nullable(),
    uf: z.enum(UF_LIST).nullable(),
    city: z.string().max(120).nullable(),
    temperature: z.enum(["QUENTE", "MORNO", "FRIO"]),
    score: z.number().int().min(0).max(100),
  }),
  reply: z.object({ kind: z.enum(REPLY_KINDS), text: z.string().min(1).max(1200) }).nullable(),
  escalate: z.object({ reason: z.string().min(3).max(300) }).nullable(),
  confidence: z.number().int().min(0).max(100),
  knowledgeIds: z.array(z.string()).max(5),
});
export type Decision = z.infer<typeof decisionSchema>;

export type BrainContext = {
  lead: { title: string; stage: string; product: string | null; volume: string | null; uf: string | null; city: string | null; segment: string | null; isFirstContact: boolean };
  // Mensagens mais antigas primeiro. Texto de cliente é DADO, nunca instrução.
  messages: { author: "CLIENTE" | "AGENTE" | "EQUIPE"; text: string }[];
  knowledge: KnowledgeHit[];
};

export interface Brain {
  readonly name: string;
  decide(ctx: BrainContext): Promise<Decision>;
}

// ---------- extração simples usada pelo MockBrain e como apoio ----------

const SEGMENTS: [RegExp, string][] = [
  [/transportador|frota|caminh|logistic/, "Transportadoras"],
  [/empilhadeira|bateria estacionaria|bateria de empilhadeira/, "Empilhadeiras e baterias"],
  [/laboratorio|autoclave|analise/, "Laboratórios"],
  [/laser|corte|usinagem|industria|metalurg/, "Corte a laser e indústria"],
  [/oficina|mecanic|autopecas|auto center|concession/, "Oficinas e autopeças"],
  [/clinica|estetica|hospital/, "Laboratórios"],
];

export function extractFacts(text: string): { product: string | null; volume: string | null; uf: string | null; city: string | null; segment: string | null } {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  let product: string | null = null;
  let volume: string | null = null;
  if (/\b(ibc|1\.?000\s*l|1000 litros|granel|container)\b/.test(t)) {
    product = "Água 1.000L (IBC)";
    volume = text.match(/(\d+)\s*(ibc|container)/i)?.[0] ?? null;
  } else if (/\b20\s*l\b|20 litros|bombona|galao de 20/.test(t)) {
    product = "Água 20L";
    volume = t.match(/(\d+)\s*(galoes|galao|bombonas|unidades)/)?.[0] ?? null;
  } else if (/\b5\s*l\b|5 litros/.test(t)) {
    product = "Água 5L";
  } else if (/\b1\s*l\b|1 litro/.test(t)) {
    product = "Água 1L";
  }
  if (/fluido|aditivo|anticongelante|arrefecimento/.test(t) && !/agua desmineralizada/.test(t)) product = "Fluido de radiador";
  const perMonth = t.match(/(\d+)\s*(galoes|galao|bombonas|ibc|litros|unidades)?\s*(por|\/|ao)\s*mes/);
  if (perMonth) volume = `${perMonth[1]} ${perMonth[2] ?? "unid."}/mês`;
  const ufMatch = text.match(/\b(?:em|de|para)\s+[A-ZÀ-Ú][\wÀ-ú ]+?\s*[-,/]\s*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/);
  const cityMatch = text.match(/\b(?:em|de|para)\s+([A-ZÀ-Ú][\wÀ-ú]+(?: [A-ZÀ-Ú][\wÀ-ú]+)*)\b/);
  const segment = SEGMENTS.find(([re]) => re.test(t))?.[1] ?? null;
  return { product, volume, uf: ufMatch?.[1] ?? null, city: cityMatch?.[1] ?? null, segment };
}

const GREETING = /^(oi|ola|bom dia|boa tarde|boa noite|e ai|opa)\b/;
const TECH = /\b(diluir|diluicao|misturar|mistura|torneira|bateria|radiador|validade|armazen|desmineralizada|deionizada|destilada|condutividade|ph|como usar|serve para|posso usar|compativel|anticorrosivo|anticongelante|norma|nbr|ficha tecnica)\b/;

export class MockBrain implements Brain {
  readonly name = "regras";

  async decide(ctx: BrainContext): Promise<Decision> {
    const last = [...ctx.messages].reverse().find((m) => m.author === "CLIENTE")?.text ?? "";
    const all = ctx.messages.filter((m) => m.author === "CLIENTE").map((m) => m.text).join(" ");
    const norm = last.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const facts = extractFacts(all);
    const product = facts.product ?? ctx.lead.product;
    const volume = facts.volume ?? ctx.lead.volume;
    const sensitive = detectSensitive(last);

    let score = 50;
    if (product?.includes("IBC")) score += 25;
    else if (product?.includes("20L")) score += 15;
    if (volume) score += 10;
    score = Math.min(100, score);
    const base = {
      segment: facts.segment ?? ctx.lead.segment,
      product,
      volume,
      uf: (facts.uf as (typeof UF_LIST)[number] | null) ?? (ctx.lead.uf as (typeof UF_LIST)[number] | null),
      city: facts.city ?? ctx.lead.city,
      temperature: (score >= 75 ? "QUENTE" : score >= 55 ? "MORNO" : "FRIO") as "QUENTE" | "MORNO" | "FRIO",
      score,
    };
    const hit = ctx.knowledge[0];

    if (sensitive.length) {
      const intent = sensitive.includes("reclamacao") ? "reclamacao" : sensitive.includes("preco_desconto") ? "preco_desconto" : "fora_de_escopo";
      return { intent, classification: base, reply: null, escalate: { reason: `Assunto sensível: ${sensitive.join(", ")}.` }, confidence: 90, knowledgeIds: [] };
    }

    if (TECH.test(norm) && hit) {
      const snippet = clipAtSentence(hit.body, 900);
      return {
        intent: "duvida_tecnica",
        classification: base,
        reply: { kind: "duvida_tecnica", text: `${snippet}\n\nPosso ajudar com mais alguma dúvida ou preparar uma cotação para você?` },
        escalate: null,
        confidence: Math.min(95, 60 + hit.score * 5),
        knowledgeIds: [hit.id],
      };
    }
    if (TECH.test(norm) && !hit) {
      return { intent: "duvida_tecnica", classification: base, reply: null, escalate: { reason: "Dúvida técnica fora da base de conhecimento." }, confidence: 40, knowledgeIds: [] };
    }

    if (/cotacao|orcamento|quero comprar|preciso de|quero (uns|[0-9])|fechar pedido/.test(norm)) {
      if (product && volume && (base.city || ctx.lead.city)) {
        return {
          intent: "pedido_cotacao",
          classification: base,
          reply: { kind: "cotacao", text: `Perfeito! Anotei ${product}, ${volume}, entrega em ${base.city ?? ctx.lead.city}. Vou preparar a cotação e a equipe comercial confirma os valores com você.` },
          escalate: null,
          confidence: 80,
          knowledgeIds: [],
        };
      }
      const missing = [!product ? "qual produto" : null, !volume ? "o volume mensal" : null, !(base.city || ctx.lead.city) ? "a cidade de entrega" : null].filter(Boolean).join(", ");
      return { intent: "pedido_cotacao", classification: base, reply: { kind: "qualificacao", text: `Claro! Para preparar a sua cotação, pode me dizer ${missing}?` }, escalate: null, confidence: 75, knowledgeIds: [] };
    }

    if (GREETING.test(norm) || ctx.lead.isFirstContact) {
      return { intent: "saudacao", classification: base, reply: { kind: "qualificacao", text: "Olá! Aqui é o assistente da Flurtek. Posso ajudar com água desmineralizada ou aditivo para radiador. O que você precisa e para qual uso?" }, escalate: null, confidence: 70, knowledgeIds: [] };
    }

    // Sem entendimento suficiente: passa para uma pessoa em vez de adivinhar.
    return { intent: "outro", classification: base, reply: null, escalate: { reason: "Mensagem não compreendida com segurança." }, confidence: 35, knowledgeIds: [] };
  }
}

export function queryFromContext(ctx: BrainContext): string {
  const last = [...ctx.messages].reverse().find((m) => m.author === "CLIENTE")?.text ?? "";
  return tokens(last).join(" ");
}
