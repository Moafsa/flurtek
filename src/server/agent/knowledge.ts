// Base de conhecimento aprovada. Busca por palavras (sem embeddings ainda): suficiente para um FAQ pequeno.
import { db } from "@/lib/db";

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["a", "o", "as", "os", "de", "do", "da", "dos", "das", "e", "em", "no", "na", "um", "uma", "para", "por", "com", "que", "se", "eu", "voce", "voces", "meu", "minha", "posso", "pode", "como", "qual", "quais", "quando", "tem", "ter", "ola", "oi", "bom", "dia", "tarde", "noite"]);

export function tokens(text: string): string[] {
  return [...new Set(normalize(text).split(" ").filter((t) => t.length > 2 && !STOP.has(t)))];
}

export type KnowledgeHit = { id: string; title: string; body: string; score: number };

// Só documentos APROVADOS entram nas respostas do agente.
export async function searchKnowledge(query: string, limit = 3): Promise<KnowledgeHit[]> {
  const q = tokens(query);
  if (!q.length) return [];
  const docs = await db.knowledgeDoc.findMany({ where: { status: "APROVADO" } });
  return docs
    .map((d) => {
      const title = new Set(tokens(d.title));
      const body = new Set(tokens(d.body));
      let score = 0;
      for (const t of q) {
        if (title.has(t)) score += 3;
        if (body.has(t)) score += 1;
      }
      return { id: d.id, title: d.title, body: d.body, score };
    })
    .filter((h) => h.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
