import type { NextAuthConfig } from "next-auth";

import { isSitePath } from "@/site-pages";

// Parte da configuração que não depende de banco nem de módulos nativos.
// É a que o proxy (antigo middleware) usa para barrar quem não está logado.
const PUBLIC_PREFIXES = ["/api/public", "/api/health", "/api/webhooks", "/robots.txt", "/sitemap.xml"];

export const authConfig = {
  pages: { signIn: "/login" },
  providers: [],
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const path = nextUrl.pathname;
      if (PUBLIC_PREFIXES.some((p) => path.startsWith(p)) || isSitePath(path)) return true;
      const logged = Boolean(auth?.user);
      if (path === "/login") {
        return logged ? Response.redirect(new URL("/painel", nextUrl)) : true;
      }
      return logged;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
