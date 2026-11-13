import type { NextConfig } from "next";

// O CRM é uma aplicação autenticada e dinâmica: não usamos Cache Components
// (o modelo de prerender estático não se aplica a páginas que leem sessão e banco a cada requisição).
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
