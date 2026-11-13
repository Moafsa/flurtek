const TZ = "America/Sao_Paulo";

export function brl(value: number | null | undefined, fractionDigits = 0): string {
  return Number(value ?? 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function dateTime(d: Date | string): string {
  return new Date(d).toLocaleString("pt-BR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
}

export function dateOnly(d: Date | string): string {
  return new Date(d).toLocaleDateString("pt-BR", { timeZone: TZ });
}

// "há 3 dias", "há 2 h", "agora"
export function ago(d: Date | string, now = new Date()): string {
  const diff = Math.max(0, now.getTime() - new Date(d).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.floor(h / 24);
  return days === 1 ? "há 1 dia" : `há ${days} dias`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function isPast(d: Date | string): boolean {
  return new Date(d).getTime() < Date.now();
}

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

// Data de amanhã (AAAA-MM-DD), para valor padrão de formulários.
export function tomorrowISO(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}
