import { sitePage } from "@/server/site";

export const dynamic = "force-dynamic";

export function GET() {
  return sitePage("blog", "/blog");
}
