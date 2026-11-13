export type OutboundText = { to: string; body: string };
export type SendResult = { externalId: string };

export class ChannelError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface ChannelAdapter {
  readonly name: string;
  sendText(msg: OutboundText): Promise<SendResult>;
}

// Janela de atendimento do WhatsApp: resposta livre só até 24 h depois da última mensagem do cliente.
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export function insideWindow(lastInboundAt: Date | null | undefined, now = new Date()): boolean {
  return Boolean(lastInboundAt) && now.getTime() - lastInboundAt!.getTime() < WINDOW_MS;
}

const STOP_WORDS = new Set(["sair", "parar", "pare", "stop", "cancelar", "descadastrar", "remover", "nao quero mais"]);

export function isOptOut(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .trim();
  return STOP_WORDS.has(t);
}
