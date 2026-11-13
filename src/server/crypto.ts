// Criptografia de segredos guardados no banco (certificado e senha). AES-256-GCM com chave do ambiente.
// A chave (APP_ENCRYPTION_KEY, 32 bytes em base64) fica só no servidor: quem copiar o banco não lê os segredos.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CryptoConfigError extends Error {}

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new CryptoConfigError("Defina APP_ENCRYPTION_KEY no .env para guardar segredos (32 bytes em base64).");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new CryptoConfigError("APP_ENCRYPTION_KEY inválida: precisa ter 32 bytes em base64.");
  return k;
}

export type Sealed = { v: 1; iv: string; tag: string; data: string };

export function seal(plain: Buffer | string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(typeof plain === "string" ? Buffer.from(plain, "utf8") : plain), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function open(s: Sealed): Buffer {
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  try {
    return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]);
  } catch {
    throw new CryptoConfigError("Não foi possível abrir o segredo guardado (a chave APP_ENCRYPTION_KEY mudou?). Envie o certificado de novo.");
  }
}
