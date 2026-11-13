// Certificado digital A1 (.pfx) da empresa. O arquivo e a senha ficam só no servidor (variáveis de ambiente).
// A chave privada é extraída em memória para a conexão TLS e para a assinatura; nunca é gravada nem exibida.
import { readFile } from "node:fs/promises";
import forge from "node-forge";

export type LoadedCertificate = {
  keyPem: string;
  certPem: string;
  subject: string; // CN do titular, ex.: "FLURTEK LTDA:12345678000195"
  cnpj: string | null;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  daysLeft: number;
};

export class CertificateError extends Error {}

export type CertificateSource = { path?: string; base64?: string; password?: string };

export function certificateSourceFromEnv(env: NodeJS.ProcessEnv = process.env): CertificateSource {
  return { path: env.SEFAZ_CERT_PATH || undefined, base64: env.SEFAZ_CERT_BASE64 || undefined, password: env.SEFAZ_CERT_PASSWORD };
}

const attr = (list: forge.pki.CertificateField[], name: string) => (list.find((a) => a.shortName === name || a.name === name)?.value as string | undefined) ?? "";

export function parseCertificate(pfx: Buffer, password: string, now = new Date()): LoadedCertificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pfx.toString("binary"))), false, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/password|mac/i.test(msg)) throw new CertificateError("Senha do certificado incorreta.");
    throw new CertificateError("Não foi possível ler o arquivo do certificado (precisa ser um .pfx do tipo A1).");
  }
  const keys = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => Boolean(c));
  const key = keys[0]?.key;
  if (!key || !certs.length) throw new CertificateError("O arquivo não contém chave privada e certificado (é preciso um A1 exportado com a chave).");
  // O certificado da empresa é o que casa com a chave privada; os demais são a cadeia.
  const mine = certs.find((c) => forge.pki.publicKeyToPem(c.publicKey) === forge.pki.publicKeyToPem(forge.pki.setRsaPublicKey((key as forge.pki.rsa.PrivateKey).n, (key as forge.pki.rsa.PrivateKey).e))) ?? certs[0]!;
  const cn = attr(mine.subject.attributes, "CN");
  const cnpj = cn.match(/(\d{14})\s*$/)?.[1] ?? null;
  return {
    keyPem: forge.pki.privateKeyToPem(key as forge.pki.PrivateKey),
    certPem: certs.map((c) => forge.pki.certificateToPem(c)).join(""),
    subject: cn,
    cnpj,
    issuer: attr(mine.issuer.attributes, "CN"),
    notBefore: mine.validity.notBefore,
    notAfter: mine.validity.notAfter,
    daysLeft: Math.floor((mine.validity.notAfter.getTime() - now.getTime()) / 86_400_000),
  };
}

export async function loadCertificate(source: CertificateSource = certificateSourceFromEnv(), now = new Date()): Promise<LoadedCertificate> {
  if (!source.password) throw new CertificateError("Defina SEFAZ_CERT_PASSWORD no .env.");
  let pfx: Buffer;
  if (source.base64) pfx = Buffer.from(source.base64, "base64");
  else if (source.path) {
    try {
      pfx = await readFile(source.path);
    } catch {
      throw new CertificateError(`Arquivo do certificado não encontrado em ${source.path}.`);
    }
  } else throw new CertificateError("Defina SEFAZ_CERT_PATH (ou SEFAZ_CERT_BASE64) no .env.");
  const cert = parseCertificate(pfx, source.password, now);
  if (cert.daysLeft < 0) throw new CertificateError(`Certificado vencido em ${cert.notAfter.toLocaleDateString("pt-BR")}.`);
  return cert;
}
