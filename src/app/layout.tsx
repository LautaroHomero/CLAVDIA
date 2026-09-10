import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CLAVDIA · Клавдия — Secretario médico",
  description:
    "Agente de secretaría médica (DurableAgent + Workflow DevKit) con pasos human-in-the-loop por Slack. CLAVDIA es la forma latina de Клавдия (Claudia).",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
