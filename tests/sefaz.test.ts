// Certificado A1 e consulta de status da SEFAZ (sem rede: transporte falso, certificado gerado no teste).
import { beforeAll, describe, expect, it } from "vitest";
import forge from "node-forge";
import { db } from "@/lib/db";
import { loadCertificate, parseCertificate } from "@/server/finance/sefaz/certificate";
import { consultaStatus, parseStatus, SefazError, statusEnvelope, statusUrl, type Transport } from "@/server/finance/sefaz/client";
import { diagnoseSefaz } from "@/server/finance/sefaz/diagnose";
import type { Actor } from "@/server/leads/rules";

const PASS = "senha-de-teste";
const CNPJ = "12345678000195";

function makePfx(opts: { password?: string; notAfter?: Date; cn?: string } = {}): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024); // pequeno: só para teste
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 200 * 86_400_000);
  const attrs = [{ name: "commonName", value: opts.cn ?? `FLURTEK TESTE LTDA:${CNPJ}` }];
  cert.setSubject(attrs);
  cert.setIssuer([{ name: "commonName", value: "AC Teste" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], opts.password ?? PASS, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

const OK_XML = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4"><retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><verAplic>RS20240101</verAplic><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><cUF>43</cUF><dhRecbto>2026-10-28T10:00:00-03:00</dhRecbto><tMed>1</tMed></retConsStatServ></nfeResultMsg></soap:Body></soap:Envelope>`;

let pfx: Buffer;
let admin: Actor, comercial: Actor;

beforeAll(async () => {
  pfx = makePfx();
  const a = await db.user.findUniqueOrThrow({ where: { email: "admin@flurtek.local" } });
  const c = await db.user.findUniqueOrThrow({ where: { email: "comercial@flurtek.local" } });
  admin = { id: a.id, role: a.role, states: a.states };
  comercial = { id: c.id, role: c.role, states: c.states };
});

describe("certificado A1", () => {
  it("lê o .pfx, extrai titular, CNPJ e validade", () => {
    const c = parseCertificate(pfx, PASS);
    expect(c.subject).toBe(`FLURTEK TESTE LTDA:${CNPJ}`);
    expect(c.cnpj).toBe(CNPJ);
    expect(c.issuer).toBe("AC Teste");
    expect(c.daysLeft).toBeGreaterThan(190);
    expect(c.keyPem).toContain("PRIVATE KEY");
    expect(c.certPem).toContain("BEGIN CERTIFICATE");
  });

  it("senha errada e arquivo inválido dão mensagens claras", () => {
    expect(() => parseCertificate(pfx, "errada")).toThrow(/Senha do certificado incorreta/);
    expect(() => parseCertificate(Buffer.from("lixo"), PASS)).toThrow(/\.pfx/);
  });

  it("certificado vencido é recusado e a senha ausente é avisada", async () => {
    const expired = makePfx({ notAfter: new Date(Date.now() - 2 * 86_400_000) });
    await expect(loadCertificate({ base64: expired.toString("base64"), password: PASS })).rejects.toThrow(/vencido/);
    await expect(loadCertificate({ base64: pfx.toString("base64") })).rejects.toThrow(/SEFAZ_CERT_PASSWORD/);
    await expect(loadCertificate({ password: PASS })).rejects.toThrow(/SEFAZ_CERT_PATH/);
    await expect(loadCertificate({ path: "/nao/existe.pfx", password: PASS })).rejects.toThrow(/não encontrado/);
    await expect(loadCertificate({ base64: pfx.toString("base64"), password: PASS })).resolves.toMatchObject({ cnpj: CNPJ });
  });
});

describe("consulta de status", () => {
  it("monta o envelope SOAP 1.2 do RS (cUF 43) com o ambiente certo", () => {
    expect(statusEnvelope("HOMOLOGACAO")).toContain("<tpAmb>2</tpAmb><cUF>43</cUF><xServ>STATUS</xServ>");
    expect(statusEnvelope("PRODUCAO")).toContain("<tpAmb>1</tpAmb>");
    expect(statusEnvelope("HOMOLOGACAO")).toContain("soap-envelope");
  });

  it("usa o endereço de homologação por padrão e aceita sobrescrever por variável", () => {
    expect(statusUrl("HOMOLOGACAO", {})).toContain("nfe-homologacao.sefazrs.rs.gov.br");
    expect(statusUrl("PRODUCAO", {})).toContain("nfe.sefazrs.rs.gov.br");
    expect(statusUrl("HOMOLOGACAO", { SEFAZ_STATUS_URL_HOMOLOGACAO: "https://outro/ws" })).toBe("https://outro/ws");
  });

  it("lê o retorno: 107 é serviço em operação", () => {
    expect(parseStatus(OK_XML)).toEqual({ cStat: "107", motivo: "Servico em Operacao", operating: true, receivedAt: "2026-10-28T10:00:00-03:00", averageMs: 1000 });
    expect(parseStatus(OK_XML.replace("107", "108").replace("Servico em Operacao", "Paralisado")).operating).toBe(false);
  });

  it("erro SOAP, HTTP diferente de 200 e falha de rede viram SefazError", async () => {
    const cert = parseCertificate(pfx, PASS);
    expect(() => parseStatus("<x>nada</x>")).toThrow(SefazError);
    expect(() => parseStatus("<Fault><Text>certificado invalido</Text></Fault>")).toThrow(/certificado invalido/);
    const http500: Transport = async () => ({ status: 500, body: "" });
    await expect(consultaStatus(cert, "HOMOLOGACAO", http500)).rejects.toThrow(/HTTP 500/);
    const down: Transport = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(consultaStatus(cert, "HOMOLOGACAO", down)).rejects.toThrow(/ECONNRESET/);
  });

  it("envia ao endereço e ao corpo esperados", async () => {
    const cert = parseCertificate(pfx, PASS);
    let seen: { url: string; body: string } | null = null;
    const t: Transport = async (url, body) => {
      seen = { url, body };
      return { status: 200, body: OK_XML };
    };
    const r = await consultaStatus(cert, "HOMOLOGACAO", t);
    expect(r.operating).toBe(true);
    expect(seen!.url).toContain("NfeStatusServico4.asmx");
    expect(seen!.body).toContain("consStatServ");
  });
});

describe("diagnóstico (tela fiscal)", () => {
  const okTransport: Transport = async () => ({ status: 200, body: OK_XML });

  it("só o ADMIN pode testar", async () => {
    await expect(diagnoseSefaz(comercial, { source: { base64: pfx.toString("base64"), password: PASS }, transport: okTransport })).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });

  it("certificado e serviço ok", async () => {
    const d = await diagnoseSefaz(admin, { source: { base64: pfx.toString("base64"), password: PASS }, transport: okTransport });
    expect(d.certificate).toMatchObject({ ok: true, cnpj: CNPJ });
    expect(d.service).toMatchObject({ ok: true, cStat: "107" });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "financeiro.sefaz_diagnostico" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(log.meta)).not.toContain(PASS);
  });

  it("sem certificado não chega a consultar a SEFAZ", async () => {
    let called = false;
    const d = await diagnoseSefaz(admin, { source: { password: PASS }, transport: async () => { called = true; return { status: 200, body: OK_XML }; } });
    expect(d.certificate.ok).toBe(false);
    expect(d.service).toBeNull();
    expect(called).toBe(false);
  });

  it("serviço fora do ar aparece como falha, com certificado ainda válido", async () => {
    const d = await diagnoseSefaz(admin, { source: { base64: pfx.toString("base64"), password: PASS }, transport: async () => ({ status: 503, body: "" }) });
    expect(d.certificate.ok).toBe(true);
    expect(d.service).toMatchObject({ ok: false });
    expect(d.service!.message).toMatch(/503/);
  });

  it("avisa quando o certificado vence em menos de 30 dias", async () => {
    const soon = makePfx({ notAfter: new Date(Date.now() + 10 * 86_400_000) });
    const d = await diagnoseSefaz(admin, { source: { base64: soon.toString("base64"), password: PASS }, transport: okTransport });
    expect(d.certificate.message).toMatch(/vence em/);
  });
});
