"use client";

import { App, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { colorModeCookie, readBrowserColorMode, type ColorMode } from "@/lib/color-mode";
import { layoutThemeAliases, platformThemes } from "@/lib/ant-design-theme";

const ColorModeContext = createContext<{
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
} | null>(null);

export function useColorMode() {
  const context = useContext(ColorModeContext);
  if (!context) throw new Error("Color mode requires AntDesignProvider.");
  return context;
}

export function AntDesignProvider({
  children,
  initialColorMode = "light",
}: {
  children: ReactNode;
  initialColorMode?: ColorMode;
}) {
  const [colorMode, updateColorMode] = useState(initialColorMode);
  const setColorMode = useCallback((mode: ColorMode) => {
    document.cookie = colorModeCookie(mode, window.location.protocol === "https:");
    document.documentElement.dataset.colorMode = mode;
    updateColorMode(mode);
  }, []);
  useEffect(() => {
    const synchronizePreference = () => {
      const mode = readBrowserColorMode(document.cookie);
      document.documentElement.dataset.colorMode = mode;
      updateColorMode(mode);
    };
    window.addEventListener("focus", synchronizePreference);
    window.addEventListener("pageshow", synchronizePreference);
    return () => {
      window.removeEventListener("focus", synchronizePreference);
      window.removeEventListener("pageshow", synchronizePreference);
    };
  }, []);
  const preference = useMemo(() => ({ colorMode, setColorMode }), [colorMode, setColorMode]);
  return (
    <ColorModeContext value={preference}>
      <AntdRegistry>
        <ConfigProvider
          locale={zhCN}
          theme={platformThemes[colorMode]}
          button={{ autoInsertSpace: false }}
        >
          <LayoutThemeTokens colorMode={colorMode} />
          <App component={false}>{children}</App>
        </ConfigProvider>
      </AntdRegistry>
    </ColorModeContext>
  );
}

function LayoutThemeTokens({ colorMode }: { colorMode: ColorMode }) {
  const { token } = theme.useToken();
  return (
    <style data-autoforge-theme="antd">{`:root[data-color-mode] {color-scheme:${colorMode};${Object.entries(
      layoutThemeAliases(token),
    )
      .map(([name, value]) => `--${name}:${value};`)
      .join("")}}`}</style>
  );
}
