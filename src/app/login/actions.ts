"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { loginSchema } from "@/lib/validators";

export type LoginState = { error?: string };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Informe um e-mail e uma senha válidos." };

  try {
    await signIn("credentials", { ...parsed.data, redirectTo: "/painel" });
  } catch (error) {
    if (error instanceof AuthError) {
      // Mensagem única: não revelamos se o e-mail existe, se a conta está bloqueada ou se a senha errou.
      return { error: "E-mail ou senha incorretos, ou conta temporariamente bloqueada." };
    }
    throw error; // inclui o redirecionamento de sucesso
  }
  return {};
}
