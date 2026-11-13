// Travas que valem SEMPRE, qualquer que seja o "cérebro" (regras ou IA) e a configuração de autonomia.
import { normalize } from "@/server/agent/knowledge";

export type SensitiveTopic = "preco_desconto" | "contrato_juridico" | "reclamacao" | "reembolso" | "ordem_suspeita";

const RULES: { topic: SensitiveTopic; re: RegExp }[] = [
  { topic: "preco_desconto", re: /\b(desconto|abatimento|baixar o preco|melhorar o preco|preco especial|negociar|tabela de preco|quanto custa|qual o preco|qual o valor|valor do|orcamento com preco|parcel|prazo de pagamento|boleto|faturad)/ },
  { topic: "contrato_juridico", re: /\b(contrato|clausula|juridic|advogad|procon|processo|notificacao|multa|rescisao|exclusividade)\b/ },
  { topic: "reclamacao", re: /\b(reclama|reclamacao|absurdo|pessimo|horrivel|decepcion|enganad|nunca chegou|atrasou|veio errado|produto errado|estragou|vazou|defeito|insatisf|cancelar pedido|quero cancelar)\b/ },
  { topic: "reembolso", re: /\b(reembolso|estorno|devolucao|devolver|ressarc|trocar o produto)\b/ },
  // Tentativas de dar ordens ao agente por mensagem de cliente: nunca são ordens.
  { topic: "ordem_suspeita", re: /(ignore|esqueca|desconsidere)\b.{0,40}\b(regras|instrucoes|ordens|anterior)|\b(sou o dono|sou da diretoria|sou o administrador|modo desenvolvedor|prompt do sistema|system prompt|aja como|finja que)\b|\b(aprove|libere|envie)\b.{0,40}\b(desconto|tudo|gratis|de graca)\b/ },
];

export function detectSensitive(text: string): SensitiveTopic[] {
  const t = normalize(text);
  return RULES.filter((r) => r.re.test(t)).map((r) => r.topic);
}

export const TOPIC_LABEL: Record<SensitiveTopic, string> = {
  preco_desconto: "preço ou desconto",
  contrato_juridico: "contrato ou assunto jurídico",
  reclamacao: "reclamação",
  reembolso: "reembolso ou devolução",
  ordem_suspeita: "tentativa de instruir o agente",
};

// O texto que o agente quer enviar nunca pode conter valores, descontos ou promessas.
export type DraftIssue = "contem_valor" | "contem_desconto" | "contem_promessa" | "vazio" | "muito_longo";

export function draftIssues(draft: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const t = normalize(draft);
  if (!draft.trim()) return ["vazio"];
  if (draft.length > 1200) issues.push("muito_longo");
  if (/R\$\s*\d|\d+\s*(reais|real)\b|\b\d+[.,]?\d*\s*(%|por cento)/i.test(draft)) issues.push("contem_valor");
  if (/\b(desconto|abatimento|gratis|de graca|promocao|frete gratis|sem custo)\b/.test(t)) issues.push("contem_desconto");
  if (/\b(garanto|garantimos|prometo|prometemos|com certeza chega|sem falta|prazo de \d+|em ate \d+ (dias|horas))\b/.test(t)) issues.push("contem_promessa");
  return issues;
}

export const ESCALATION_HOLD =
  "Entendi! Vou passar o seu pedido para a nossa equipe, que retorna com você ainda hoje.";
