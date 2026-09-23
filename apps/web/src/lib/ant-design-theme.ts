import { theme, type ThemeConfig } from "antd";
import type { CSSProperties } from "react";
import type { ColorMode } from "./color-mode";

const sharedTokens = {
  borderRadius: 8,
  controlHeight: 36,
  controlHeightSM: 32,
  fontSize: 14,
  fontFamily:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  motion: false,
  colorPrimary: "#1668dc",
  colorInfo: "#1668dc",
};

const lightTheme: ThemeConfig = {
  zeroRuntime: true,
  cssVar: { key: "autoforge" },
  token: {
    ...sharedTokens,
    colorSuccess: "#389e0d",
    colorWarning: "#d48806",
    colorError: "#cf1322",
    colorBgLayout: "#f5f7fb",
    colorText: "#1f2937",
    colorTextSecondary: "#596579",
    colorFillAlter: "#f0f4f9",
    colorBorder: "#cbd5e1",
    colorBorderSecondary: "#e2e8f0",
    colorSuccessText: "#237804",
    colorWarningText: "#925400",
    colorInfoText: "#0958d9",
    colorErrorText: "#cf1322",
  },
};

// Text accents need more contrast than filled actions on dark surfaces.
const darkAccent = { text: "#69b1ff", hover: "#91caff", active: "#4096ff" };
const darkTheme: ThemeConfig = {
  ...lightTheme,
  algorithm: theme.darkAlgorithm,
  token: {
    ...sharedTokens,
    colorBgBase: "#141820",
    colorBgLayout: "#101319",
    colorBgContainer: "#1b2029",
    colorBgElevated: "#252b36",
    colorText: "#e8edf5",
    colorTextSecondary: "#adb8c9",
    colorTextPlaceholder: "#93a0b3",
    colorFillAlter: "#252c38",
    colorBorder: "#536176",
    colorBorderSecondary: "#394557",
    colorPrimaryText: darkAccent.text,
    colorPrimaryTextHover: darkAccent.hover,
    colorPrimaryTextActive: darkAccent.active,
    colorInfoText: darkAccent.text,
    colorErrorText: "#ff7875",
    colorLink: darkAccent.text,
    colorLinkHover: darkAccent.hover,
    colorLinkActive: darkAccent.active,
  },
  components: {
    Menu: {
      itemSelectedColor: darkAccent.text,
      subMenuItemSelectedColor: darkAccent.text,
      horizontalItemSelectedColor: darkAccent.text,
    },
    Tabs: {
      itemSelectedColor: darkAccent.text,
      itemHoverColor: darkAccent.hover,
      itemActiveColor: darkAccent.active,
    },
    Pagination: { itemActiveColor: darkAccent.text, itemActiveColorHover: darkAccent.hover },
    Button: { defaultHoverColor: darkAccent.hover, defaultActiveColor: darkAccent.text },
  },
};

export const platformThemes: Record<ColorMode, ThemeConfig> = {
  light: lightTheme,
  dark: darkTheme,
};

/** Ant components, business charts, source code and logs share one palette. */
export function layoutThemeAliases(token: ReturnType<typeof theme.getDesignToken>) {
  return {
    background: token.colorBgLayout,
    foreground: token.colorText,
    card: token.colorBgContainer,
    popover: token.colorBgElevated,
    primary: token.colorPrimary,
    "primary-text": token.colorPrimaryText,
    "primary-foreground": token.colorTextLightSolid,
    secondary: token.colorPrimaryBg,
    muted: token.colorFillAlter,
    "muted-foreground": token.colorTextSecondary,
    accent: token.colorPrimaryBg,
    border: token.colorBorderSecondary,
    input: token.colorBorder,
    ring: token.colorPrimaryText,
    destructive: token.colorErrorText,
    success: token.colorSuccessText,
    info: token.colorInfoText,
    warning: token.colorWarningText,
    "ansi-magenta": token.magenta8,
    "ansi-cyan": token.cyan8,
    "log-background": token.colorFillAlter,
    "log-foreground": token.colorText,
  };
}

// A reader may explicitly choose a light log panel inside a dark console.
export const lightLogVariables = Object.fromEntries(
  Object.entries(layoutThemeAliases(theme.getDesignToken(lightTheme))).map(([name, value]) => [
    `--${name}`,
    value,
  ]),
) as CSSProperties;
