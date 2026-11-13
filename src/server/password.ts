import { hash, verify } from "@node-rs/argon2";

// Parâmetros argon2id recomendados pela OWASP para uso interativo.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Hash descartável para igualar o tempo de resposta quando o e-mail não existe.
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("senha-descartavel-sem-uso");
  return dummy;
}
