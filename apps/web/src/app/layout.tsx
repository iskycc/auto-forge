import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { getPlatformServices } from "@/lib/services";

import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AutoForge",
    template: "%s · AutoForge",
  },
  description: "离线优先的自动化用例工厂",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const mode = (await getPlatformServices()).config.mode;
  return (
    <html lang="zh-CN">
      <body>
        <AppShell mode={mode}>{children}</AppShell>
      </body>
    </html>
  );
}
