import { SITE_HOME_FILE } from "@/site-pages";
import { sitePage } from "@/server/site";

export const dynamic = "force-dynamic";

export function GET() {
  return sitePage(SITE_HOME_FILE, "/");
}
