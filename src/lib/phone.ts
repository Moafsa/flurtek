// Telefone brasileiro só com dígitos e DDI 55, para comparar números (ex.: "5554991268955").
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = "55" + d;
  if (!d.startsWith("55") || (d.length !== 12 && d.length !== 13)) return null;
  return d;
}

// Fixo (12 dígitos) ou celular (13). O WhatsApp só atende celular com o 9; aceitamos os dois ao comparar.
export function samePhone(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Formato antigo de celular sem o 9 (55 + DDD + 8 dígitos) vs com o 9.
  const strip9 = (p: string) => (p.length === 13 && p[4] === "9" ? p.slice(0, 4) + p.slice(5) : p);
  return strip9(a) === strip9(b);
}

export function maskPhone(key: string): string {
  return key.length > 6 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…";
}
