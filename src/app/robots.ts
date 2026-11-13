import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.SITE_URL ?? "http://localhost:3100";
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/painel", "/funil", "/leads", "/conversas", "/agente", "/clientes", "/financeiro", "/relatorios", "/config", "/login", "/api"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
