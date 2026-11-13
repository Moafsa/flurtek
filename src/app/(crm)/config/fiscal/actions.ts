"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/session";
import { ServiceError } from "@/server/leads/rules";
import { saveFiscalConfig } from "@/server/finance/fiscal-config";
import { diagnoseSefaz, type SefazDiagnosis } from "@/server/finance/sefaz/diagnose";
import { removeCertificate, saveCertificate } from "@/server/finance/sefaz/certificate-store";
import { CryptoConfigError } from "@/server/crypto";

export type FiscalState = { ok?: boolean; error?: string };

export async function saveFiscalAction(_prev: FiscalState, fd: FormData): Promise<FiscalState> {
  const admin = await requirePermission("finance:admin");
  const text = (k: string) => String(fd.get(k) ?? "").trim();
  try {
    await saveFiscalConfig(admin, {
      regime: text("regime") || null,
      environment: text("environment"),
      series: text("series"),
      nextNumber: text("nextNumber"),
      cfopInState: text("cfopInState"),
      cfopOutState: text("cfopOutState"),
      taxCode: text("taxCode"),
      ncmWater: text("ncmWater").replace(/\D/g, ""),
      ncmFluid: text("ncmFluid").replace(/\D/g, ""),
      stateRegistration: text("stateRegistration"),
    });
  } catch (e) {
    if (e instanceof ServiceError) return { error: e.message };
    throw e;
  }
  revalidatePath("/config/fiscal");
  return { ok: true };
}

export type SefazState = { result?: SefazDiagnosis; error?: string };

export async function testSefazAction(): Promise<SefazState> {
  const admin = await requirePermission("finance:admin");
  try {
    return { result: await diagnoseSefaz(admin) };
  } catch (e) {
    if (e instanceof ServiceError) return { error: e.message };
    throw e;
  }
}

export type CertState = { ok?: boolean; error?: string };

export async function uploadCertificateAction(_prev: CertState, fd: FormData): Promise<CertState> {
  const admin = await requirePermission("finance:admin");
  const file = fd.get("certificate");
  const password = String(fd.get("password") ?? "");
  if (!(file instanceof File) || file.size === 0) return { error: "Escolha o arquivo do certificado (.pfx)." };
  if (file.size > 100 * 1024) return { error: "Arquivo grande demais para um certificado A1." };
  try {
    await saveCertificate(admin, Buffer.from(await file.arrayBuffer()), password);
  } catch (e) {
    if (e instanceof ServiceError || e instanceof CryptoConfigError) return { error: e.message };
    throw e;
  }
  revalidatePath("/config/fiscal");
  return { ok: true };
}

export async function removeCertificateAction(): Promise<void> {
  const admin = await requirePermission("finance:admin");
  await removeCertificate(admin);
  revalidatePath("/config/fiscal");
}
