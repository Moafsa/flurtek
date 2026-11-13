// Teste de fumaça de ponta a ponta do login e dos papéis. Roda DENTRO do contêiner do app:
//   docker compose exec -T app node scripts/smoke-auth.mjs
// Usa SEED_PASSWORD do ambiente (nunca é impresso).
import { PrismaClient } from "@prisma/client";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) throw new Error("SEED_PASSWORD ausente");

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "OK   " : "FALHA"} ${name}${extra ? ` (${extra})` : ""}`);
  if (!ok) failures++;
};

class Jar {
  map = new Map();
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(c) || v === "") this.map.delete(k);
      else this.map.set(k, v);
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function req(jar, path, init = {}) {
  const res = await fetch(BASE + path, { redirect: "manual", ...init, headers: { ...(init.headers ?? {}), cookie: jar.header() } });
  jar.absorb(res);
  return res;
}

async function login(email, password) {
  const jar = new Jar();
  const csrf = await (await req(jar, "/api/auth/csrf")).json();
  const body = new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: `${BASE}/painel` });
  await req(jar, "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const session = await (await req(jar, "/api/auth/session")).json();
  return { jar, user: session?.user ?? null };
}

const loc = (res) => res.headers.get("location") ?? "";

// 1. Sem sessão
{
  const jar = new Jar();
  const r = await req(jar, "/painel");
  check("/painel sem login redireciona para /login", [302, 303, 307, 308].includes(r.status) && loc(r).includes("/login"), `${r.status} ${loc(r)}`);
  const l = await req(jar, "/login");
  check("/login responde 200", l.status === 200);
  const h = await req(jar, "/api/health");
  check("/api/health é público", h.status === 200);
}

// 2. Senha errada
{
  const { user } = await login("admin@flurtek.local", "senha-errada-qualquer");
  check("senha errada não cria sessão", user === null);
  const { user: u2 } = await login("naoexiste@flurtek.local", "senha-errada-qualquer");
  check("e-mail inexistente não cria sessão", u2 === null);
}

// 3. Cada papel
const expectations = {
  "admin@flurtek.local": { role: "ADMIN", usuarios: 200 },
  "comercial@flurtek.local": { role: "COMERCIAL", usuarios: "negado" },
  "representante@flurtek.local": { role: "REPRESENTANTE", usuarios: "negado" },
  "leitura@flurtek.local": { role: "LEITURA", usuarios: "negado" },
};
for (const [email, exp] of Object.entries(expectations)) {
  const { jar, user } = await login(email, PASSWORD);
  check(`${exp.role}: login ok`, user?.role === exp.role, user ? user.role : "sem sessão");
  if (!user) continue;
  const p = await req(jar, "/painel");
  const html = await p.text();
  check(`${exp.role}: abre /painel`, p.status === 200 && html.includes("Painel"), String(p.status));
  const u = await req(jar, "/config/usuarios");
  if (exp.usuarios === 200) {
    const t = await u.text();
    check(`${exp.role}: abre /config/usuarios`, u.status === 200 && t.includes("Usuários e papéis"), String(u.status));
  } else {
    check(`${exp.role}: é barrado em /config/usuarios`, [302, 303, 307, 308].includes(u.status) && loc(u).includes("negado=1"), `${u.status} ${loc(u)}`);
  }
}

// 4. Bloqueio por tentativas (e limpeza)
{
  const db = new PrismaClient();
  for (let i = 0; i < 5; i++) await login("leitura@flurtek.local", "senha-errada-" + i);
  const { user } = await login("leitura@flurtek.local", PASSWORD);
  check("conta bloqueia após 5 falhas (senha certa também é negada)", user === null);
  const row = await db.user.findUnique({ where: { email: "leitura@flurtek.local" } });
  check("lockedUntil gravado no banco", Boolean(row?.lockedUntil && row.lockedUntil > new Date()));
  await db.user.update({ where: { email: "leitura@flurtek.local" }, data: { lockedUntil: null, failedLogins: 0 } });
  const { user: again } = await login("leitura@flurtek.local", PASSWORD);
  check("após desbloquear, o login volta a funcionar", again?.role === "LEITURA");
  const audits = await db.auditLog.count({ where: { action: { startsWith: "login." } } });
  check("tentativas ficaram no registro de auditoria", audits > 0, `${audits} registros`);
  await db.$disconnect();
}

// 5. Funil e lead 360 (páginas)
{
  const db = new PrismaClient();
  const rs = await db.lead.findFirstOrThrow({ where: { title: "Transportadora Serra Sul" } });
  const pr = await db.lead.findFirstOrThrow({ where: { title: "Frota Rodoviária Norte" } });
  await db.$disconnect();

  const com = await login("comercial@flurtek.local", PASSWORD);
  const f = await (await req(com.jar, "/funil")).text();
  check("COMERCIAL: funil mostra leads de todos os estados", f.includes("Transportadora Serra Sul") && f.includes("Frota Rodoviária Norte"));
  check("COMERCIAL: funil tem as 5 colunas", ["Novos leads", "Qualificados", "Cotação enviada", "Negociação", "Fechado"].every((c) => f.includes(c)));
  const l1 = await req(com.jar, `/leads/${rs.id}`);
  const h1 = await l1.text();
  check("COMERCIAL: abre o lead 360", l1.status === 200 && h1.includes("Linha do tempo") && h1.includes("Tarefas"), String(l1.status));
  const novo = await req(com.jar, "/leads/novo");
  check("COMERCIAL: abre /leads/novo", novo.status === 200);

  const rep = await login("representante@flurtek.local", PASSWORD);
  const fr = await (await req(rep.jar, "/funil")).text();
  check("REPRESENTANTE: funil só tem leads de SC e PR", fr.includes("Frota Rodoviária Norte") && !fr.includes("Transportadora Serra Sul") && !fr.includes("Laser Corte Sul"));
  check("REPRESENTANTE: não vê o botão de novo lead", !fr.includes("+ Novo lead"));
  const own = await req(rep.jar, `/leads/${pr.id}`);
  check("REPRESENTANTE: abre lead do seu estado", own.status === 200, String(own.status));
  const other = await req(rep.jar, `/leads/${rs.id}`);
  check("REPRESENTANTE: lead de outro estado dá 404", other.status === 404, String(other.status));
  const rn = await req(rep.jar, "/leads/novo");
  check("REPRESENTANTE: é barrado em /leads/novo", [302, 303, 307, 308].includes(rn.status) && loc(rn).includes("negado=1"), `${rn.status}`);

  const lei = await login("leitura@flurtek.local", PASSWORD);
  const fl = await (await req(lei.jar, "/funil")).text();
  check("LEITURA: vê o funil mas sem botão de novo lead", fl.includes("Funil de vendas") && !fl.includes("+ Novo lead"));
  const ll = await (await req(lei.jar, `/leads/${rs.id}`)).text();
  check("LEITURA: lead 360 sem formulários de escrita", !ll.includes("Adicionar nota") && !ll.includes("Salvar dados"));

  const anon = new Jar();
  const a = await req(anon, `/leads/${rs.id}`);
  check("sem login, lead 360 redireciona para /login", [302, 303, 307, 308].includes(a.status) && loc(a).includes("/login"));
}

// 6. Conversas, agente e clientes (páginas)
{
  const adm = await login("admin@flurtek.local", PASSWORD);
  const com = await login("comercial@flurtek.local", PASSWORD);
  const rep = await login("representante@flurtek.local", PASSWORD);
  const lei = await login("leitura@flurtek.local", PASSWORD);
  const get = async (j, path) => { const r = await req(j.jar, path); return { r, t: r.status === 200 ? await r.text() : "" }; };
  const denied = (r) => [302, 303, 307, 308].includes(r.status) && loc(r).includes("negado=1");

  let x = await get(com, "/painel");
  check("COMERCIAL: painel tem atenção e atividade do agente", x.t.includes("Precisa da sua atenção") && x.t.includes("Atividade do agente") && x.t.includes("Fechado no mês"));
  check("COMERCIAL: menu completo (Conversas, Agente IA, Clientes)", ["Conversas", "Agente IA", "Clientes e recompra"].every((n) => x.t.includes(n)));
  x = await get(com, "/conversas");
  check("COMERCIAL: abre /conversas com mensagens", x.r.status === 200 && x.t.includes("Oficina Bom Pistão") && x.t.includes("Assumir conversa") || x.t.includes("Devolver ao agente"));
  x = await get(com, "/agente");
  check("COMERCIAL: fila de aprovações do agente", x.r.status === 200 && x.t.includes("Aprovar") && x.t.includes("Rejeitar"));
  x = await get(com, "/agente?aba=autonomia");
  check("COMERCIAL: vê a autonomia mas não edita", x.r.status === 200 && x.t.includes("O que o agente pode fazer sozinho") && x.t.includes("Só o administrador altera"));
  x = await get(adm, "/agente?aba=autonomia");
  check("ADMIN: autonomia editável", x.r.status === 200 && !x.t.includes("Só o administrador altera"));
  x = await get(adm, "/agente?aba=registro");
  check("ADMIN: registro do agente", x.r.status === 200 && x.t.includes("Registro do agente"));
  x = await get(com, "/clientes");
  check("COMERCIAL: clientes e recompra", x.r.status === 200 && x.t.includes("Próxima reposição") && x.t.includes("Clínica Bella Estética"));

  x = await get(adm, "/config/numeros");
  check("ADMIN: abre números autorizados do dono", x.r.status === 200 && x.t.includes("Números autorizados") && x.t.includes("Cadastrar número"), String(x.r.status));
  x = await get(com, "/config/numeros");
  check("COMERCIAL: é barrado em /config/numeros", denied(x.r), String(x.r.status));
  x = await get(com, "/relatorios");
  check("COMERCIAL: abre /relatorios", x.r.status === 200, String(x.r.status));

  x = await get(com, "/financeiro");
  check("COMERCIAL: abre /financeiro", x.r.status === 200 && x.t.includes("A receber") && x.t.includes("Novo pedido"), String(x.r.status));
  x = await get(lei, "/financeiro");
  check("LEITURA: é barrada em /financeiro", denied(x.r), String(x.r.status));
  x = await get(rep, "/financeiro");
  check("REPRESENTANTE: é barrado em /financeiro", denied(x.r), String(x.r.status));
  x = await get(adm, "/config/fiscal");
  check("ADMIN: abre a configuração fiscal com o regime selecionável", x.r.status === 200 && x.t.includes("Regime tributário") && x.t.includes("Simples Nacional") && x.t.includes("Lucro Presumido"), String(x.r.status));
  x = await get(com, "/config/fiscal");
  check("COMERCIAL: é barrado em /config/fiscal", denied(x.r), String(x.r.status));
  x = await get(adm, "/config/ia");
  check("ADMIN: tela de IA tem o campo da chave do OpenRouter e o teste", x.r.status === 200 && x.t.includes("Chave do OpenRouter") && x.t.includes("Testar conexão com a IA") && !x.t.includes("sk-or-v1-0"), String(x.r.status));
  x = await get(com, "/config/ia");
  check("COMERCIAL: é barrado em /config/ia", denied(x.r), String(x.r.status));
  x = await get(adm, "/config/fiscal");
  check("ADMIN: tela fiscal tem envio do certificado e teste de conexão", x.r.status === 200 && x.t.includes("Testar conexão com a SEFAZ") && x.t.includes("Certificado digital A1") && x.t.includes("Senha do certificado"), String(x.r.status));
  x = await get(lei, "/conversas");
  check("LEITURA: é barrada em /conversas (mensagens são privadas)", denied(x.r), String(x.r.status));
  x = await get(lei, "/agente");
  check("LEITURA: é barrada em /agente", denied(x.r), String(x.r.status));
  x = await get(rep, "/agente");
  check("REPRESENTANTE: é barrado em /agente", denied(x.r), String(x.r.status));
  x = await get(rep, "/clientes");
  check("REPRESENTANTE: clientes só dos seus estados", x.r.status === 200 && !x.t.includes("Clínica Bella Estética"));
  x = await get(rep, "/conversas");
  check("REPRESENTANTE: não vê conversas de outros estados", x.r.status === 200 && !x.t.includes("Oficina Bom Pistão") && !x.t.includes("Visitante do site"));
  x = await get(adm, "/painel");
  check("ADMIN: botão da chave geral do agente", x.t.includes("Agente IA ativo") && x.t.includes("Pausar o agente"));
  x = await get(com, "/painel");
  check("COMERCIAL: vê o estado do agente sem poder pausar", x.t.includes("Agente IA ativo") && !x.t.includes("Pausar o agente"));
}

// 6b. Webhook do Asaas (M7)
{
  const url = `${BASE}/api/webhooks/asaas`;
  const tok = process.env.ASAAS_WEBHOOK_TOKEN;
  const body = JSON.stringify({ id: "smoke-evt", event: "PAYMENT_RECEIVED", payment: { id: "pay_inexistente", value: 1 } });
  let r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  check("asaas: sem token é negado", r.status === 401, String(r.status));
  r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": "errado" }, body });
  check("asaas: token errado é negado", r.status === 401, String(r.status));
  r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": tok ?? "" }, body });
  const j = await r.json().catch(() => ({}));
  check("asaas: pagamento desconhecido é aceito e ignorado", r.status === 200 && (j.result === "desconhecida" || j.duplicate === true), JSON.stringify(j));
}

// 6c. Site público servido pelo app (M7b)
{
  const pages = ["/", "/agua-desmineralizada", "/fluido-de-radiador", "/representantes", "/quem-somos", "/contato", "/politica-de-privacidade", "/politica-de-cookies"];
  for (const p of pages) {
    const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
    const t = r.status === 200 ? await r.text() : "";
    check(`site: ${p} abre sem login`, r.status === 200 && t.includes("Flurtek") && !t.includes("__SITE_KEY__") && !/href="[a-z-]+.html/.test(t), String(r.status));
  }
  for (const p of pages) {
    const t = await (await fetch(`${BASE}${p}`)).text();
    const imgs = [...new Set([...t.matchAll(/["'](\/site\/img\/[^"']+)["']/g)].map((m) => m[1]))];
    const bad = [];
    for (const i of imgs) if ((await fetch(`${BASE}${i}`)).status !== 200) bad.push(i);
    check(`site: ${p} sem imagens quebradas nem caminhos relativos`, bad.length === 0 && !/["']img\//.test(t), bad.join(", "));
    const ldRelative = [...t.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].some((m) => /"(?:image|logo)":"\/(?!\/)/.test(m[1]));
    check(`site: ${p} tem canonical, Open Graph, ícone e dados estruturados com endereço completo`, t.includes('rel="canonical"') && t.includes('property="og:title"') && t.includes('property="og:image"') && t.includes('rel="icon"') && !ldRelative);
  }
  check("site: ícone do site existe", (await fetch(`${BASE}/site/favicon.svg`)).status === 200);
  {
    const withWa = [];
    for (const p of [...pages, "/blog"]) if ((await (await fetch(`${BASE}${p}`)).text()).includes('class="wa"')) withWa.push(p);
    check("site: o canto da tela tem só o chat (sem botão flutuante do WhatsApp)", withWa.length === 0, withWa.join(", "));
  }
  const agua = await (await fetch(`${BASE}/agua-desmineralizada`)).text();
  check(
    "site: página da água traz o texto oficial (filtragem, isenta de sais, 100% purificada, condutividade controlada, aplicações)",
    ["diversos estágios de filtragem", "Isenta de sais minerais", "100% purificada", "condutividade elétrica controlada", "tratores, barcos, caminhões", "Compre agora"].every((t) => agua.includes(t)),
  );
  const homeHtml = await (await fetch(`${BASE}/`)).text();
  check("site: home resume o processo da água ECO-SUL", homeHtml.includes("Água Desmineralizada ECO-SUL") && homeHtml.includes("Vários estágios de filtragem"));
  const home = await (await fetch(`${BASE}/`)).text();
  check("site: formulários apontam para o CRM na mesma origem", home.includes("data-same-origin") && home.includes(`data-site-key="${process.env.INTAKE_SITE_KEY}"`));
  const js = await fetch(`${BASE}/site/crm-forms.js`);
  check("site: script dos formulários e imagens são públicos", js.status === 200 && (await fetch(`${BASE}/site/img/agua-20l.webp`)).status === 200);
  const rb = await fetch(`${BASE}/robots.txt`);
  check("site: robots bloqueia as áreas do CRM", rb.status === 200 && (await rb.text()).includes("Disallow: /painel"));
  const painel = await fetch(`${BASE}/painel`, { redirect: "manual" });
  check("CRM continua protegido por login", [302, 307].includes(painel.status) && (painel.headers.get("location") ?? "").includes("/login"));

  // Blog
  const blog = await (await fetch(`${BASE}/blog`)).text();
  const slugs = [...new Set([...blog.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
  check("blog: índice lista 8 artigos", slugs.length === 8, String(slugs.length));
  for (const s of slugs) {
    const r = await fetch(`${BASE}/blog/${s}`);
    const t = r.status === 200 ? await r.text() : "";
    const h1 = (t.match(/<h1>/g) ?? []).length;
    check(`blog: /blog/${s} completo (canonical, Article, FAQ, 1 h1, sem imagem relativa)`, r.status === 200 && t.includes('rel="canonical"') && t.includes('"@type":"Article"') && t.includes('"@type":"FAQPage"') && h1 === 1 && !t.includes("__BASE__") && !/["']img\//.test(t), `${r.status} h1=${h1}`);
  }
  const sm = await (await fetch(`${BASE}/sitemap.xml`)).text();
  check("blog: sitemap lista todos os artigos", slugs.every((s) => sm.includes(`/blog/${s}`)));
  check("blog: slug inválido ou com caminho não abre arquivos", (await fetch(`${BASE}/blog/..%2Fquem-somos`)).status === 404 && (await fetch(`${BASE}/blog/nao-existe`)).status === 404);

  // Chat do site
  check("chat: widget é injetado nas páginas", home.includes('src="/site/chat.js"') && (await fetch(`${BASE}/site/chat.js`)).status === 200);
  const chatUrl = `${BASE}/api/public/chat`;
  const body = JSON.stringify({ message: "oi", consent: true });
  check("chat: origem não permitida é negada", (await fetch(chatUrl, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "x-site-key": process.env.INTAKE_SITE_KEY ?? "" }, body })).status === 403);
  const okOrigin = (process.env.INTAKE_ALLOWED_ORIGINS ?? "").split(",")[0]?.trim() ?? "";
  check("chat: sem a chave do site é negado", (await fetch(chatUrl, { method: "POST", headers: { "content-type": "application/json", origin: okOrigin }, body })).status === 401);
  check("chat: sessão desconhecida dá 404", (await fetch(`${chatUrl}?s=${"0".repeat(32)}`)).status === 404);
}

// 7. API pública dos formulários (M3)
{
  const db = new PrismaClient();
  const ORIGIN = "http://localhost:8766";
  const KEY = process.env.INTAKE_SITE_KEY;
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const post = (body, headers = {}) =>
    fetch(`${BASE}/api/public/leads`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-site-key": KEY, "x-forwarded-for": ip, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const valid = { form: "cotacao", name: "Smoke Teste", email: "smoke@zz-smoke.test", product: "Água desmineralizada", volume: "20L", uf: "RS", city: "Caxias do Sul", consent: true, consentText: "Aceite de teste." };

  let r = await fetch(`${BASE}/api/public/leads`, { method: "OPTIONS", headers: { origin: ORIGIN } });
  check("formulário: preflight de origem permitida", r.status === 204 && r.headers.get("access-control-allow-origin") === ORIGIN, String(r.status));
  r = await fetch(`${BASE}/api/public/leads`, { method: "OPTIONS", headers: { origin: "https://site-malicioso.example" } });
  check("formulário: preflight de origem desconhecida é negado", r.status === 403 && !r.headers.get("access-control-allow-origin"));
  r = await post(valid, { origin: "https://site-malicioso.example" });
  check("formulário: POST de origem desconhecida é negado", r.status === 403);
  r = await post(valid, { "x-site-key": "chave-errada" });
  check("formulário: chave do site errada é negada", r.status === 401);
  r = await post({ ...valid, consent: false });
  const bad = await r.json();
  check("formulário: sem consentimento dá 422 com o campo", r.status === 422 && Boolean(bad.fields?.consent), String(r.status));
  r = await post("{isto não é json");
  check("formulário: JSON inválido dá 400", r.status === 400);
  r = await post("x".repeat(25_000));
  check("formulário: corpo grande demais dá 413", r.status === 413);

  r = await post({ ...valid, email: "robo@zz-smoke.test", website: "http://spam.example" });
  check("formulário: campo-isca responde 201 mas não grava", r.status === 201 && (await db.contact.count({ where: { email: "robo@zz-smoke.test" } })) === 0);

  r = await post({ ...valid, submissionId: `smoke-${ip}` });
  const ok1 = await r.json();
  check("formulário: lead válido é criado (201 com protocolo)", r.status === 201 && ok1.ok === true && /^[0-9A-Z]{8}$/.test(ok1.reference), String(r.status));
  check("formulário: CORS na resposta", r.headers.get("access-control-allow-origin") === ORIGIN);
  const lead = await db.lead.findFirst({ where: { contact: { email: "smoke@zz-smoke.test" } }, include: { events: true } });
  check("formulário: lead gravado com consentimento e origem do site", Boolean(lead?.consentAt) && lead?.source === "SITE_FORMULARIO" && lead?.consentSource === "site:cotacao");
  r = await post({ ...valid, submissionId: `smoke-${ip}` });
  const ok2 = await r.json();
  check("formulário: reenvio com o mesmo id não duplica", r.status === 200 && ok2.duplicate === true && ok2.reference === ok1.reference);

  let last = 0;
  for (let i = 0; i < 9; i++) last = (await post({ ...valid, email: `rl${i}@zz-smoke.test` })).status;
  check("formulário: limitador responde 429 depois de muitas tentativas", last === 429, String(last));

  const contacts = await db.contact.findMany({ where: { email: { endsWith: "@zz-smoke.test" } }, select: { id: true, companyId: true } });
  await db.lead.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
  await db.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
  await db.company.deleteMany({ where: { id: { in: contacts.map((c) => c.companyId).filter(Boolean) } } });
  await db.intakeSubmission.deleteMany({ where: { submissionId: { startsWith: "smoke-" } } });
  await db.$disconnect();
}

// 8. Webhook do ConextBot (M4)
{
  const db = new PrismaClient();
  const TOKEN = process.env.CONEXTBOT_WEBHOOK_TOKEN;
  const PH = "5554990009999";
  const payload = (id) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: PH, profile: { name: "ZZ Smoke WhatsApp" } }], messages: [{ id, from: PH, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Oi, quero uma cotação" } }] } }] }] });
  const hook = (body, qs = `?token=${TOKEN}`) => fetch(`${BASE}/api/webhooks/conextbot${qs}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const id = `wamid.smoke.${Date.now()}`;

  let r = await hook(payload(id), "");
  check("webhook: sem token é negado", r.status === 401);
  r = await hook(payload(id), "?token=errado");
  check("webhook: token errado é negado", r.status === 401);
  r = await hook("{não é json");
  check("webhook: JSON inválido dá 400", r.status === 400);
  r = await hook(payload(id));
  const j1 = await r.json();
  check("webhook: mensagem válida é processada", r.status === 200 && j1.ok && j1.messages === 1, JSON.stringify(j1));
  r = await hook(payload(id));
  const j2 = await r.json();
  check("webhook: repetição é ignorada (idempotente)", j2.duplicates === 1 && j2.messages === 0);
  const conv = await db.conversation.findUnique({ where: { channel_externalId: { channel: "WHATSAPP", externalId: PH } }, include: { messages: true, lead: true } });
  check("webhook: conversa, lead e mensagem criados, janela aberta", Boolean(conv?.lead) && conv.messages.length === 1 && Boolean(conv.lastInboundAt) && conv.lead.source === "WHATSAPP");
  r = await fetch(`${BASE}/api/webhooks/conextbot?token=${TOKEN}`, { method: "GET" });
  check("webhook: GET de verificação responde 200", r.status === 200);

  if (conv) {
    await db.conversation.delete({ where: { id: conv.id } });
    const leadId = conv.lead.id;
    const contactId = conv.lead.contactId;
    await db.lead.delete({ where: { id: leadId } });
    if (contactId) await db.contact.delete({ where: { id: contactId } });
  }
  await db.$disconnect();
}

console.log(failures ? `\n${failures} verificação(ões) falharam.` : "\nTodas as verificações passaram.");
process.exit(failures ? 1 : 0);
