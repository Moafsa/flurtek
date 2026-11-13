import { z } from "zod";
import { UF_LIST } from "@/lib/validators";

export const LEAD_FORMS = ["cotacao", "lista_espera", "representante", "contato"] as const;
export type LeadFormKind = (typeof LEAD_FORMS)[number];

const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

// Formulários do site. O consentimento é obrigatório; "website" é o campo-isca contra robôs.
export const intakeSchema = z
  .object({
    form: z.enum(LEAD_FORMS),
    name: z.string().trim().min(2, "Informe o nome.").max(120),
    email: z.union([z.literal(""), z.string().trim().toLowerCase().pipe(z.email("E-mail inválido."))]).optional().transform((v) => v || undefined),
    phone: text(40),
    company: text(120),
    uf: z.union([z.literal(""), z.enum(UF_LIST)]).optional().transform((v) => v || undefined),
    city: text(120),
    segment: text(80),
    cnpj: text(30),
    product: text(120),
    volume: text(120),
    frequency: text(60),
    subject: text(40),
    message: text(2000),
    consent: z.literal(true, { error: "É preciso aceitar a Política de Privacidade." }),
    consentText: text(400),
    pageUrl: text(300),
    submissionId: z.string().trim().min(8).max(80).optional(),
    utm: z
      .object({ source: text(80), medium: text(80), campaign: text(120) })
      .optional(),
    website: z.string().max(200).optional(),
  })
  .refine((v) => v.email || v.phone, { path: ["email"], message: "Informe e-mail ou telefone." });

export type IntakeInput = z.infer<typeof intakeSchema>;
