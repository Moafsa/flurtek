import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Barra qualquer rota que não seja pública quando não há sessão.
// A verificação fina (papel, conta ativa) acontece nas páginas e ações, no servidor.
export default NextAuth(authConfig).auth;

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webp|jpg)$).*)"],
};
