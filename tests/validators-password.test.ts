import { describe, expect, it } from "vitest";
import { createUserSchema, loginSchema } from "@/lib/validators";
import { hashPassword, verifyPassword } from "@/server/password";

describe("senhas", () => {
  it("gera hash argon2id e verifica", async () => {
    const h = await hashPassword("uma-senha-bem-longa-123");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "uma-senha-bem-longa-123")).toBe(true);
    expect(await verifyPassword(h, "outra-senha")).toBe(false);
  });

  it("hash inválido nunca valida", async () => {
    expect(await verifyPassword("não-é-um-hash", "x")).toBe(false);
  });
});

describe("validação de entrada", () => {
  it("login normaliza o e-mail", () => {
    const r = loginSchema.parse({ email: "  ANA@Flurtek.Local ", password: "x" });
    expect(r.email).toBe("ana@flurtek.local");
  });

  it("rejeita e-mail inválido", () => {
    expect(loginSchema.safeParse({ email: "sem-arroba", password: "x" }).success).toBe(false);
  });

  it("senha provisória precisa de 12 caracteres", () => {
    const base = { name: "Fulano", email: "f@flurtek.local", role: "COMERCIAL", states: [] };
    expect(createUserSchema.safeParse({ ...base, password: "curta" }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, password: "uma-senha-ok-123" }).success).toBe(true);
  });

  it("representante exige ao menos um estado", () => {
    const base = { name: "Rep", email: "r@flurtek.local", role: "REPRESENTANTE", password: "uma-senha-ok-123" };
    expect(createUserSchema.safeParse({ ...base, states: [] }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, states: ["SC"] }).success).toBe(true);
  });

  it("não aceita papel nem UF inventados", () => {
    const base = { name: "X Y", email: "x@flurtek.local", password: "uma-senha-ok-123" };
    expect(createUserSchema.safeParse({ ...base, role: "ROOT", states: [] }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, role: "REPRESENTANTE", states: ["XX"] }).success).toBe(false);
  });
});
