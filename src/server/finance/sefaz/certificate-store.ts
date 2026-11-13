// Certificado A1 enviado pelo ADMIN na tela. O arquivo e a senha ficam criptografados no banco;
// a tela só recebe os dados públicos (titular, CNPJ, validade), nunca o arquivo nem a senha.
import { writeAudit } from "@/server/audit";
import { db } from "@/lib/db";
import { open, seal, type Sealed } from "@/server/crypto";
import { can } from "@/server/rbac";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { getSetting } from "@/server/settings";
import { CertificateError, certificateSourceFromEnv, parseCertificate, type CertificateSource } from "@/server/finance/sefaz/certificate";

export const CERTIFICATE_KEY = "finance.certificate";
const MAX_BYTES = 100 * 1024;

type Stored = { file: Sealed; password: Sealed; subject: string; cnpj: string | null; issuer: string; notAfter: string; uploadedAt: string; uploadedBy: string };

export type CertificateInfo = { subject: string; cnpj: string | null; issuer: string; notAfter: Date; daysLeft: number; uploadedAt: Date };

function need(actor: Actor) {
  if (!can(actor.role, "finance:admin")) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
}

export async function saveCertificate(actor: Actor, pfx: Buffer, password: string, now = new Date()): Promise<CertificateInfo> {
  need(actor);
  if (!pfx.length) throw new ServiceError("INVALIDO", "Escolha o arquivo do certificado (.pfx).");
  if (pfx.length > MAX_BYTES) throw new ServiceError("INVALIDO", "Arquivo grande demais para um certificado A1.");
  if (!password) throw new ServiceError("INVALIDO", "Informe a senha do certificado.");
  let cert;
  try {
    cert = parseCertificate(pfx, password, now); // só guarda o que abre com a senha informada
  } catch (e) {
    throw new ServiceError("INVALIDO", e instanceof CertificateError ? e.message : "Não foi possível ler o certificado.");
  }
  if (cert.daysLeft < 0) throw new ServiceError("INVALIDO", `Certificado vencido em ${cert.notAfter.toLocaleDateString("pt-BR")}.`);
  const value: Stored = { file: seal(pfx), password: seal(password), subject: cert.subject, cnpj: cert.cnpj, issuer: cert.issuer, notAfter: cert.notAfter.toISOString(), uploadedAt: now.toISOString(), uploadedBy: actor.id };
  await db.setting.upsert({ where: { key: CERTIFICATE_KEY }, update: { value: value as never, updatedById: actor.id }, create: { key: CERTIFICATE_KEY, value: value as never, updatedById: actor.id } });
  await writeAudit({ action: "financeiro.certificado_enviado", actorId: actor.id, entity: "Setting", entityId: CERTIFICATE_KEY, meta: { cnpj: cert.cnpj, venceEm: cert.notAfter.toISOString().slice(0, 10) } });
  return { subject: cert.subject, cnpj: cert.cnpj, issuer: cert.issuer, notAfter: cert.notAfter, daysLeft: cert.daysLeft, uploadedAt: now };
}

export async function removeCertificate(actor: Actor): Promise<void> {
  need(actor);
  await db.setting.deleteMany({ where: { key: CERTIFICATE_KEY } });
  await writeAudit({ action: "financeiro.certificado_removido", actorId: actor.id, entity: "Setting", entityId: CERTIFICATE_KEY });
}

export async function getCertificateInfo(now = new Date()): Promise<CertificateInfo | null> {
  const s = await getSetting<Stored | null>(CERTIFICATE_KEY, null);
  if (!s) return null;
  const notAfter = new Date(s.notAfter);
  return { subject: s.subject, cnpj: s.cnpj, issuer: s.issuer, notAfter, daysLeft: Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000), uploadedAt: new Date(s.uploadedAt) };
}

// Origem usada pela emissão: o certificado enviado pela tela; se não houver, o do .env.
export async function resolveCertificateSource(): Promise<CertificateSource & { origin: "tela" | "env" | "nenhum" }> {
  const s = await getSetting<Stored | null>(CERTIFICATE_KEY, null);
  if (s) return { base64: open(s.file).toString("base64"), password: open(s.password).toString("utf8"), origin: "tela" };
  const env = certificateSourceFromEnv();
  return { ...env, origin: env.path || env.base64 ? "env" : "nenhum" };
}
