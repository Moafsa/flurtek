"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; badge?: number };

export function NavLinks({ items, variant }: { items: NavItem[]; variant: "side" | "bottom" }) {
  const path = usePathname();
  const active = (href: string) => path === href || path.startsWith(href + "/");

  if (variant === "bottom") {
    return (
      <nav aria-label="Navegação móvel" className="fixed inset-x-0 bottom-0 z-30 flex gap-1 overflow-x-auto bg-graphite p-1.5 pb-[max(6px,env(safe-area-inset-bottom))] md:hidden">
        {items.map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active(i.href) ? "page" : undefined}
            className={`flex min-h-12 min-w-[78px] flex-1 flex-col items-center justify-center rounded-lg px-2 text-center font-display text-[10px] font-semibold leading-tight ${active(i.href) ? "bg-lime text-on-lime" : "text-[#cfcfcf]"}`}
          >
            {i.label}
            {i.badge ? <span className="mt-0.5 rounded-full bg-graphite-600 px-1.5 text-[10px] text-white">{i.badge}</span> : null}
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Principal" className="grid gap-1">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={active(i.href) ? "page" : undefined}
          className={`flex min-h-11 items-center gap-2 rounded-lg px-3 py-2.5 font-medium transition ${active(i.href) ? "bg-lime font-semibold text-on-lime" : "text-[#cfcfcf] hover:bg-graphite-800 hover:text-white"}`}
        >
          {i.label}
          {i.badge ? (
            <span className={`ml-auto rounded-full px-2 py-0.5 font-display text-[11px] font-bold ${active(i.href) ? "bg-on-lime text-lime" : "bg-graphite-600 text-white"}`}>{i.badge}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
