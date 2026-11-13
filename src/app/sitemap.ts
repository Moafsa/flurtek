import type { MetadataRoute } from "next";
import fs from "node:fs";
import path from "node:path";
import { SITE_PAGES } from "@/site-pages";

function blogPosts(): { slug: string; date: string }[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "site/blog/_index.json"), "utf8"));
  } catch {
    return [];
  }
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.SITE_URL ?? "http://localhost:3100";
  const pages = ["", ...Object.keys(SITE_PAGES)].map((p) => ({ url: `${base}/${p}`, changeFrequency: "monthly" as const, priority: p === "" ? 1 : 0.7 }));
  const posts = blogPosts();
  return [
    ...pages,
    { url: `${base}/blog`, changeFrequency: "weekly" as const, priority: 0.8, ...(posts[0] ? { lastModified: posts[0].date } : {}) },
    ...posts.map((b) => ({ url: `${base}/blog/${b.slug}`, lastModified: b.date, changeFrequency: "monthly" as const, priority: 0.7 })),
  ];
}
