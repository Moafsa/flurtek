// Páginas públicas do site (URLs limpas) e o arquivo de cada uma em /site. Sem dependências: o proxy também usa.
export const SITE_PAGES: Record<string, string> = {
  "agua-desmineralizada": "agua-desmineralizada",
  "fluido-de-radiador": "fluido-de-radiador",
  representantes: "representantes",
  "quem-somos": "quem-somos",
  contato: "contato",
  "politica-de-privacidade": "politica-de-privacidade",
  "politica-de-cookies": "politica-de-cookies",
};

export const SITE_HOME_FILE = "home";

export function isSitePath(path: string): boolean {
  if (path === "/" || path.startsWith("/site/") || path === "/blog" || path.startsWith("/blog/")) return true;
  return Object.hasOwn(SITE_PAGES, path.slice(1));
}
