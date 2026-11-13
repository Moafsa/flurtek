// Pré-classificação por regras, só para o lead já nascer ordenado. O agente de IA (M5) a substitui.
import type { LeadFormKind } from "@/server/intake/schema";

export type PreScore = { score: number; temperature: "QUENTE" | "MORNO" | "FRIO"; nextAction: string };

const BIG = /(ibc|1\.?000\s*l|granel|container)/i;

export function preScore(input: { form: LeadFormKind; product?: string; volume?: string; hasPhone: boolean; frequency?: string }): PreScore {
  const text = `${input.product ?? ""} ${input.volume ?? ""}`;
  let score = 50;

  if (input.form === "lista_espera") return { score: 40, temperature: "FRIO", nextAction: "Avisar no lançamento do fluido de radiador." };
  if (input.form === "representante") return { score: 60, temperature: "MORNO", nextAction: "Enviar os critérios para ser representante e avaliar a região." };

  if (BIG.test(text)) score += 25;
  else if (/\b20\s*l\b/i.test(text)) score += 15;
  const n = Number((input.volume ?? "").match(/\d+/)?.[0] ?? 0);
  if (n >= 10) score += 10;
  if (input.frequency && /semanal|quinzenal|mensal/i.test(input.frequency)) score += 10;
  if (input.hasPhone) score += 5;
  score = Math.min(100, score);

  const temperature = score >= 75 ? "QUENTE" : score >= 55 ? "MORNO" : "FRIO";
  return { score, temperature, nextAction: "Responder em até 2 minutos e confirmar volume e cidade de entrega." };
}
