// Configuração da IA pelo painel do admin: chave criptografada, teste de conexão e troca do cérebro sem reiniciar.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { AI_CONFIG_KEY, getAiConfig, hintOf, removeAiKey, resolveAiEnv, saveAiConfig, testAiConnection } from "@/server/agent/ai-config";
import { refreshLlm, resetLlmRuntimeForTests } from "@/server/agent/llm-runtime";
import { getBrain } from "@/server/agent/brain-select";
import { getOwnerBrain } from "@/server/owner/intents";
import type { Actor } from "@/server/leads/rules";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
let admin: Actor, comercial: Actor;
const saved = { key: process.env.OPENROUTER_API_KEY, provider: process.env.LLM_PROVIDER };

async function actor(email: string): Promise<Actor> {
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { id: u.id, role: u.role, states: u.states };
}

beforeAll(async () => {
  [admin, comercial] = await Promise.all([actor("admin@flurtek.local"), actor("comercial@flurtek.local")]);
});
beforeEach(async () => {
  await db.setting.deleteMany({ where: { key: AI_CONFIG_KEY } });
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LLM_PROVIDER;
  resetLlmRuntimeForTests();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await db.setting.deleteMany({ where: { key: AI_CONFIG_KEY } });
  if (saved.key !== undefined) process.env.OPENROUTER_API_KEY = saved.key;
  if (saved.provider !== undefined) process.env.LLM_PROVIDER = saved.provider;
});

const ok = (provider = "openrouter") => ({ provider, apiKey: KEY, model: "", ownerModel: "", dataCollection: "deny" });

describe("salvar a configuração", () => {
  it("só o ADMIN configura", async () => {
    await expect(saveAiConfig(comercial, ok())).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await expect(removeAiKey(comercial)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    await expect(testAiConnection(comercial)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });

  it("recusa chave que não parece do OpenRouter, modelo fora do formato e provedor inexistente", async () => {
    await expect(saveAiConfig(admin, { ...ok(), apiKey: "abc123" })).rejects.toThrow(/sk-or-/);
    await expect(saveAiConfig(admin, { ...ok(), apiKey: "sk-or-curta" })).rejects.toThrow(/sk-or-/);
    await expect(saveAiConfig(admin, { ...ok(), model: "modelo sem barra" })).rejects.toThrow(/Modelo do atendimento inválido/);
    await expect(saveAiConfig(admin, { ...ok(), ownerModel: "x/y z" })).rejects.toThrow(/Modelo do dono inválido/);
    await expect(saveAiConfig(admin, { ...ok("skynet") })).rejects.toThrow(/provedor/);
    expect(await db.setting.count({ where: { key: AI_CONFIG_KEY } })).toBe(0);
  });

  it("guarda a chave criptografada: nem o banco, nem a tela, nem a auditoria têm a chave em claro", async () => {
    await saveAiConfig(admin, { ...ok(), model: "google/gemini-2.5-pro" });
    const raw = JSON.stringify((await db.setting.findUniqueOrThrow({ where: { key: AI_CONFIG_KEY } })).value);
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain("0123456789abcdef");
    const view = await getAiConfig({});
    expect(JSON.stringify(view)).not.toContain("0123456789abcdef");
    expect(view).toMatchObject({ hasKey: true, keySource: "painel", keyHint: hintOf(KEY), model: "google/gemini-2.5-pro", provider: "openrouter" });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "agente.ia_configurada" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(log.meta)).not.toContain("0123456789abcdef");
    expect(log.meta).toMatchObject({ chaveNova: true, modelo: "google/gemini-2.5-pro" });
  });

  it("salvar de novo com o campo da chave em branco mantém a chave; remover apaga só a chave", async () => {
    await saveAiConfig(admin, ok());
    await saveAiConfig(admin, { ...ok(), apiKey: "", model: "anthropic/claude-sonnet-4.5" });
    expect((await resolveAiEnv({})).OPENROUTER_API_KEY).toBe(KEY);
    await removeAiKey(admin);
    const view = await getAiConfig({});
    expect(view).toMatchObject({ hasKey: false, keySource: "nenhuma", model: "anthropic/claude-sonnet-4.5" });
  });

  it("o painel vale acima do .env, e o .env continua como plano B", async () => {
    const env = { OPENROUTER_API_KEY: "sk-or-v1-doenvdoenvdoenvdoenvdoenv00", OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-instruct" };
    expect((await getAiConfig(env))).toMatchObject({ keySource: "env", hasKey: true });
    await saveAiConfig(admin, { ...ok(), model: "" });
    const eff = await resolveAiEnv(env);
    expect(eff.OPENROUTER_API_KEY).toBe(KEY);
    expect(eff.OPENROUTER_MODEL).toBe("meta-llama/llama-3.3-70b-instruct"); // painel sem modelo: mantém o do .env
    await saveAiConfig(admin, { ...ok(), model: "google/gemini-2.5-pro" });
    expect((await resolveAiEnv(env)).OPENROUTER_MODEL).toBe("google/gemini-2.5-pro");
  });
});

describe("teste de conexão", () => {
  const tool = (args: unknown) => ({ choices: [{ message: { tool_calls: [{ function: { name: "ping", arguments: JSON.stringify(args) } }] } }] });
  const stub = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("sem chave avisa que está no modo simulado", async () => {
    const r = await testAiConnection(admin, {});
    expect(r).toMatchObject({ ok: false, provider: "mock" });
    expect(r.message).toMatch(/simulado/);
  });

  it("chave e modelo funcionando", async () => {
    await saveAiConfig(admin, ok());
    stub(200, tool({ ok: true }));
    const r = await testAiConnection(admin, {});
    expect(r).toMatchObject({ ok: true, provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
    const sent = JSON.parse(String((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body));
    expect(JSON.stringify(sent)).not.toMatch(/cliente|lead/i); // nenhum dado de cliente vai no teste
    expect(((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it("modelo que não usa ferramentas é apontado; chave inválida mostra o erro sem vazar a chave", async () => {
    await saveAiConfig(admin, ok());
    stub(200, { choices: [{ message: { content: "oi" } }] });
    expect(await testAiConnection(admin, {})).toMatchObject({ ok: false, message: expect.stringMatching(/outro modelo/) });
    stub(401, { error: { message: `chave ${KEY} inválida` } });
    const r = await testAiConnection(admin, {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
    expect(r.message).not.toContain("0123456789abcdef");
  });
});

describe("o worker troca de cérebro sem reiniciar", () => {
  it("sem chave: regras; salvou a chave no painel: OpenRouter nos dois agentes; removeu: volta às regras", async () => {
    const first = await refreshLlm();
    expect(first.brain).toBe("regras");
    expect(getBrain().name).toBe("regras");
    expect((await refreshLlm()).changed).toBe(false); // nada mudou: não reconstrói

    await saveAiConfig(admin, { ...ok(), model: "google/gemini-2.5-pro", ownerModel: "google/gemini-2.5-flash" });
    const on = await refreshLlm();
    expect(on).toMatchObject({ changed: true, brain: "openrouter:google/gemini-2.5-pro" });
    expect(getBrain().name).toBe("openrouter:google/gemini-2.5-pro");
    expect(getOwnerBrain().name).toBe("openrouter:google/gemini-2.5-flash");
    expect((await refreshLlm()).changed).toBe(false);

    await removeAiKey(admin);
    expect((await refreshLlm()).brain).toBe("regras");
    expect(getBrain().name).toBe("regras");
  });

  it("'Desligada' no painel força o modo simulado mesmo com chave guardada", async () => {
    await saveAiConfig(admin, ok());
    await refreshLlm();
    expect(getBrain().name).toMatch(/^openrouter:/);
    await saveAiConfig(admin, { ...ok("mock"), apiKey: "" });
    expect((await refreshLlm()).brain).toBe("regras");
  });

  it("chave guardada que não abre (APP_ENCRYPTION_KEY mudou) não derruba o worker", async () => {
    await saveAiConfig(admin, ok());
    const old = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(refreshLlm()).resolves.toMatchObject({ brain: "regras" });
      const view = await getAiConfig({});
      expect(view.keyError).toMatch(/APP_ENCRYPTION_KEY/);
    } finally {
      process.env.APP_ENCRYPTION_KEY = old;
      err.mockRestore();
    }
  });
});
