// Teste de conexão com a SEFAZ: confere o certificado e consulta o status do serviço. Não emite nada.
import { writeAudit } from "@/server/audit";
import { can } from "@/server/rbac";
import { ServiceError, type Actor } from "@/server/leads/rules";
import { getFiscalConfig } from "@/server/finance/fiscal-config";
import { CertificateError, loadCertificate, type CertificateSource } from "@/server/finance/sefaz/certificate";
import { resolveCertificateSource } from "@/server/finance/sefaz/certificate-store";
import { CryptoConfigError } from "@/server/crypto";
import { consultaStatus, SefazError, type SefazEnvironment, type Transport } from "@/server/finance/sefaz/client";

export type SefazDiagnosis = {
  environment: SefazEnvironment;
  certificate: { ok: boolean; message: string; subject?: string; cnpj?: string | null; notAfter?: string; daysLeft?: number };
  service: { ok: boolean; message: string; cStat?: string; averageMs?: number | null } | null;
};

export async function diagnoseSefaz(actor: Actor, deps: { source?: CertificateSource; transport?: Transport; now?: Date } = {}): Promise<SefazDiagnosis> {
  if (!can(actor.role, "finance:admin")) throw new ServiceError("SEM_PERMISSAO", "Seu papel não tem permissão para esta ação.");
  const { environment } = await getFiscalConfig();
  const out: SefazDiagnosis = { environment, certificate: { ok: false, message: "" }, service: null };

  try {
    const cert = await loadCertificate(deps.source ?? (await resolveCertificateSource()), deps.now);
    const soon = cert.daysLeft <= 30;
    out.certificate = {
      ok: true,
      message: soon ? `Certificado válido, mas vence em ${cert.daysLeft} dia(s). Renove com antecedência.` : "Certificado válido.",
      subject: cert.subject,
      cnpj: cert.cnpj,
      notAfter: cert.notAfter.toISOString(),
      daysLeft: cert.daysLeft,
    };
    try {
      const s = await consultaStatus(cert, environment, deps.transport);
      out.service = { ok: s.operating, message: `${s.cStat} · ${s.motivo}`, cStat: s.cStat, averageMs: s.averageMs };
    } catch (e) {
      out.service = { ok: false, message: e instanceof SefazError ? e.message : "Falha inesperada ao consultar a SEFAZ." };
    }
  } catch (e) {
    out.certificate = { ok: false, message: e instanceof CertificateError || e instanceof CryptoConfigError ? e.message : "Falha inesperada ao ler o certificado." };
  }

  // Auditoria sem segredos: só o resultado.
  await writeAudit({ action: "financeiro.sefaz_diagnostico", actorId: actor.id, meta: { ambiente: environment, certificado: out.certificate.ok, servico: out.service?.ok ?? null, cStat: out.service?.cStat ?? null } });
  return out;
}
