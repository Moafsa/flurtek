import type { Metadata } from "next";
import { dateTime } from "@/lib/format";
import { requirePermission } from "@/server/session";
import { fiscalStatus } from "@/server/finance/fiscal-config";
import { FiscalForm } from "./fiscal-form";
import { SefazTest } from "./sefaz-test";
import { CertificateCard } from "./certificate-card";
import { getCertificateInfo } from "@/server/finance/sefaz/certificate-store";

export const metadata: Metadata = { title: "Configuração fiscal" };
export const dynamic = "force-dynamic";

export default async function FiscalPage() {
  await requirePermission("finance:admin");
  const { config, missing, lastChange } = await fiscalStatus();
  const cert = await getCertificateInfo();
  const simulated = (process.env.FISCAL_MODE ?? "mock") === "mock";

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Configuração fiscal</h1>
      <p className="mb-4 mt-1 text-sm text-muted">Regime e códigos usados na nota fiscal. A emissão direta na SEFAZ depende de tudo estar preenchido e validado pelo contador.</p>

      <section className="mb-5 rounded-2xl border border-line bg-card p-4 text-sm" aria-label="Situação">
        <p>
          <b>Emissão:</b> {simulated ? "simulada (nenhuma nota real é emitida)" : "real"} · <b>Ambiente:</b> {config.environment === "PRODUCAO" ? "produção" : "homologação"}
        </p>
        {missing.length ? (
          <p className="mt-1 text-warn">Falta preencher: {missing.join(", ")}.</p>
        ) : (
          <p className="mt-1 text-ok">Configuração completa.</p>
        )}
        {lastChange ? <p className="mt-1 text-xs text-muted">Última alteração: {dateTime(lastChange.createdAt)}</p> : null}
      </section>

      <section className="rounded-2xl border border-line bg-card p-5" aria-label="Parâmetros fiscais">
        <FiscalForm config={config} />
      </section>

      <section className="mt-5 rounded-2xl border border-line bg-card p-5" aria-label="Certificado digital">
        <h2 className="mb-3 font-display text-base font-bold">Certificado digital A1</h2>
        <CertificateCard current={cert ? { subject: cert.subject, cnpj: cert.cnpj, notAfter: cert.notAfter.toISOString(), daysLeft: cert.daysLeft, uploadedAt: cert.uploadedAt.toISOString() } : null} />
      </section>

      <section className="mt-5 rounded-2xl border border-line bg-card p-5" aria-label="Conexão com a SEFAZ">
        <h2 className="mb-3 font-display text-base font-bold">Conexão com a SEFAZ</h2>
        <SefazTest />
      </section>
    </main>
  );
}
