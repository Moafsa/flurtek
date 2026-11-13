import { SITE_PAGES } from "@/site-pages";
import { sitePage } from "@/server/site";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ page: string }> }) {
  const { page } = await ctx.params;
  const file = Object.hasOwn(SITE_PAGES, page) ? SITE_PAGES[page] : undefined;
  if (!file) return new Response("Página não encontrada.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return sitePage(file, `/${page}`);
}
