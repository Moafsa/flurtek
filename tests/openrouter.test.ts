// OpenRouter como cérebro do agente. Sem rede: o fetch é falso e nenhuma chave real é usada.
import { describe, expect, it } from "vitest";
import { OpenRouterClient, OpenRouterError } from "@/server/agent/openrouter";
import { llmFromEnv, providerFromEnv, DEFAULT_OPENROUTER_MODEL, DEFAULT_OPENROUTER_OWNER_MODEL } from "@/server/agent/llm";
import { ClaudeBrain, BrainError } from "@/server/agent/claude-brain";
import { ClaudeOwnerBrain } from "@/server/owner/intents";
import type { BrainContext } from "@/server/agent/brain";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(responses: { status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const toolCall = (args: unknown) => ({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "registrar_decisao", arguments: JSON.stringify(args) } }] } }] });
const noSleep = async () => {};

const DECISION = {
  intent: "duvida_tecnica",
  classification: { stage: "QUALIFICADO", temperature: "MORNO", score: 60, product: "Água desmineralizada", volume: "20L", uf: "RS", city: "Caxias do Sul", segment: null, nextAction: "Responder" },
  reply: { kind: "duvida_tecnica", text: "A água é isenta de sais minerais." },
  escalate: null,
  confidence: 88,
  knowledgeIds: [],
};

const ctx: BrainContext = {
  lead: { title: "Oficina Teste", stage: "NOVO", product: null, volume: null, uf: null, city: null, segment: null, isFirstContact: true },
  messages: [{ author: "CLIENTE", text: "Para que serve a água desmineralizada?" }],
  knowledge: [],
};

describe("cliente OpenRouter", () => {
  it("traduz a chamada para chat/completions com tool calling e devolve no formato dos cérebros", async () => {
    const { f, calls } = fakeFetch([{ body: toolCall({ ok: 1 }) }]);
    const c = new OpenRouterClient({ apiKey: "sk-or-teste", fetcher: f, sleep: noSleep });
    const res = await c.messages.create({
      model: "anthropic/claude-sonnet-4.5",
      max_tokens: 500,
      system: "SISTEMA",
      messages: [{ role: "user", content: "oi" }],
      tools: [{ name: "registrar_decisao", description: "d", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } } }],
      tool_choice: { type: "tool", name: "registrar_decisao" },
    });
    expect(res.content).toEqual([{ type: "tool_use", input: { ok: 1 } }]);
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-or-teste");
    expect(call.headers["X-Title"]).toBe("Flurtek CRM");
    expect(call.body.messages).toEqual([{ role: "system", content: "SISTEMA" }, { role: "user", content: "oi" }]);
    expect(call.body.tool_choice).toEqual({ type: "function", function: { name: "registrar_decisao" } });
    const tool = (call.body.tools as { function: { parameters: Record<string, unknown> } }[])[0]!;
    expect(tool.function.parameters.$schema).toBeUndefined();
    expect(call.body.provider).toEqual({ require_parameters: true, data_collection: "deny" });
  });

  it("aceita JSON no texto quando o modelo não usa a ferramenta", async () => {
    const { f } = fakeFetch([{ body: { choices: [{ message: { content: 'Claro:\n```json\n{"ok": 2}\n```' } }] } }]);
    const c = new OpenRouterClient({ apiKey: "k", fetcher: f, sleep: noSleep });
    const res = await c.messages.create({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(res.content[0]).toEqual({ type: "tool_use", input: { ok: 2 } });
  });

  it("sem ferramenta nem JSON, devolve vazio (o cérebro escala)", async () => {
    const { f } = fakeFetch([{ body: { choices: [{ message: { content: "não sei" } }] } }]);
    const res = await new OpenRouterClient({ apiKey: "k", fetcher: f, sleep: noSleep }).messages.create({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(res.content).toEqual([]);
  });

  it("tenta de novo em 429/5xx e para em erro definitivo, sem vazar a chave", async () => {
    const retry = fakeFetch([{ status: 429, body: { error: { message: "limite" } } }, { body: toolCall({ ok: 3 }) }]);
    const ok = await new OpenRouterClient({ apiKey: "k", fetcher: retry.f, sleep: noSleep }).messages.create({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(ok.content[0]).toMatchObject({ input: { ok: 3 } });
    expect(retry.calls).toHaveLength(2);

    const hard = fakeFetch([{ status: 401, body: { error: { message: "chave sk-or-v1-abc123 inválida" } } }]);
    const err = await new OpenRouterClient({ apiKey: "sk-or-v1-abc123", fetcher: hard.f, sleep: noSleep }).messages.create({ model: "m", messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain("abc123");
    expect(hard.calls).toHaveLength(1);
  });

  it("o corpo com erro dentro de um 200 também falha, e a coleta de dados pode ser liberada por configuração", async () => {
    const { f, calls } = fakeFetch([{ body: { error: { message: "No endpoints found that support tool use", code: 404 } } }]);
    const c = new OpenRouterClient({ apiKey: "k", fetcher: f, sleep: noSleep, dataCollection: "allow" });
    await expect(c.messages.create({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/No endpoints found/);
    expect((calls[0]!.body.provider as { data_collection: string }).data_collection).toBe("allow");
  });
});

describe("escolha do provedor", () => {
  it("auto: OpenRouter se houver chave; senão Anthropic; senão simulado", () => {
    expect(providerFromEnv({ OPENROUTER_API_KEY: "a", ANTHROPIC_API_KEY: "b" })).toBe("openrouter");
    expect(providerFromEnv({ ANTHROPIC_API_KEY: "b" })).toBe("anthropic");
    expect(providerFromEnv({})).toBe("mock");
    expect(providerFromEnv({ LLM_PROVIDER: "auto", OPENROUTER_API_KEY: "a" })).toBe("openrouter");
  });

  it("forçar um provedor sem a chave dele cai no simulado, e 'mock' desliga a IA", () => {
    expect(providerFromEnv({ LLM_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "b" })).toBe("mock");
    expect(providerFromEnv({ LLM_PROVIDER: "anthropic", OPENROUTER_API_KEY: "a" })).toBe("mock");
    expect(providerFromEnv({ LLM_PROVIDER: "mock", OPENROUTER_API_KEY: "a" })).toBe("mock");
    expect(providerFromEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "b", OPENROUTER_API_KEY: "a" })).toBe("anthropic");
  });

  it("modelos: padrão do sistema, sobrescrita por variável e um modelo menor para o dono", () => {
    expect(llmFromEnv("agent", { OPENROUTER_API_KEY: "a" })).toMatchObject({ model: DEFAULT_OPENROUTER_MODEL, label: "openrouter" });
    expect(llmFromEnv("owner", { OPENROUTER_API_KEY: "a" })).toMatchObject({ model: DEFAULT_OPENROUTER_OWNER_MODEL });
    expect(llmFromEnv("agent", { OPENROUTER_API_KEY: "a", OPENROUTER_MODEL: "google/gemini-2.5-pro" })).toMatchObject({ model: "google/gemini-2.5-pro" });
    expect(llmFromEnv("agent", { OPENROUTER_API_KEY: "a", OPENROUTER_MODEL: "" })!.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(llmFromEnv("agent", {})).toBeNull();
  });
});

describe("cérebros usando o OpenRouter", () => {
  it("o agente de atendimento decide pelo OpenRouter e o nome do cérebro mostra o provedor", async () => {
    const { f } = fakeFetch([{ body: toolCall(DECISION) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetcher: f, sleep: noSleep });
    const brain = new ClaudeBrain(client as never, "anthropic/claude-sonnet-4.5", "openrouter");
    expect(brain.name).toBe("openrouter:anthropic/claude-sonnet-4.5");
    const d = await brain.decide(ctx);
    expect(d.intent).toBe("duvida_tecnica");
    expect(d.reply?.text).toMatch(/sais minerais/);
  });

  it("decisão inválida ou falha do OpenRouter viram BrainError (o pipeline escala para uma pessoa)", async () => {
    const bad = fakeFetch([{ body: toolCall({ intent: "invencao" }) }]);
    const b1 = new ClaudeBrain(new OpenRouterClient({ apiKey: "k", fetcher: bad.f, sleep: noSleep }) as never, "m", "openrouter");
    await expect(b1.decide(ctx)).rejects.toBeInstanceOf(BrainError);
    const down = fakeFetch([{ status: 503, body: { error: { message: "fora do ar" } } }]);
    const b2 = new ClaudeBrain(new OpenRouterClient({ apiKey: "k", fetcher: down.f, sleep: noSleep }) as never, "m", "openrouter");
    await expect(b2.decide(ctx)).rejects.toThrow(/Falha ao chamar a IA/);
  });

  it("o agente do dono converte a frase em intenção pelo OpenRouter; se falhar, cai nas regras", async () => {
    const ok = fakeFetch([{ body: { choices: [{ message: { tool_calls: [{ function: { name: "registrar_intencao", arguments: JSON.stringify({ intent: "relatorio", period: "semana" }) } }] } }] } }]);
    const brain = new ClaudeOwnerBrain(new OpenRouterClient({ apiKey: "k", fetcher: ok.f, sleep: noSleep }) as never, "m", undefined, "openrouter");
    expect(brain.name).toBe("openrouter:m");
    expect(await brain.parse("como foi a semana?")).toEqual({ intent: "relatorio", period: "semana" });

    const down = fakeFetch([{ status: 500, body: { error: { message: "erro" } } }]);
    const fallback = new ClaudeOwnerBrain(new OpenRouterClient({ apiKey: "k", fetcher: down.f, sleep: noSleep }) as never, "m", undefined, "openrouter");
    expect(await fallback.parse("pendências")).toEqual({ intent: "pendencias" });
  });

  it("a ordem do dono nunca passa por texto livre: intenção fora do conjunto fechado é descartada", async () => {
    const evil = fakeFetch([{ body: { choices: [{ message: { tool_calls: [{ function: { name: "registrar_intencao", arguments: JSON.stringify({ intent: "apagar_tudo" }) } }] } }] } }]);
    const brain = new ClaudeOwnerBrain(new OpenRouterClient({ apiKey: "k", fetcher: evil.f, sleep: noSleep }) as never, "m", undefined, "openrouter");
    expect((await brain.parse("relatório")).intent).toBe("relatorio"); // volta para as regras, não executa o que o modelo inventou
  });
});
