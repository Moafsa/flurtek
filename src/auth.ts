import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validators";
import { dummyHash, verifyPassword } from "@/server/password";
import { writeAudit } from "@/server/audit";

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = loginSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const user = await db.user.findUnique({ where: { email } });
        if (!user || !user.active) {
          // Gasta o mesmo tempo de um login real para não revelar se o e-mail existe.
          await verifyPassword(await dummyHash(), password);
          return null;
        }
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          await writeAudit({ action: "login.bloqueado", entity: "User", entityId: user.id, actorType: "SISTEMA" });
          return null;
        }

        const ok = await verifyPassword(user.passwordHash, password);
        if (!ok) {
          const failures = user.failedLogins + 1;
          const lock = failures >= MAX_FAILURES;
          await db.user.update({
            where: { id: user.id },
            data: {
              failedLogins: lock ? 0 : failures,
              lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
            },
          });
          await writeAudit({
            action: lock ? "login.conta_bloqueada" : "login.falhou",
            entity: "User",
            entityId: user.id,
            actorType: "SISTEMA",
          });
          return null;
        }

        await db.user.update({
          where: { id: user.id },
          data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
        });
        await writeAudit({ action: "login.ok", entity: "User", entityId: user.id, actorType: "USUARIO", actorId: user.id });
        return { id: user.id, name: user.name, email: user.email, role: user.role };
      },
    }),
  ],
});
