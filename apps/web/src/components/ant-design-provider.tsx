"use client";

import { App, ConfigProvider, theme, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import type { ReactNode } from "react";

const platformTheme: ThemeConfig = {
  zeroRuntime: true,
  cssVar: { key: "autoforge" },
  token: {
    colorPrimary: "#1668dc",
    colorSuccess: "#389e0d",
    colorWarning: "#d48806",
    colorError: "#cf1322",
    colorInfo: "#1668dc",
    colorBgLayout: "#f5f7fb",
    colorText: "#1f2937",
    colorTextSecondary: "#596579",
    colorFillAlter: "#f0f4f9",
    colorBorder: "#cbd5e1",
    colorBorderSecondary: "#e2e8f0",
    colorSuccessText: "#237804",
    colorWarningText: "#ad6800",
    colorInfoText: "#0958d9",
    colorErrorText: "#cf1322",
    borderRadius: 8,
    controlHeight: 36,
    controlHeightSM: 32,
    fontSize: 14,
    fontFamily:
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    motion: false,
  },
};

export function AntDesignProvider({ children }: { children: ReactNode }) {
  return (
    <AntdRegistry>
      <ConfigProvider locale={zhCN} theme={platformTheme} button={{ autoInsertSpace: false }}>
        <LayoutThemeTokens />
        <App component={false}>{children}</App>
      </ConfigProvider>
    </AntdRegistry>
  );
}

/** Business charts and virtualized layouts consume aliases of the same Ant Design tokens. */
function LayoutThemeTokens() {
  const { token } = theme.useToken();
  const aliases = {
    background: token.colorBgLayout,
    foreground: token.colorText,
    card: token.colorBgContainer,
    popover: token.colorBgElevated,
    primary: token.colorPrimary,
    "primary-foreground": token.colorTextLightSolid,
    secondary: token.colorPrimaryBg,
    muted: token.colorFillAlter,
    "muted-foreground": token.colorTextSecondary,
    accent: token.colorPrimaryBg,
    border: token.colorBorderSecondary,
    input: token.colorBorder,
    ring: token.colorPrimaryBorder,
    destructive: token.colorErrorText,
    success: token.colorSuccessText,
    info: token.colorInfoText,
    warning: token.colorWarningText,
  };
  return (
    <style data-autoforge-theme="antd">{`:root {${Object.entries(aliases)
      .map(([name, value]) => `--${name}:${value};`)
      .join("")}}`}</style>
  );
}
