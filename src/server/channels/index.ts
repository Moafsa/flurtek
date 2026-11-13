import { ConextBotAdapter } from "@/server/channels/conextbot";
import type { ChannelAdapter, OutboundText, SendResult } from "@/server/channels/types";

// Modo simulado: não chama ninguém, só devolve um id. Padrão no desenvolvimento.
export class MockAdapter implements ChannelAdapter {
  readonly name = "mock";
  sent: OutboundText[] = [];
  async sendText(msg: OutboundText): Promise<SendResult> {
    this.sent.push(msg);
    return { externalId: `mock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` };
  }
}

let cached: ChannelAdapter | null = null;

// Só envia de verdade com CHANNEL_MODE=live E chave configurada. Qualquer outra coisa é simulado.
export function getChannel(): ChannelAdapter {
  if (cached) return cached;
  const live = process.env.CHANNEL_MODE === "live" && process.env.CONEXTBOT_API_KEY;
  cached = live
    ? new ConextBotAdapter(process.env.CONEXTBOT_BASE_URL ?? "https://app.conext.click", process.env.CONEXTBOT_API_KEY!)
    : new MockAdapter();
  return cached;
}

export function resetChannelForTests() {
  cached = null;
}
