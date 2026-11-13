// Entende o que o dono pediu e devolve uma INTENÇÃO de um conjunto fechado. A IA só interpreta o texto;
// quem executa é código determinístico, com permissões e confirmação em dois passos.
import { z } from "zod";
import { llmFromEnv } from "@/server/agent/llm";
import { normalize } from "@/server/agent/knowledge";
import { PERIODS } from "@/server/owner/report";

const refs = z.union([z.literal("todas"), z.array(z.string().min(3).max(8)).max(10)]);

export const intentSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("relatorio"), period: z.enum(PERIODS) }),
  z.object({ intent: z.literal("pendencias") }),
  z.object({ intent: z.literal("financeiro") }),
  z.object({ intent: z.literal("aprovar"), refs }),
  z.object({ intent: z.literal("rejeitar"), refs }),
  z.object({ intent: z.literal("status_lead"), query: z.string().min(2).max(120) }),
  z.object({ intent: z.literal("pausar_agente") }),
  z.object({ intent: z.literal("retomar_agente") }),
  z.object({ intent: z.literal("pausar_contato_frio") }),
  z.object({ intent: z.literal("retomar_contato_frio") }),
  z.object({ intent: z.literal("followup_cotacoes") }),
  z.object({ intent: z.literal("avisar_quando_responder"), query: z.string().min(2).max(120) }),
  z.object({ intent: z.literal("horario_silencio"), startHour: z.number().int().min(0).max(23).nullable(), endHour: z.number().int().min(0).max(23).nullable() }),
  z.object({ intent: z.literal("confirmar") }),
  z.object({ intent: z.literal("cancelar") }),
  z.object({ intent: z.literal("ajuda") }),
  z.object({ intent: z.literal("desconhecido") }),
]);
export type OwnerIntent = z.infer<typeof intentSchema>;

export interface OwnerBrain {
  readonly name: string;
  parse(text: string): Promise<OwnerIntent>;
}

const GENERIC_STATUS = /^(as |os |a |o )?(vendas|vendas de hoje|leads|numeros|funil|negocios|operacao|tudo|coisas|semana|mes|dia)$/;

export function extractRefs(raw: string): string[] {
  // Códigos de 4 caracteres (letras e números), com ou sem "#".
  return [...raw.toUpperCase().matchAll(/#?\b([A-Z0-9]{4})\b/g)].map((m) => m[1]!).filter((c) => /\d/.test(c) || /^[A-Z]{4}$/.test(c)).filter((c) => !["PODE", "TODAS", "ENVIAR", "MANDAR", "AGORA", "SIM", "NAO"].includes(c));
}

// Regras para entender frases comuns do dono. Usado em desenvolvimento e como plano B.
export class MockOwnerBrain implements OwnerBrain {
  readonly name = "regras";

  async parse(raw: string): Promise<OwnerIntent> {
    const t = normalize(raw);
    if (/^(confirmo|confirma|confirmado|sim confirmo|pode confirmar)$/.test(t)) return { intent: "confirmar" };
    if (/^(cancelar|cancela|cancelo|nao confirmo|deixa pra la|esquece)$/.test(t)) return { intent: "cancelar" };
    if (/^(ajuda|help|menu|comandos|o que voce (faz|sabe fazer)|como funciona)$/.test(t)) return { intent: "ajuda" };

    // Aceita o verbo no infinitivo ou no imperativo (retomar, retome, pause, pare...).
    const RETOMAR = /\b(retom\w*|religu\w*|religar|reativ\w*|volt\w+ a|ligue|ligar)\b/;
    const PAUSAR = /\b(paus\w*|pare|parar|suspend\w*|suspender|deslig\w*|nao envie|nao mande)\b/;
    const FRIO = /\b(contato frio|prospeccao|mensagens? frias?)\b/;
    const AGENTE = /\b(agente|automacao|envios|todos os envios|tudo)\b/;
    if (RETOMAR.test(t) && FRIO.test(t)) return { intent: "retomar_contato_frio" };
    if (PAUSAR.test(t) && FRIO.test(t)) return { intent: "pausar_contato_frio" };
    if (RETOMAR.test(t) && AGENTE.test(t)) return { intent: "retomar_agente" };
    if (PAUSAR.test(t) && AGENTE.test(t)) return { intent: "pausar_agente" };

    if (/\b(follow ?up|acompanh\w*|cobrar|retomar contato)\b.*\b(cotac\w*|orcamento\w*|sumiram|sem resposta)\b|\bcotac\w*\b.*\b(sem resposta|sumiram|paradas?)\b/.test(t)) return { intent: "followup_cotacoes" };

    const watch = t.match(/\b(?:me avis\w+|avise me|me notifi\w+|notifique me)\b.*?\bquando (?:o |a |os |as )?(.+?) (?:responder|responde|escrever|falar|chamar|mandar mensagem)/);
    if (watch) return { intent: "avisar_quando_responder", query: watch[1]!.trim() };

    const AFTER = /\b(?:depois|apos|a partir)\s+(?:das|de|do)?\s*(\d{1,2})(?:\s*h(?:oras?)?)?(?!\d)/;
    if (/\b(nao|sem)\s+(envie|enviar|mande|mandar|contate|contatar)\b/.test(t) && AFTER.test(t)) {
      const h = Number(t.match(AFTER)![1]);
      if (h >= 0 && h <= 23) return { intent: "horario_silencio", startHour: h, endHour: 8 };
    }
    if (/\b(pode|volte a)\b.*\b(enviar|mandar)\b.*\b(qualquer horario|sem limite de horario|a qualquer hora)\b/.test(t)) return { intent: "horario_silencio", startHour: null, endHour: null };

    if (/^(sim|pode (enviar|mandar)|aprovo|aprovar|aprova|aprovado|autorizo|ok pode|pode sim|manda ver)\b/.test(t)) {
      return { intent: "aprovar", refs: /\b(todas|tudo|todos)\b/.test(t) ? "todas" : extractRefs(raw) };
    }
    if (/^(nao|nao envie|nao mande|rejeito|rejeitar|rejeita|cancelar mensagem|negado)\b/.test(t)) {
      return { intent: "rejeitar", refs: /\b(todas|tudo|todos)\b/.test(t) ? "todas" : extractRefs(raw) };
    }

    if (/\b(financeiro|cobranc\w*|inadimpl\w*|quem (esta )?(me )?(devendo|deve)|contas a receber|a receber|recebimentos?)\b/.test(t) && !/\b(follow ?up|lembrete)\b/.test(t)) return { intent: "financeiro" };

    if (/(pendenc\w*|pendente\w*|aprovac\w*|aguardando|o que (falta|preciso))/.test(t)) return { intent: "pendencias" };

    const status = t.match(/\b(?:como (?:esta|ta|anda)|status|situacao|andamento|novidades?)\s+(?:d[oa]s?\s+|o |a )?(.{2,80})$/);
    if (status && !GENERIC_STATUS.test(status[1]!.trim())) return { intent: "status_lead", query: status[1]!.trim() };

    if (/(relatorio|resumo|balanco|vendas|numeros|leads|como (estao|foram|esta|foi|anda))/.test(t)) {
      const period = /\bontem\b/.test(t) ? "ontem" : /\b(semana|7 dias|sete dias)\b/.test(t) ? "semana" : /\b(mes|mensal)\b/.test(t) ? "mes" : "hoje";
      return { intent: "relatorio", period };
    }
    return { intent: "desconhecido" };
  }
}

// Versão com IA: só converte a frase na intenção (ferramenta com esquema fechado). Falha → "desconhecido".
type ClaudeLike = { messages: { create(params: Record<string, unknown>): Promise<{ content: { type: string; input?: unknown }[] }> } };

export const OWNER_SYSTEM_PROMPT = `Você interpreta mensagens do dono da Flurtek enviadas por WhatsApp e as converte em UMA intenção, chamando a ferramenta "registrar_intencao". Você não executa nada, apenas classifica.
Intenções: relatorio(period: hoje|ontem|semana|mes), pendencias, financeiro (cobranças, vencidos, a receber), aprovar(refs), rejeitar(refs), status_lead(query), pausar_agente, retomar_agente, pausar_contato_frio, retomar_contato_frio, followup_cotacoes, avisar_quando_responder(query), horario_silencio(startHour,endHour), confirmar, cancelar, ajuda, desconhecido.
Em dúvida, use "desconhecido". Códigos de ação são 4 caracteres, com ou sem "#". "todas" só quando o dono disser todas.`;

export class ClaudeOwnerBrain implements OwnerBrain {
  readonly name: string;
  constructor(
    private client: ClaudeLike,
    private model: string,
    private fallback: OwnerBrain = new MockOwnerBrain(),
    label = "claude",
  ) {
    this.name = `${label}:${model}`;
  }

  static fromEnv(): ClaudeOwnerBrain | null {
    const llm = llmFromEnv("owner");
    return llm ? new ClaudeOwnerBrain(llm.client, llm.model, undefined, llm.label) : null;
  }

  async parse(text: string): Promise<OwnerIntent> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        system: OWNER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `<mensagem_do_dono>\n${text.slice(0, 1000)}\n</mensagem_do_dono>` }],
        tools: [{ name: "registrar_intencao", description: "Registra a intenção do dono.", input_schema: z.toJSONSchema(intentSchema, { target: "draft-07" }) }],
        tool_choice: { type: "tool", name: "registrar_intencao" },
      });
      const block = res.content.find((b) => b.type === "tool_use");
      const parsed = intentSchema.safeParse(block?.input);
      if (parsed.success) return parsed.data;
    } catch {
      /* cai nas regras */
    }
    return this.fallback.parse(text);
  }
}

let cached: OwnerBrain | null = null;
export function getOwnerBrain(): OwnerBrain {
  cached ??= ClaudeOwnerBrain.fromEnv() ?? new MockOwnerBrain();
  return cached;
}

// O worker troca o cérebro quando o admin muda a IA no painel (veja llm-runtime.ts).
export function setOwnerBrain(brain: OwnerBrain) {
  cached = brain;
}
