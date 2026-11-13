// Certificado enviado pela tela do admin: criptografado no banco, nunca devolvido. Restaura o que existia.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import forge from "node-forge";
import { db } from "@/lib/db";
import { open, seal } from "@/server/crypto";
import { CERTIFICATE_KEY, getCertificateInfo, removeCertificate, resolveCertificateSource, saveCertificate } from "@/server/finance/sefaz/certificate-store";
import { diagnoseSefaz } from "@/server/finance/sefaz/diagnose";
import type { Transport } from "@/server/finance/sefaz/client";
import type { Actor } from "@/server/leads/rules";

const PASS = "Senha#Secreta-123";
let admin: Actor, comercial: Actor;
let backup: unknown = null;
let pfx: Buffer;

function makePfx(opts: { notAfter?: Date } = {}): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 300 * 86_400_000);
  cert.setSubject([{ name: "commonName", value: "FLURTEK TESTE LTDA:12345678000195" }]);
  cert.setIssuer([{ name: "commonName", value: "AC Teste" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASS, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

beforeAll(async () => {
  pfx = makePfx();
  backup = (await db.setting.findUnique({ where: { key: CERTIFICATE_KEY } }))?.value ?? null;
  const a = await db.user.findUniqueOrThrow({ where: { email: "admin@flurtek.local" } });
  const c = await db.user.findUniqueOrThrow({ where: { email: "comercial@flurtek.local" } });
  admin = { id: a.id, role: a.role, states: a.states };
  comercial = { id: c.id, role: c.role, states: c.states };
});
beforeEach(async () => {
  await db.setting.deleteMany({ where: { key: CERTIFICATE_KEY } });
});
afterAll(async () => {
  await db.setting.deleteMany({ where: { key: CERTIFICATE_KEY } });
  if (backup) await db.setting.create({ data: { key: CERTIFICATE_KEY, value: backup as never } });
});

describe("criptografia", () => {
  it("vai e volta, e cada envio usa um IV diferente", () => {
    const a = seal("segredo");
    const b = seal("segredo");
    expect(open(a).toString()).toBe("segredo");
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("dado adulterado ou chave trocada não abre", () => {
    const s = seal("segredo");
    const tampered = { ...s, data: Buffer.from("x".repeat(Buffer.from(s.data, "base64").length)).toString("base64") };
    expect(() => open(tampered)).toThrow(/Não foi possível abrir/);
    const old = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      expect(() => open(s)).toThrow(/Não foi possível abrir/);
    } finally {
      process.env.APP_ENCRYPTION_KEY = old;
    }
  });

  it("sem chave ou com chave do tamanho errado, avisa", () => {
    const old = process.env.APP_ENCRYPTION_KEY;
    try {
      delete process.env.APP_ENCRYPTION_KEY;
      expect(() => seal("x")).toThrow(/APP_ENCRYPTION_KEY/);
      process.env.APP_ENCRYPTION_KEY = "curta";
      expect(() => seal("x")).toThrow(/32 bytes/);
    } finally {
      process.env.APP_ENCRYPTION_KEY = old;
    }
  });
});

describe("envio pelo admin", () => {
  it("só o ADMIN envia ou remove", async () => {
    await expect(saveCertificate(comercial, pfx, PASS)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await expect(removeCertificate(comercial)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });

  it("recusa senha errada, arquivo vazio, arquivo inválido e certificado vencido", async () => {
    await expect(saveCertificate(admin, pfx, "errada")).rejects.toThrow(/Senha do certificado incorreta/);
    await expect(saveCertificate(admin, Buffer.alloc(0), PASS)).rejects.toThrow(/Escolha o arquivo/);
    await expect(saveCertificate(admin, Buffer.from("lixo"), PASS)).rejects.toThrow(/\.pfx/);
    await expect(saveCertificate(admin, pfx, "")).rejects.toThrow(/senha/i);
    await expect(saveCertificate(admin, makePfx({ notAfter: new Date(Date.now() - 86_400_000) }), PASS)).rejects.toThrow(/vencido/);
    expect(await getCertificateInfo()).toBeNull();
  });

  it("guarda criptografado: o banco não contém arquivo nem senha em claro", async () => {
    const info = await saveCertificate(admin, pfx, PASS);
    expect(info.cnpj).toBe("12345678000195");
    const raw = JSON.stringify((await db.setting.findUniqueOrThrow({ where: { key: CERTIFICATE_KEY } })).value);
    expect(raw).not.toContain(PASS);
    expect(raw).not.toContain(pfx.toString("base64"));
    expect(raw).not.toContain("PRIVATE KEY");
    const meta = await getCertificateInfo();
    expect(meta).toMatchObject({ subject: "FLURTEK TESTE LTDA:12345678000195", cnpj: "12345678000195" });
    expect(Object.keys(meta!)).not.toContain("password");
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "financeiro.certificado_enviado" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(log.meta)).not.toContain(PASS);
  });

  it("a emissão recebe o arquivo e a senha de volta, e o diagnóstico usa o certificado enviado", async () => {
    await saveCertificate(admin, pfx, PASS);
    const src = await resolveCertificateSource();
    expect(src.origin).toBe("tela");
    expect(src.password).toBe(PASS);
    expect(Buffer.from(src.base64!, "base64").equals(pfx)).toBe(true);
    const ok: Transport = async () => ({ status: 200, body: "<retConsStatServ><cStat>107</cStat><xMotivo>ok</xMotivo></retConsStatServ>" });
    const d = await diagnoseSefaz(admin, { transport: ok });
    expect(d.certificate).toMatchObject({ ok: true, cnpj: "12345678000195" });
    expect(d.service?.ok).toBe(true);
  });

  it("enviar outro substitui o atual; remover volta ao .env", async () => {
    await saveCertificate(admin, pfx, PASS);
    const second = await saveCertificate(admin, makePfx({ notAfter: new Date(Date.now() + 100 * 86_400_000) }), PASS);
    expect(second.daysLeft).toBeLessThanOrEqual(100);
    expect((await getCertificateInfo())!.daysLeft).toBeLessThanOrEqual(100);
    await removeCertificate(admin);
    expect(await getCertificateInfo()).toBeNull();
    const src = await resolveCertificateSource();
    expect(src.origin).not.toBe("tela");
  });

  it("se a chave de criptografia mudar, o diagnóstico explica em vez de quebrar", async () => {
    await saveCertificate(admin, pfx, PASS);
    const old = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    try {
      const d = await diagnoseSefaz(admin, {});
      expect(d.certificate.ok).toBe(false);
      expect(d.certificate.message).toMatch(/Envie o certificado de novo/);
    } finally {
      process.env.APP_ENCRYPTION_KEY = old;
    }
  });
});
