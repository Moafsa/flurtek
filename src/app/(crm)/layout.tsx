import { signOut } from "@/auth";
import { db } from "@/lib/db";
import { requireUser } from "@/server/session";
import { can, ROLE_LABEL } from "@/server/rbac";
import { leadScope } from "@/server/leads/rules";
import { isAgentEnabled } from "@/server/settings";
import { NavLinks, type NavItem } from "./nav-links";
import { toggleAgentAction } from "./actions";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const canReviewAgent = can(user.role, "agent:review");

  const [openLeads, unread, pending, agentOn] = await Promise.all([
    can(user.role, "lead:read") ? db.lead.count({ where: { AND: [leadScope(user), { stage: { notIn: ["FECHADO", "PERDIDO", "FRIO"] } }] } }) : 0,
    can(user.role, "conversation:read")
      ? db.conversation.aggregate({
          _sum: { unread: true },
          where: { ...(user.role === "REPRESENTANTE" ? { lead: { uf: { in: user.states } } } : {}), ...(user.role === "ADMIN" ? {} : { kind: "CLIENTE" }) },
        })
      : null,
    canReviewAgent ? db.agentAction.count({ where: { status: "PENDENTE" } }) : 0,
    isAgentEnabled(),
  ]);

  const nav: NavItem[] = [
    { href: "/painel", label: "Painel" },
    ...(can(user.role, "lead:read") ? [{ href: "/funil", label: "Funil de vendas", badge: openLeads }] : []),
    ...(can(user.role, "conversation:read") ? [{ href: "/conversas", label: "Conversas", badge: unread?._sum.unread ?? 0 }] : []),
    ...(canReviewAgent ? [{ href: "/agente", label: "Agente IA", badge: pending }] : []),
    ...(can(user.role, "lead:read") ? [{ href: "/clientes", label: "Clientes e recompra" }] : []),
    ...(can(user.role, "finance:read") ? [{ href: "/financeiro", label: "Financeiro" }] : []),
    ...(can(user.role, "report:read") ? [{ href: "/relatorios", label: "Relatórios" }] : []),
    ...(can(user.role, "user:manage") ? [{ href: "/config/usuarios", label: "Usuários" }, { href: "/config/numeros", label: "Números autorizados" }] : []),
    ...(can(user.role, "finance:admin") ? [{ href: "/config/fiscal", label: "Configuração fiscal" }] : []),
    ...(can(user.role, "agent:configure") ? [{ href: "/config/ia", label: "Inteligência artificial" }] : []),
  ];

  const canToggle = can(user.role, "agent:configure");
  const pill = (
    <span className={`flex min-h-10 items-center gap-2.5 rounded-full border border-line bg-white px-3.5 text-sm font-semibold ${canToggle ? "hover:border-olive" : ""}`}>
      <i className={`size-2.5 rounded-full ${agentOn ? "bg-ok" : "bg-bad"}`} aria-hidden="true" />
      {agentOn ? "Agente IA ativo" : "Agente IA pausado"}
    </span>
  );

  return (
    <div className="grid min-h-screen md:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-screen flex-col gap-1 overflow-y-auto bg-graphite p-4 text-[#e6e6e6] md:flex">
        <div className="px-2 pb-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-flurtek.png" alt="Flurtek" width={130} height={24} className="h-7 w-auto" />
          <p className="mt-2 font-display text-[10px] font-semibold uppercase tracking-[0.2em] text-[#a8a8a8]">CRM + Agente IA</p>
        </div>
        <NavLinks items={nav} variant="side" />
        <div className="mt-auto border-t border-graphite-600 pt-4 text-sm">
          <p className="font-semibold text-white">{user.name}</p>
          <p className="text-[#a8a8a8]">{ROLE_LABEL[user.role]}</p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
          >
            <button type="submit" className="mt-3 min-h-10 rounded-lg border border-graphite-600 px-3 text-white hover:bg-graphite-800">
              Sair
            </button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col pb-20 md:pb-0">
        <header className="flex flex-wrap items-center gap-3 border-b border-line bg-card px-5 py-3 md:px-8">
          <p className="mr-auto font-display text-sm font-semibold text-muted md:hidden">Flurtek CRM</p>
          {process.env.NODE_ENV !== "production" ? (
            <span className="rounded-full border border-warn/40 bg-warn-bg px-3 py-1.5 font-display text-xs font-semibold text-warn">Dados de exemplo</span>
          ) : null}
          <form action="/funil" method="get" role="search" className="relative ml-auto min-w-40 flex-[0_1_320px]">
            <input
              name="q"
              type="search"
              placeholder="Buscar empresa, produto ou cidade"
              aria-label="Buscar leads"
              className="min-h-10 w-full rounded-full border border-line bg-paper px-4 text-sm"
            />
          </form>
          {canToggle ? (
            <form action={toggleAgentAction}>
              <button type="submit" aria-label={agentOn ? "Pausar o agente" : "Retomar o agente"} title={agentOn ? "Clique para pausar o agente" : "Clique para retomar o agente"}>
                {pill}
              </button>
            </form>
          ) : (
            pill
          )}
        </header>
        <div className="min-w-0 px-5 py-6 md:px-8">{children}</div>
      </div>
      <NavLinks items={nav} variant="bottom" />
    </div>
  );
}
