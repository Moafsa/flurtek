// Cliente do OpenRouter (API compatível com OpenAI). Traduz a chamada de "ferramenta" que os cérebros já fazem
// (formato Anthropic) para chat/completions com tool calling e devolve no mesmo formato, então o agente de
// atendimento e o agente do dono funcionam por ele sem mudar nenhuma regra ou trava.
export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

type AnthropicTool = { name: string; description?: string; input_schema: Record<string, unknown> };
type CreateParams = {
  model: string;
  max_tokens?: number;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "tool"; name: string };
};
type ChatResponse = {
  error?: { message?: string; code?: number | string };
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
};

export type OpenRouterOptions = {
  apiKey: string;
  baseUrl?: string;
  referer?: string;
  title?: string;
  // "deny" pede ao OpenRouter para só usar provedores que não guardam nem treinam com os dados da conversa.
  dataCollection?: "allow" | "deny";
  fetcher?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

// Modelos que não obedecem "tool_choice" às vezes respondem JSON puro no texto: aceitamos como plano B.
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

export class OpenRouterClient {
  private o: Required<Omit<OpenRouterOptions, "fetcher" | "sleep">> & { fetcher: typeof fetch; sleep: (ms: number) => Promise<void> };

  constructor(opts: OpenRouterOptions) {
    this.o = {
      baseUrl: "https://openrouter.ai/api/v1",
      referer: "https://flurtek.com.br",
      title: "Flurtek CRM",
      dataCollection: "deny",
      timeoutMs: 40_000,
      fetcher: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  // Mesma assinatura que os cérebros usam (client.messages.create).
  messages = {
    create: async (p: CreateParams): Promise<{ content: { type: string; input?: unknown }[] }> => {
      const tool = p.tools?.[0];
      const body: Record<string, unknown> = {
        model: p.model,
        max_tokens: p.max_tokens ?? 1000,
        temperature: 0.2,
        messages: [...(p.system ? [{ role: "system", content: p.system }] : []), ...p.messages],
        // Só roteia para provedores que suportam todos os parâmetros pedidos (tools, tool_choice).
        provider: { require_parameters: true, data_collection: this.o.dataCollection },
      };
      if (tool) {
        const { $schema: _ignored, ...schema } = tool.input_schema as Record<string, unknown>;
        void _ignored;
        body.tools = [{ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: schema } }];
        if (p.tool_choice) body.tool_choice = { type: "function", function: { name: p.tool_choice.name } };
      }

      const res = await this.post(body);
      const msg = res.choices?.[0]?.message;
      const call = msg?.tool_calls?.find((c) => c.function?.arguments);
      if (call?.function?.arguments) {
        try {
          return { content: [{ type: "tool_use", input: JSON.parse(call.function.arguments) }] };
        } catch {
          throw new OpenRouterError("O modelo devolveu argumentos que não são JSON válido.");
        }
      }
      const fallback = typeof msg?.content === "string" ? extractJson(msg.content) : undefined;
      if (fallback !== undefined) return { content: [{ type: "tool_use", input: fallback }] };
      return { content: [] };
    },
  };

  private async post(body: Record<string, unknown>): Promise<ChatResponse> {
    let last: OpenRouterError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await this.o.sleep(800);
      let res: Response;
      try {
        res = await this.o.fetcher(`${this.o.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}`, "HTTP-Referer": this.o.referer, "X-Title": this.o.title },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (e) {
        last = new OpenRouterError(`Sem resposta do OpenRouter (${e instanceof Error ? e.message : "rede"}).`);
        continue;
      }
      const text = await res.text();
      let json: ChatResponse = {};
      try {
        json = text ? (JSON.parse(text) as ChatResponse) : {};
      } catch {
        /* corpo não era JSON */
      }
      if (res.ok && !json.error) return json;
      const reason = json.error?.message ?? text.slice(0, 160);
      last = new OpenRouterError(`OpenRouter ${res.status}: ${String(reason).replace(/sk-or-[\w-]+/g, "[chave]").slice(0, 200)}`, res.status);
      if (!RETRYABLE.has(res.status)) break;
    }
    throw last ?? new OpenRouterError("Falha desconhecida no OpenRouter.");
  }
}
