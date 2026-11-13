// Constantes do funil. Sem importar nada do Prisma, para poder ir ao navegador.

export const STAGES = ["NOVO", "QUALIFICADO", "COTACAO", "NEGOCIACAO", "FECHADO", "PERDIDO", "FRIO"] as const;
export type StageName = (typeof STAGES)[number];

export const BOARD_STAGES: StageName[] = ["NOVO", "QUALIFICADO", "COTACAO", "NEGOCIACAO", "FECHADO"];
export const EXTRA_STAGES: StageName[] = ["PERDIDO", "FRIO"];

export const STAGE_LABEL: Record<StageName, string> = {
  NOVO: "Novos leads",
  QUALIFICADO: "Qualificados",
  COTACAO: "Cotação enviada",
  NEGOCIACAO: "Negociação",
  FECHADO: "Fechado",
  PERDIDO: "Perdidos",
  FRIO: "Frios",
};

export const TEMPERATURES = ["QUENTE", "MORNO", "FRIO"] as const;
export type TemperatureName = (typeof TEMPERATURES)[number];
export const TEMPERATURE_LABEL: Record<TemperatureName, string> = { QUENTE: "quente", MORNO: "morno", FRIO: "frio" };

export const SOURCES = [
  "SITE_FORMULARIO",
  "CHAT_SITE",
  "SITE_LISTA_ESPERA",
  "WHATSAPP",
  "EMAIL",
  "MARKETPLACE",
  "GOOGLE_ADS",
  "REPRESENTANTE",
  "PROSPECCAO_IA",
  "MANUAL",
] as const;
export type SourceName = (typeof SOURCES)[number];
export const SOURCE_LABEL: Record<SourceName, string> = {
  SITE_FORMULARIO: "Site · formulário",
  CHAT_SITE: "Site · chat",
  SITE_LISTA_ESPERA: "Site · lista de espera",
  WHATSAPP: "WhatsApp",
  EMAIL: "E-mail",
  MARKETPLACE: "Marketplace",
  GOOGLE_ADS: "Google Ads",
  REPRESENTANTE: "Representante",
  PROSPECCAO_IA: "Prospecção IA",
  MANUAL: "Cadastro manual",
};

// Origens que a equipe pode escolher ao cadastrar um lead à mão.
export const MANUAL_SOURCES = ["MANUAL", "WHATSAPP", "EMAIL", "MARKETPLACE", "GOOGLE_ADS", "REPRESENTANTE"] as const;

export const CONSENT_BASES = {
  SOLICITACAO_CLIENTE: "O próprio cliente pediu contato ou cotação",
  LEGITIMO_INTERESSE_B2B: "Legítimo interesse (dado de empresa, relação B2B)",
  INDICACAO_REPRESENTANTE: "Indicação de representante",
  FORMULARIO_SITE: "Formulário do site com aceite",
} as const;
export type ConsentBase = keyof typeof CONSENT_BASES;

export const EVENT_LABEL: Record<string, string> = {
  criado: "Lead criado",
  nota: "Nota",
  etapa: "Mudança de etapa",
  atribuicao: "Responsável",
  edicao: "Dados atualizados",
  tarefa: "Tarefa",
  agente: "Agente",
};
