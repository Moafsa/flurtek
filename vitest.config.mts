import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Os testes usam o mesmo banco e o executor processa tudo que está aprovado: rodam um arquivo por vez.
  test: { environment: "node", include: ["tests/**/*.test.ts"], fileParallelism: false, globalSetup: ["./tests/global-setup.ts"] },
});
