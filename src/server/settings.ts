import { db } from "@/lib/db";

export const AGENT_ENABLED_KEY = "agent.enabled";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } });
  return row ? (row.value as T) : fallback;
}

export async function putSetting(key: string, value: unknown, updatedById?: string) {
  const json = value as never;
  await db.setting.upsert({
    where: { key },
    update: { value: json, updatedById },
    create: { key, value: json, updatedById },
  });
}

// Chave geral: com o agente pausado, nenhuma ação automática pode ser executada.
export async function isAgentEnabled(): Promise<boolean> {
  return getSetting<boolean>(AGENT_ENABLED_KEY, true);
}

export const QUIET_HOURS_KEY = "agent.quietHours";
export type QuietHours = { start: number; end: number } | null;

export async function getQuietHours(): Promise<QuietHours> {
  return getSetting<QuietHours>(QUIET_HOURS_KEY, null);
}

// Hora cheia em São Paulo (0 a 23).
export function hourInSP(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(now)) % 24;
}

// Horário de silêncio atravessa a meia-noite (ex.: das 20 às 8).
export function isQuietNow(now: Date, qh: QuietHours): boolean {
  if (!qh) return false;
  const h = hourInSP(now);
  return qh.start === qh.end ? false : qh.start < qh.end ? h >= qh.start && h < qh.end : h >= qh.start || h < qh.end;
}
