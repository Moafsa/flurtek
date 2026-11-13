import { sitePage } from "@/server/site";

export const dynamic = "force-dynamic";

// O slug vira nome de arquivo: só letras minúsculas, números e hífen (sem barras nem pontos).
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || slug.length > 120) return new Response("Página não encontrada.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return sitePage(`blog/${slug}`, `/blog/${slug}`);
}
