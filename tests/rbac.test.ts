import { describe, expect, it } from "vitest";
import { can, isRole, permissionsOf, ROLES } from "@/server/rbac";

describe("rbac", () => {
  it("administrador pode tudo", () => {
    for (const p of permissionsOf("ADMIN")) expect(can("ADMIN", p)).toBe(true);
    expect(can("ADMIN", "user:manage")).toBe(true);
  });

  it("só o administrador gerencia usuários e a autonomia do agente", () => {
    for (const role of ROLES.filter((r) => r !== "ADMIN")) {
      expect(can(role, "user:manage")).toBe(false);
      expect(can(role, "agent:configure")).toBe(false);
    }
  });

  it("comercial move leads e revisa o agente, mas não gerencia usuários", () => {
    expect(can("COMERCIAL", "lead:move")).toBe(true);
    expect(can("COMERCIAL", "agent:review")).toBe(true);
    expect(can("COMERCIAL", "user:manage")).toBe(false);
  });

  it("representante só lê e anota; não move nem aprova", () => {
    expect(can("REPRESENTANTE", "lead:read")).toBe(true);
    expect(can("REPRESENTANTE", "lead:note")).toBe(true);
    expect(can("REPRESENTANTE", "lead:move")).toBe(false);
    expect(can("REPRESENTANTE", "agent:review")).toBe(false);
  });

  it("leitura não escreve nada", () => {
    expect(can("LEITURA", "lead:read")).toBe(true);
    for (const p of ["lead:write", "lead:move", "lead:note", "task:write", "conversation:write", "agent:review"] as const) {
      expect(can("LEITURA", p)).toBe(false);
    }
  });

  it("papel desconhecido ou ausente não tem permissão", () => {
    expect(can(undefined, "lead:read")).toBe(false);
    expect(can(null, "lead:read")).toBe(false);
    expect(can("SUPERUSER", "lead:read")).toBe(false);
    expect(isRole("ADMIN")).toBe(true);
    expect(isRole("admin")).toBe(false);
  });
});
