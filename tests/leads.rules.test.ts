import { describe, expect, it } from "vitest";
import { inScope, isStage, leadScope, validateMove, type Actor } from "@/server/leads/rules";

const rep: Actor = { id: "r1", role: "REPRESENTANTE", states: ["SC", "PR"] };
const com: Actor = { id: "c1", role: "COMERCIAL", states: [] };

describe("escopo de leads", () => {
  it("representante só vê os estados dele", () => {
    expect(leadScope(rep)).toEqual({ uf: { in: ["SC", "PR"] } });
    expect(inScope(rep, { uf: "SC" })).toBe(true);
    expect(inScope(rep, { uf: "RS" })).toBe(false);
  });

  it("lead sem estado fica invisível para representante", () => {
    expect(inScope(rep, { uf: null })).toBe(false);
  });

  it("representante sem estados não vê nada", () => {
    const none: Actor = { id: "r2", role: "REPRESENTANTE", states: [] };
    expect(leadScope(none)).toEqual({ uf: { in: [] } });
    expect(inScope(none, { uf: "SC" })).toBe(false);
  });

  it("demais papéis veem tudo", () => {
    expect(leadScope(com)).toEqual({});
    expect(inScope(com, { uf: null })).toBe(true);
    expect(inScope({ ...com, role: "LEITURA" }, { uf: "RS" })).toBe(true);
  });
});

describe("regras de etapa", () => {
  it("perdido exige motivo", () => {
    expect(validateMove("PERDIDO", "")).not.toBeNull();
    expect(validateMove("PERDIDO", "  ab ")).not.toBeNull();
    expect(validateMove("PERDIDO", "Fechou com concorrente")).toBeNull();
  });

  it("outras etapas não exigem motivo", () => {
    for (const s of ["NOVO", "QUALIFICADO", "COTACAO", "NEGOCIACAO", "FECHADO", "FRIO"] as const) {
      expect(validateMove(s)).toBeNull();
    }
  });

  it("isStage reconhece só etapas válidas", () => {
    expect(isStage("NEGOCIACAO")).toBe(true);
    expect(isStage("negociacao")).toBe(false);
    expect(isStage(42)).toBe(false);
  });
});
