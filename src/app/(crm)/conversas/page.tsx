import type { Metadata } from "next";
import Link from "next/link";
import { ago, dateTime, initials } from "@/lib/format";
import { can } from "@/server/rbac";
import { requirePermission } from "@/server/session";
import { getConversation, listConversations, markRead } from "@/server/conversations/service";
import { ServiceError } from "@/server/leads/rules";
import { Composer, ModeButton } from "./composer";

export const metadata: Metadata = { title: "Conversas" };
export const dynamic = "force-dynamic";

const CHANNEL: Record<string, string> = { WHATSAPP: "WhatsApp", EMAIL: "E-mail", CHAT_SITE: "Chat do site", TELEFONE: "Telefone" };

export default async function ConversasPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await requirePermission("conversation:read");
  const { c } = await searchParams;
  const list = await listConversations(user);
  const selectedId = c && list.some((x) => x.id === c) ? c : list[0]?.id;

  let thread: Awaited<ReturnType<typeof getConversation>> | null = null;
  if (selectedId) {
    try {
      await markRead(user, selectedId);
      thread = await getConversation(user, selectedId);
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
    }
  }
  const canWrite = can(user.role, "conversation:write");

  return (
    <main>
      <h1 className="font-display text-2xl font-bold tracking-tight">Conversas</h1>
      <p className="mb-4 mt-1 text-sm text-muted">WhatsApp, e-mail e chat do site em um só lugar. Em cada conversa você escolhe quem responde: o agente ou a equipe.</p>

      <div className="grid min-h-[520px] overflow-hidden rounded-2xl border border-line bg-card lg:grid-cols-[320px_minmax(0,1fr)]">
        <ul className="max-h-[560px] overflow-y-auto border-b border-line lg:border-b-0 lg:border-r" aria-label="Conversas">
          {list.map((x) => {
            const name = x.lead?.title ?? "Visitante do site";
            const last = x.messages[0];
            return (
              <li key={x.id}>
                <Link href={`/conversas?c=${x.id}`} aria-current={x.id === selectedId ? "page" : undefined} className={`grid grid-cols-[40px_minmax(0,1fr)_auto] gap-3 border-b border-line p-3.5 hover:bg-soft ${x.id === selectedId ? "bg-soft" : ""}`}>
                  <span className="grid size-10 place-items-center rounded-full bg-graphite font-display text-xs font-bold text-lime">{initials(name)}</span>
                  <span className="min-w-0">
                    <b className="block truncate font-display text-[13px]">{name}</b>
                    <span className="block truncate text-xs text-muted">{last?.body ?? "Sem mensagens"}</span>
                  </span>
                  <span className="text-right text-[11px] text-muted">
                    {CHANNEL[x.channel]}
                    {x.unread ? <span className="mt-1 block rounded-full bg-graphite px-1.5 font-display font-bold text-lime">{x.unread}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
          {list.length === 0 ? <li className="p-6 text-sm text-muted">Nenhuma conversa ainda.</li> : null}
        </ul>

        {thread ? (
          <section className="flex min-w-0 flex-col" aria-label="Conversa">
            <header className="flex flex-wrap items-center gap-2.5 border-b border-line p-4">
              <b className="font-display text-[15px]">{thread.conv.lead?.title ?? "Visitante do site"}</b>
              <span className="rounded-full bg-soft px-2.5 py-0.5 font-display text-[11px] font-semibold">{CHANNEL[thread.conv.channel]}</span>
              <span className={`rounded-full px-2.5 py-0.5 font-display text-[11px] font-semibold ${thread.conv.mode === "AGENTE" ? "bg-graphite text-lime" : "bg-soft"}`}>
                {thread.conv.mode === "AGENTE" ? "Agente respondendo" : "Equipe atendendo"}
              </span>
              {thread.conv.lead ? (
                <Link href={`/leads/${thread.conv.lead.id}`} className="text-xs text-muted underline">
                  Abrir lead
                </Link>
              ) : null}
              <span className="ml-auto">{canWrite ? <ModeButton id={thread.conv.id} mode={thread.conv.mode} /> : null}</span>
            </header>
            <ol className="flex flex-1 flex-col gap-2.5 overflow-y-auto bg-paper p-4" style={{ maxHeight: 440 }}>
              {thread.messages.map((m) =>
                m.author === "SISTEMA" ? (
                  <li key={m.id} className="self-center rounded-full bg-soft px-3 py-1 text-xs text-muted">
                    {m.body}
                  </li>
                ) : (
                  <li key={m.id} className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm ${m.author === "CLIENTE" ? "self-start rounded-bl-sm border border-line bg-white" : m.author === "AGENTE" ? "self-end rounded-br-sm bg-lime text-on-lime" : "self-end rounded-br-sm bg-graphite text-[#f0f0f0]"}`}>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                    <small className="mt-1 block text-[11px] opacity-70">
                      {m.author === "CLIENTE" ? "Cliente" : m.author === "AGENTE" ? "Agente IA" : "Equipe"} · {ago(m.createdAt)}
                      {(m.meta as { entrega?: string } | null)?.entrega === "aguardando_canal" ? " · aguardando envio" : ""}
                    </small>
                    <span className="sr-only">{dateTime(m.createdAt)}</span>
                  </li>
                ),
              )}
            </ol>
            {canWrite ? <Composer id={thread.conv.id} /> : null}
          </section>
        ) : (
          <p className="grid place-items-center p-10 text-sm text-muted">Escolha uma conversa.</p>
        )}
      </div>
    </main>
  );
}
