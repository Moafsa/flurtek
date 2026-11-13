import type { Metadata } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const sora = Sora({ variable: "--font-sora", subsets: ["latin"], weight: ["600", "700", "800"] });

export const metadata: Metadata = {
  title: { default: "Flurtek CRM", template: "%s · Flurtek CRM" },
  description: "CRM e agente de IA da Flurtek.",
  robots: { index: false, follow: false },
  icons: { icon: "/site/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${sora.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
