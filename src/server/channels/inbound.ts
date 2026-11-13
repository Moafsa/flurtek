// Leitor dos webhooks do ConextBot. O formato exato ainda não foi confirmado com a documentação,
// então aceita o formato estilo Meta (entry/changes/value) e um formato simples e plano.
// Tudo que chega é gravado bruto (WebhookEvent) para ajustarmos com um exemplo real.

export type InboundMessage = { id: string; from: string; name?: string; text: string; type: string; at: Date };
export type StatusUpdate = { id: string; status: "enviada" | "entregue" | "lida" | "falhou"; error?: string };
export type ParsedWebhook = { messages: InboundMessage[]; statuses: StatusUpdate[]; recognized: boolean };

const STATUS_MAP: Record<string, StatusUpdate["status"]> = {
  sent: "enviada",
  delivered: "entregue",
  read: "lida",
  failed: "falhou",
  enviada: "enviada",
  entregue: "entregue",
  lida: "lida",
  falhou: "falhou",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

function atFrom(ts: unknown): Date {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
  return new Date();
}

function fromMetaValue(value: Record<string, unknown>, out: ParsedWebhook) {
  const contacts = Array.isArray(value.contacts) ? value.contacts : [];
  const names = new Map<string, string>();
  for (const c of contacts) if (isObj(c) && str(c.wa_id) && isObj(c.profile) && str(c.profile.name)) names.set(str(c.wa_id)!, str(c.profile.name)!);

  for (const m of Array.isArray(value.messages) ? value.messages : []) {
    if (!isObj(m)) continue;
    const id = str(m.id), from = str(m.from);
    if (!id || !from) continue;
    const type = str(m.type) ?? "text";
    const text = type === "text" && isObj(m.text) ? (str(m.text.body) ?? "") : type === "button" && isObj(m.button) ? (str(m.button.text) ?? "") : `[${type}]`;
    out.messages.push({ id, from, name: names.get(from), text, type, at: atFrom(m.timestamp) });
    out.recognized = true;
  }
  for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
    if (!isObj(s)) continue;
    const id = str(s.id), status = STATUS_MAP[String(s.status ?? "").toLowerCase()];
    if (!id || !status) continue;
    const errs = Array.isArray(s.errors) && isObj(s.errors[0]) ? str(s.errors[0].message) ?? str(s.errors[0].title) : undefined;
    out.statuses.push({ id, status, error: errs });
    out.recognized = true;
  }
}

export function parseWebhook(payload: unknown): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [], recognized: false };
  if (!isObj(payload)) return out;

  // Estilo Meta: { entry: [{ changes: [{ value: { messages, statuses, contacts } }] }] }
  if (Array.isArray(payload.entry)) {
    for (const e of payload.entry) {
      if (!isObj(e)) continue;
      for (const ch of Array.isArray(e.changes) ? e.changes : []) if (isObj(ch) && isObj(ch.value)) fromMetaValue(ch.value, out);
    }
    return out;
  }
  // Meta sem "entry" (value direto) ou envelope { data: ... }
  if (isObj(payload.value)) fromMetaValue(payload.value, out);
  if (isObj(payload.data) && (Array.isArray(payload.data.messages) || Array.isArray(payload.data.statuses))) fromMetaValue(payload.data, out);
  if (Array.isArray(payload.messages) || Array.isArray(payload.statuses)) fromMetaValue(payload, out);
  if (out.recognized) return out;

  // Formato plano: { event: "message", id, from, text, name?, timestamp? } ou { event: "status", id, status }
  const ev = str(payload.event ?? payload.type)?.toLowerCase();
  const id = str(payload.id ?? payload.message_id), from = str(payload.from ?? payload.phone ?? payload.wa_id);
  if (ev && ["message", "message.received", "inbound", "mensagem"].includes(ev) && id && from) {
    const text = isObj(payload.text) ? str(payload.text.body) : str(payload.text ?? payload.body ?? payload.message);
    out.messages.push({ id, from, name: str(payload.name), text: text ?? "", type: "text", at: atFrom(payload.timestamp) });
    out.recognized = true;
  } else if (ev && ["status", "message.status"].includes(ev) && id) {
    const status = STATUS_MAP[String(payload.status ?? "").toLowerCase()];
    if (status) {
      out.statuses.push({ id, status, error: str(payload.error) });
      out.recognized = true;
    }
  }
  return out;
}
