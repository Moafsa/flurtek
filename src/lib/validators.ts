import { z } from "zod";
import { ROLES } from "@/server/rbac";

export const MIN_PASSWORD_LENGTH = 12;

export const UF_LIST = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR",
  "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("E-mail inválido")),
  password: z.string().min(1, "Informe a senha").max(200),
});

export const createUserSchema = z
  .object({
    name: z.string().trim().min(2, "Informe o nome").max(120),
    email: z.string().trim().toLowerCase().pipe(z.email("E-mail inválido")),
    role: z.enum(ROLES),
    states: z.array(z.enum(UF_LIST)).default([]),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `A senha provisória deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres`)
      .max(200),
  })
  .refine((v) => v.role !== "REPRESENTANTE" || v.states.length > 0, {
    path: ["states"],
    message: "Escolha ao menos um estado para o representante",
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;
