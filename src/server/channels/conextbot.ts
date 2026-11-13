// Envio pelo ConextBot (API oficial da Meta): POST {base}/api/v1/messages com Bearer cxk_…
// Formato visto no portal: { to, type: "text", text: { body } }.
import { ChannelError, type ChannelAdapter, type OutboundText, type SendResult } from "@/server/channels/types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ConextBotAdapter implements ChannelAdapter {
  readonly name = "conextbot";
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  async sendText({ to, body }: OutboundText): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/api/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ to, type: "text", text: { body } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ChannelError("Sem resposta do ConextBot (rede ou tempo esgotado).", true);
    }

    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* resposta sem JSON */
    }
    if (!res.ok) {
      const detail = typeof json.error === "string" ? json.error : typeof json.message === "string" ? json.message : `HTTP ${res.status}`;
      // 401/403: chave inválida. 429/5xx: pode tentar de novo. 4xx: erro do pedido, não repete.
      throw new ChannelError(`ConextBot recusou o envio: ${detail}`.slice(0, 300), res.status === 429 || res.status >= 500);
    }
    return { externalId: pickMessageId(json) ?? `conextbot-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` };
  }
}

// O formato exato da resposta ainda precisa de confirmação com a documentação do ConextBot.
// Aceita os formatos mais comuns (estilo Meta e estilo simples).
export function pickMessageId(json: Record<string, unknown>): string | null {
  const messages = json.messages as { id?: unknown }[] | undefined;
  if (Array.isArray(messages) && typeof messages[0]?.id === "string") return messages[0].id;
  for (const k of ["message_id", "messageId", "id"]) if (typeof json[k] === "string") return json[k] as string;
  const data = json.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") return pickMessageId(data);
  return null;
}
