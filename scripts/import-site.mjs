// Importa o protótipo do site para dentro do app: páginas em /site (servidas com URLs limpas) e imagens em public/site.
// Uso: node scripts/import-site.mjs "<pasta do protótipo>"
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error("Informe a pasta do protótipo.");
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, "..");
const PAGES = ["home", "agua-desmineralizada", "fluido-de-radiador", "representantes", "quem-somos", "contato", "politica-de-privacidade", "politica-de-cookies"];

fs.mkdirSync(path.join(root, "site"), { recursive: true });
fs.mkdirSync(path.join(root, "public/site/img"), { recursive: true });

for (const name of PAGES) {
  let html = fs.readFileSync(path.join(src, `${name}.html`), "utf8");
  // Links entre páginas: home.html -> /, outras.html -> /outra (âncoras preservadas).
  html = html.replace(/href="([a-z0-9-]+)\.html(#[^"]*)?"/g, (_m, page, hash) => `href="${page === "home" ? "/" : `/${page}`}${hash ?? ""}"`);
  // Qualquer "img/..." entre aspas (atributos, CSS e strings dos scripts da página) passa a apontar para /site/img/.
  html = html.replace(/(["'])img\//g, "$1/site/img/");
  html = html.replace(/url\(\s*(?!["']?\/)(?!["']?data:)(["']?)img\//g, "url($1/site/img/");
  // Script de formulários: mesma origem, chave injetada pelo servidor.
  html = html.replace(/<script src="crm-forms\.js"[^>]*><\/script>/, '<script src="/site/crm-forms.js" data-same-origin data-site-key="__SITE_KEY__"></script>');
  // Botão flutuante do WhatsApp sai: o canto da tela fica só com o chat do site.
  html = html.replace(/<a class="wa"[\s\S]*?<\/a>\s*/, "");
  // Blog: item no menu (desktop e celular) e link do rodapé.
  html = html.replaceAll('<a href="/contato">Contato</a>', '<a href="/blog">Blog</a><a href="/contato">Contato</a>');
  html = html.replace('<li><a href="/#conhecimento">Blog</a></li>', '<li><a href="/blog">Blog</a></li>');
  if (name === "home") {
    // Seção "Conhecimento" da home: cada cartão aponta para o artigo real.
    const teasers = [
      ["Por que não usar água de torneira no radiador", "/blog/agua-desmineralizada-para-radiador"],
      ["Como e quando trocar a água da bateria", "/blog/agua-para-bateria-de-empilhadeira"],
      ["Fluido de radiador: pronto para usar ou concentrado?", "/blog/fluido-de-radiador-pronto-ou-concentrado"],
    ];
    for (const [title, href] of teasers) {
      html = html.replace(new RegExp(`<a href="#" class="post rv">(<div class="thumb"></div><div class="txt"><small>[^<]*</small><h3>${title.replace(/[?]/g, "\\?")}</h3><span>)Leitura de \\d+ min`), `<a href="${href}" class="post rv">$1Leitura de 7 min`);
    }
    html = html.replace('<a href="#" class="btn btn-dark">Ver todos os artigos', '<a href="/blog" class="btn btn-dark">Ver todos os artigos');
  }
  fs.writeFileSync(path.join(root, "site", `${name}.html`), html);
}

for (const f of fs.readdirSync(path.join(src, "img"))) fs.copyFileSync(path.join(src, "img", f), path.join(root, "public/site/img", f));

let js = fs.readFileSync(path.join(src, "crm-forms.js"), "utf8");
js = js.replace(/var URL_ = me && me\.dataset\.crmUrl;/, 'var SAME = !!(me && me.hasAttribute("data-same-origin"));\n  var URL_ = SAME ? "" : me && me.dataset.crmUrl;');
js = js.replace(/if \(!URL_ \|\| !KEY\) return;/, 'if ((!SAME && !URL_) || !KEY || KEY === "__SITE_KEY__") return;');
fs.writeFileSync(path.join(root, "public/site/crm-forms.js"), js);

const left = PAGES.map((p) => fs.readFileSync(path.join(root, "site", `${p}.html`), "utf8").match(/(?:href|src)="[a-z0-9-]+\.(?:html|js|webp|png)"/g) ?? []).flat();
console.log(`Importadas ${PAGES.length} páginas.`, left.length ? `Referências relativas restantes: ${[...new Set(left)].join(", ")}` : "Sem referências relativas restantes.");
