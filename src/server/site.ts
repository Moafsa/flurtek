import { readFile } from "node:fs/promises";
import path from "node:path";

const DIR = path.join(process.cwd(), "site");
const cache = new Map<string, string>();

// Imagem de compartilhamento por página (redes sociais e WhatsApp).
const SHARE_IMAGE: Record<string, string> = {
  home: "/site/img/agua-20l.webp",
  "agua-desmineralizada": "/site/img/agua-20l.webp",
  "fluido-de-radiador": "/site/img/aditivo-concentrado-1l.webp",
};
const DEFAULT_SHARE_IMAGE = "/site/img/logo-flurtek.png";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const decode = (s: string) => s.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&lt;", "<");

export function siteBase(): string {
  return (process.env.SITE_URL ?? "http://localhost:3100").replace(/\/$/, "");
}

// Acrescenta o que depende do endereço final: canonical, Open Graph, ícone e URLs absolutas nos dados estruturados.
export function enhanceHtml(html: string, file: string, pathname: string, base = siteBase()): string {
  const title = decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "Flurtek");
  const description = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
  const url = `${base}${pathname}`;
  const shareMeta = html.match(/<meta name="share-image" content="([^"]+)">/)?.[1];
  const ogType = html.includes('<meta name="og-type" content="article">') ? "article" : "website";
  const image = `${base}${shareMeta ?? SHARE_IMAGE[file] ?? DEFAULT_SHARE_IMAGE}`;
  const head = [
    html.includes('rel="canonical"') ? "" : `<link rel="canonical" href="${esc(url)}">`,
    html.includes('rel="icon"') ? "" : `<link rel="icon" type="image/svg+xml" href="/site/favicon.svg">`,
    html.includes('name="theme-color"') ? "" : `<meta name="theme-color" content="#141414">`,
    html.includes('property="og:title"')
      ? ""
      : [
          `<meta property="og:type" content="${ogType}">`,
          `<meta property="og:site_name" content="Flurtek">`,
          `<meta property="og:locale" content="pt_BR">`,
          `<meta property="og:title" content="${esc(title)}">`,
          description ? `<meta property="og:description" content="${esc(description)}">` : "",
          `<meta property="og:url" content="${esc(url)}">`,
          `<meta property="og:image" content="${esc(image)}">`,
          `<meta name="twitter:card" content="summary_large_image">`,
        ].join(""),
  ].join("");
  let out = html.replace("</head>", `${head}</head>`).replaceAll("__BASE__", base);
  // Chat com o agente em todas as páginas (a chave pública vem do servidor).
  const key = process.env.INTAKE_SITE_KEY;
  if (key && !out.includes("/site/chat.js")) out = out.replace("</body>", `<script src="/site/chat.js" data-site-key="${esc(key)}" defer></script></body>`);
  // Dados estruturados precisam de endereços completos.
  out = out.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (_m, open, body: string, close) => `${open}${body.replaceAll('"/site/img/', `"${base}/site/img/`)}${close}`);
  return out;
}

// Lê a página do site, injeta a chave pública dos formulários e os metadados. Em desenvolvimento não usa cache.
export async function sitePage(file: string, pathname = "/"): Promise<Response> {
  const dev = process.env.NODE_ENV !== "production";
  const key = `${file}|${pathname}|${siteBase()}`;
  let html = dev ? undefined : cache.get(key);
  if (!html) {
    try {
      const raw = await readFile(path.join(DIR, `${file}.html`), "utf8");
      html = enhanceHtml(raw.replaceAll("__SITE_KEY__", process.env.INTAKE_SITE_KEY ?? "__SITE_KEY__"), file, pathname);
      if (!dev) cache.set(key, html);
    } catch {
      return new Response("Página não encontrada.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": dev ? "no-store" : "public, max-age=300, stale-while-revalidate=600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
