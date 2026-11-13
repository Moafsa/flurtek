// Papéis e permissões. Toda checagem de acesso é feita no servidor com estas funções.

export const ROLES = ["ADMIN", "COMERCIAL", "REPRESENTANTE", "LEITURA"] as const;
export type RoleName = (typeof ROLES)[number];

export type Permission =
  | "lead:read"
  | "lead:write"
  | "lead:move"
  | "lead:note"
  | "task:write"
  | "conversation:read"
  | "conversation:write"
  | "agent:review"
  | "agent:configure"
  | "report:read"
  | "kb:read"
  | "kb:write"
  | "user:manage"
  | "audit:read"
  | "finance:read"
  | "finance:write"
  | "finance:admin";

const ALL: Permission[] = [
  "lead:read",
  "lead:write",
  "lead:move",
  "lead:note",
  "task:write",
  "conversation:read",
  "conversation:write",
  "agent:review",
  "agent:configure",
  "report:read",
  "kb:read",
  "kb:write",
  "user:manage",
  "audit:read",
  "finance:read",
  "finance:write",
  "finance:admin",
];

const MATRIX: Record<RoleName, ReadonlySet<Permission>> = {
  ADMIN: new Set(ALL),
  COMERCIAL: new Set<Permission>([
    "lead:read",
    "lead:write",
    "lead:move",
    "lead:note",
    "task:write",
    "conversation:read",
    "conversation:write",
    "agent:review",
    "report:read",
    "kb:read",
    "finance:read",
    "finance:write",
  ]),
  // Representante vê apenas leads dos seus estados (filtro aplicado nas consultas) e registra notas e tarefas.
  REPRESENTANTE: new Set<Permission>(["lead:read", "lead:note", "task:write", "conversation:read", "kb:read"]),
  LEITURA: new Set<Permission>(["lead:read", "report:read", "kb:read"]),
};

export function isRole(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function can(role: string | null | undefined, permission: Permission): boolean {
  return isRole(role) && MATRIX[role].has(permission);
}

export function permissionsOf(role: RoleName): Permission[] {
  return [...MATRIX[role]];
}

export const ROLE_LABEL: Record<RoleName, string> = {
  ADMIN: "Administrador",
  COMERCIAL: "Comercial",
  REPRESENTANTE: "Representante",
  LEITURA: "Somente leitura",
};
