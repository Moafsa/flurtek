// Gera as páginas do blog a partir de content/blog/*.md, usando cabeçalho, rodapé e estilo do próprio site.
// Uso: node scripts/build-blog.mjs   (rode de novo depois de editar um artigo ou o layout do site)
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const root = path.resolve(import.meta.dirname, "..");
const SRC = path.join(root, "content/blog");
const OUT = path.join(root, "site");
const SHELL = fs.readFileSync(path.join(OUT, "quem-somos.html"), "utf8");

const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const slugify = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dateBR = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function parseFile(file) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: faltam os metadados (--- ... ---)`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  for (const k of ["title", "description", "keyword", "date", "category", "image", "imageAlt", "cta", "ctaHref"]) if (!meta[k]) throw new Error(`${file}: falta "${k}"`);
  meta.slug = file.replace(/\.md$/, "");
  meta.related = (meta.related ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  meta.keywords = (meta.keywords ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  meta.body = m[2].trim();
  if (meta.description.length > 165) throw new Error(`${file}: descrição com ${meta.description.length} caracteres (máximo 165)`);
  if (meta.title.length > 70) throw new Error(`${file}: título com ${meta.title.length} caracteres (máximo 70)`);
  return meta;
}

// Markdown -> HTML com ids nos títulos, índice, FAQ extraída e tabelas rolando no celular.
function render(meta) {
  const toc = [];
  const faq = [];
  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const plain = text.replace(/<[^>]+>/g, "");
    const id = slugify(plain);
    if (depth === 2) toc.push({ id, text: plain });
    return `<h${depth} id="${id}">${text}</h${depth}>\n`;
  };
  renderer.table = function (token) {
    const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join("");
    const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");
    return `<div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const external = /^https?:/.test(href);
    return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${this.parser.parseInline(tokens)}</a>`;
  };
  marked.use({ renderer, gfm: true });

  // FAQ: tudo sob "## Perguntas frequentes", cada "### Pergunta" seguida da resposta.
  const faqMatch = meta.body.match(/\n## Perguntas frequentes\n([\s\S]*)$/);
  if (faqMatch) {
    for (const block of faqMatch[1].split(/\n(?=### )/)) {
      const q = block.match(/^### (.+)\n([\s\S]+)$/);
      if (q) faq.push({ q: q[1].trim(), a: q[2].trim() });
    }
  }
  const html = marked.parse(meta.body);
  return { html, toc, faq };
}

const stripMd = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim();
const wordCount = (s) => stripMd(s).split(" ").filter(Boolean).length;

const POST_CSS = `<style>
.post-wrap{background:#fff;padding:56px 0 24px}
.post-grid{display:grid;grid-template-columns:minmax(0,740px) 280px;gap:56px;justify-content:center;align-items:start}
.post{min-width:0;font-size:18px;line-height:1.75;color:#2b2b2b}
.post h2{font:700 30px/1.2 var(--font-display);color:var(--navy-900);margin:2.2em 0 .6em;text-wrap:balance;scroll-margin-top:96px}
.post h3{font:700 21px/1.3 var(--font-display);color:var(--navy-900);margin:1.8em 0 .5em;scroll-margin-top:96px}
.post p{margin:0 0 1.15em}.post ul,.post ol{margin:0 0 1.3em;padding-left:1.3em}.post li{margin:.35em 0}
.post a{color:#4a5200;font-weight:600;text-decoration:underline;text-underline-offset:3px}.post a:hover{color:#000}
.post strong{color:#141414}
.post blockquote{margin:1.6em 0;padding:18px 22px;background:#f5f7d6;border-left:5px solid var(--lime,#cedc00);border-radius:0 14px 14px 0}.post blockquote p:last-child{margin:0}
.post .tbl{overflow-x:auto;margin:1.6em 0;border:1px solid #e4e4de;border-radius:14px}
.post table{border-collapse:collapse;width:100%;font-size:15.5px;line-height:1.5;min-width:520px}
.post th{background:#141414;color:#fff;text-align:left;padding:12px 14px;font:600 13px/1.3 var(--font-display);letter-spacing:.04em}
.post td{padding:12px 14px;border-top:1px solid #ececE6;vertical-align:top}.post tr:nth-child(even) td{background:#fafaf6}
.post figure{margin:2em 0;background:linear-gradient(160deg,var(--navy-800),var(--navy-950));border-radius:18px;display:grid;place-items:center;padding:26px}
.post figure img{height:260px;width:auto;filter:drop-shadow(0 18px 24px rgba(0,0,0,.45))}.post figcaption{color:#cfcfcf;font-size:13px;margin-top:10px;text-align:center}
.post-lead{font-size:21px;line-height:1.6;color:#333;margin:0 0 1.4em}
.post-meta{display:flex;gap:10px 18px;flex-wrap:wrap;color:#c9c9c9;font-size:14px;margin-top:18px}.post-meta b{color:#cedc00;font-weight:600}
.toc{position:sticky;top:96px;background:#f5f5f0;border:1px solid #e4e4de;border-radius:16px;padding:20px 22px;font-size:14.5px}
.toc h2{font:700 12px/1 var(--font-display);letter-spacing:.14em;text-transform:uppercase;color:#6b7300;margin:0 0 12px}.toc ol{margin:0;padding-left:1.1em}.toc li{margin:.5em 0}.toc a{color:#222;text-decoration:none}.toc a:hover{color:#4a5200;text-decoration:underline}
.toc .cta-mini{display:block;margin-top:16px;text-align:center;padding:12px 14px;border-radius:999px;background:#cedc00;color:#141414;font:700 14px var(--font-display);text-decoration:none}
.post-cta{margin:2.6em 0 1em;padding:30px;border-radius:20px;background:#141414;color:#fff;display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.post-cta p{margin:0;font:600 20px/1.35 var(--font-display);max-width:34ch}.post-cta small{display:block;font:400 14px/1.5 Inter,sans-serif;color:#c9c9c9;margin-top:6px}
.post-cta a.btn{text-decoration:none;color:#141414}
.related{background:#f5f5f0;padding:64px 0}.related h2{font:700 28px/1.2 var(--font-display);margin:0 0 24px}
.rel-grid,.blog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:22px}
.pcard{background:#fff;border:1px solid #e4e4de;border-radius:18px;overflow:hidden;display:flex;flex-direction:column;text-decoration:none;color:inherit;transition:transform .2s,box-shadow .2s}
.pcard:hover{transform:translateY(-3px);box-shadow:0 18px 40px -18px rgba(0,0,0,.35)}
.pcard .pimg{height:170px;background:linear-gradient(160deg,var(--navy-800),var(--navy-950));display:grid;place-items:center}.pcard .pimg{overflow:hidden}.pcard .pimg img{height:132px;width:auto;filter:drop-shadow(0 12px 16px rgba(0,0,0,.45))}
.pcard .pbody{padding:20px;display:flex;flex-direction:column;gap:8px;flex:1}.pcard .tag{align-self:flex-start;background:#eef0c4;color:#4a5200;font:700 11px/1 var(--font-display);letter-spacing:.1em;text-transform:uppercase;padding:6px 10px;border-radius:999px}
.pcard h3{font:700 19px/1.3 var(--font-display);margin:0;color:#141414}.pcard p{margin:0;font-size:14.5px;line-height:1.55;color:#555}.pcard .more{margin-top:auto;font:700 14px var(--font-display);color:#4a5200}
.blog-list{background:#fff;padding:64px 0 96px}
@media(max-width:1180px){.page-hero .wrap,.post-wrap .wrap,.related .wrap,.blog-list .wrap{padding-left:clamp(28px,6vw,64px);padding-right:clamp(28px,6vw,64px)}}
@media(max-width:1000px){.post-grid{grid-template-columns:minmax(0,1fr)}.toc{position:static;order:-1}.post{font-size:17px}.post h2{font-size:26px}}
@media(max-width:560px){.post-wrap{padding-top:36px}.post figure img{height:210px}.post-cta{padding:24px}}
</style>`;

function shellParts(title, description, pathname) {
  const i = SHELL.indexOf("<main>");
  const j = SHELL.indexOf("</main>") + "</main>".length;
  let head = SHELL.slice(0, i)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(description)}">`)
    .replaceAll(' aria-current="page"', "")
    .replaceAll('<a href="/blog">Blog</a>', "")
    .replaceAll('<a href="/contato">Contato</a>', '<a href="/blog"' + (pathname.startsWith("/blog") ? ' aria-current="page"' : "") + '>Blog</a><a href="/contato">Contato</a>');
  head = head.replace(/<link rel="canonical"[^>]*>/, "").replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
  const tail = SHELL.slice(j).replace('<li><a href="/#conhecimento">Blog</a></li>', '<li><a href="/blog">Blog</a></li>');
  return { head: head.replace("</head>", `${POST_CSS}</head>`), tail };
}

function jsonld(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;
}

const posts = fs.readdirSync(SRC).filter((f) => f.endsWith(".md")).sort().map(parseFile);
posts.sort((a, b) => Number(a.order ?? 99) - Number(b.order ?? 99) || b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
const bySlug = Object.fromEntries(posts.map((p) => [p.slug, p]));
fs.mkdirSync(path.join(OUT, "blog"), { recursive: true });
for (const f of fs.readdirSync(path.join(OUT, "blog"))) fs.unlinkSync(path.join(OUT, "blog", f));

const card = (p) =>
  `<a class="pcard" href="/blog/${p.slug}"><div class="pimg"><img src="${esc(p.image)}" alt="${esc(p.imageAlt)}" loading="lazy"></div><div class="pbody"><span class="tag">${esc(p.category)}</span><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p><span class="more">Ler artigo →</span></div></a>`;

for (const p of posts) {
  const { html, toc, faq } = render(p);
  for (const r of p.related) if (!bySlug[r]) throw new Error(`${p.slug}: artigo relacionado inexistente "${r}"`);
  const minutes = Math.max(3, Math.round(wordCount(p.body) / 190));
  const related = p.related.map((s) => bySlug[s]);
  const url = `__BASE__/blog/${p.slug}`;
  const { head, tail } = shellParts(`${p.title} | Blog Flurtek`, p.description, "/blog/x");
  const ld = [
    jsonld({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: p.title,
      description: p.description,
      image: p.image,
      datePublished: p.date,
      dateModified: p.updated ?? p.date,
      inLanguage: "pt-BR",
      keywords: [p.keyword, ...p.keywords].join(", "),
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
      author: { "@type": "Organization", name: "Flurtek", url: "__BASE__/" },
      publisher: { "@type": "Organization", name: "Flurtek", logo: { "@type": "ImageObject", url: "/site/img/logo-flurtek.png" } },
    }),
    jsonld({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "__BASE__/" },
        { "@type": "ListItem", position: 2, name: "Blog", item: "__BASE__/blog" },
        { "@type": "ListItem", position: 3, name: p.title, item: url },
      ],
    }),
    faq.length ? jsonld({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: stripMd(f.a) } })) }) : "",
  ].join("");

  const main = `<main>
<section class="page-hero on-dark"><div class="wrap">
  <nav class="crumbs" aria-label="Você está em"><a href="/">Home</a><span>/</span><a href="/blog">Blog</a><span>/</span><b style="color:#fff;font-weight:500">${esc(p.category)}</b></nav>
  <div class="ph-inner"><span class="eyebrow">${esc(p.category)}</span><h1>${esc(p.title)}</h1><p>${esc(p.description)}</p>
  <div class="post-meta"><span><b>Por</b> Equipe Flurtek</span><span><time datetime="${p.date}">${dateBR(p.date)}</time></span><span>${minutes} min de leitura</span></div></div>
</div></section>
<div class="post-wrap"><div class="wrap"><div class="post-grid">
<article class="post" itemscope itemtype="https://schema.org/Article">
<figure><img src="${esc(p.image)}" alt="${esc(p.imageAlt)}" width="260" height="260"><figcaption>${esc(p.imageCaption ?? p.imageAlt)}</figcaption></figure>
${html}
<div class="post-cta"><p>${esc(p.cta)}<small>Resposta da equipe comercial no mesmo dia útil.</small></p><a class="btn btn-amber" href="${esc(p.ctaHref)}">Solicitar cotação</a></div>
</article>
<aside class="toc" aria-label="Neste artigo"><h2>Neste artigo</h2><ol>${toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join("")}</ol><a class="cta-mini" href="${esc(p.ctaHref)}">Pedir cotação</a></aside>
</div></div></div>
${related.length ? `<section class="related"><div class="wrap"><h2>Continue lendo</h2><div class="rel-grid">${related.map(card).join("")}</div></div></section>` : ""}
</main>`;

  fs.writeFileSync(path.join(OUT, "blog", `${p.slug}.html`), head.replace("</head>", `${ld}<meta name="og-type" content="article"><meta name="share-image" content="${esc(p.image)}"><meta name="article-published" content="${p.date}"></head>`) + main + tail);
}

// Índice do blog
{
  const title = "Blog Flurtek: água desmineralizada e fluido de radiador";
  const description = "Guias práticos sobre água desmineralizada, baterias, radiadores e fluido de arrefecimento, com aplicações por setor e dicas de quem fabrica.";
  const { head, tail } = shellParts(title, description, "/blog");
  const ld = jsonld({ "@context": "https://schema.org", "@type": "Blog", name: "Blog Flurtek", description, url: "__BASE__/blog", inLanguage: "pt-BR", publisher: { "@type": "Organization", name: "Flurtek" }, blogPost: posts.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: `__BASE__/blog/${p.slug}`, datePublished: p.date })) });
  const main = `<main>
<section class="page-hero on-dark"><div class="wrap">
  <nav class="crumbs" aria-label="Você está em"><a href="/">Home</a><span>/</span><b style="color:#fff;font-weight:500">Blog</b></nav>
  <div class="ph-inner"><span class="eyebrow">Blog</span><h1>Conhecimento técnico para <em>proteger</em> baterias, radiadores e equipamentos.</h1><p>Guias de quem fabrica: água desmineralizada, aditivo de radiador e as aplicações em cada setor.</p></div>
</div></section>
<section class="blog-list"><div class="wrap"><div class="blog-grid">${posts.map(card).join("")}</div></div></section>
<section class="cta"><div class="wrap"><div class="cta-box on-dark rv"><div><span class="eyebrow">Precisa de cotação?</span><h2>Água desmineralizada e fluido de radiador direto da fábrica.</h2><p>De 1 litro ao IBC de 1.000 litros, com entrega no Sul e representantes em outros estados.</p></div><div class="btns"><a href="/contato#formulario" class="btn btn-amber">Solicitar cotação</a><a href="/representantes" class="btn btn-ghost">Representantes</a></div></div></div></section>
</main>`;
  fs.writeFileSync(path.join(OUT, "blog.html"), head.replace("</head>", `${ld}</head>`) + main + tail);
}

fs.writeFileSync(path.join(OUT, "blog", "_index.json"), JSON.stringify(posts.map((p) => ({ slug: p.slug, date: p.updated ?? p.date })), null, 2));
console.log(`Blog gerado: ${posts.length} artigos + índice.`);
for (const p of posts) console.log(`  /blog/${p.slug}  (${wordCount(p.body)} palavras, título ${p.title.length}c, descrição ${p.description.length}c)`);
