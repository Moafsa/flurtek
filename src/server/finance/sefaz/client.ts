// Cliente SOAP da SEFAZ (NF-e 4.00). Por enquanto: consulta de status do serviço, que não emite nada.
import https from "node:https";
import type { LoadedCertificate } from "@/server/finance/sefaz/certificate";

export type SefazEnvironment = "HOMOLOGACAO" | "PRODUCAO";

// RS usa o próprio ambiente. Podem ser trocados por variável se a SEFAZ mudar o endereço.
const STATUS_URL: Record<SefazEnvironment, string> = {
  HOMOLOGACAO: "https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
  PRODUCAO: "https://nfe.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
};
const NS = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4";
const ACTION = `${NS}/nfeStatusServicoNF`;
const UF_CODE_RS = "43";

export function statusUrl(env: SefazEnvironment, overrides: Record<string, string | undefined> = process.env): string {
  return (env === "PRODUCAO" ? overrides.SEFAZ_STATUS_URL_PRODUCAO : overrides.SEFAZ_STATUS_URL_HOMOLOGACAO) || STATUS_URL[env];
}

export function statusEnvelope(env: SefazEnvironment): string {
  const tpAmb = env === "PRODUCAO" ? 1 : 2;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
    `<nfeDadosMsg xmlns="${NS}"><consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
    `<tpAmb>${tpAmb}</tpAmb><cUF>${UF_CODE_RS}</cUF><xServ>STATUS</xServ></consStatServ></nfeDadosMsg>` +
    `</soap12:Body></soap12:Envelope>`
  );
}

export type SefazStatus = { cStat: string; motivo: string; operating: boolean; receivedAt: string | null; averageMs: number | null };

const tag = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`))?.[1]?.trim() ?? null;

export function parseStatus(xml: string): SefazStatus {
  const cStat = tag(xml, "cStat");
  if (!cStat) {
    const fault = tag(xml, "Text") ?? tag(xml, "faultstring");
    throw new SefazError(fault ? `A SEFAZ respondeu com erro: ${fault.slice(0, 200)}` : "Resposta da SEFAZ em formato inesperado.");
  }
  const tMed = tag(xml, "tMed");
  return { cStat, motivo: tag(xml, "xMotivo") ?? "", operating: cStat === "107", receivedAt: tag(xml, "dhRecbto"), averageMs: tMed ? Number(tMed) * 1000 : null };
}

export class SefazError extends Error {}

export type Transport = (url: string, body: string, cert: LoadedCertificate) => Promise<{ status: number; body: string }>;

// Conexão TLS com o certificado do cliente (mTLS). A cadeia de certificados da SEFAZ vem do repositório do sistema.
export const httpsTransport: Transport = (url, body, cert) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { host: u.hostname, port: u.port || 443, path: u.pathname, method: "POST", key: cert.keyPem, cert: cert.certPem, timeout: 15_000, headers: { "content-type": `application/soap+xml; charset=utf-8; action="${ACTION}"`, "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("tempo esgotado")));
    req.on("error", reject);
    req.end(body);
  });

export async function consultaStatus(cert: LoadedCertificate, env: SefazEnvironment, transport: Transport = httpsTransport): Promise<SefazStatus> {
  let res;
  try {
    res = await transport(statusUrl(env), statusEnvelope(env), cert);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro de rede";
    throw new SefazError(`Não foi possível falar com a SEFAZ (${msg}).`);
  }
  if (res.status !== 200) throw new SefazError(`A SEFAZ respondeu HTTP ${res.status}.`);
  return parseStatus(res.body);
}
