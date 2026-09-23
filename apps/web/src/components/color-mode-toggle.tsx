"use client";

import { Moon, Sun } from "lucide-react";
import { useColorMode } from "./ant-design-provider";
import { Button } from "./ui";
import { uiPatterns } from "./ui/patterns";

export function ColorModeToggle() {
  const { colorMode, setColorMode } = useColorMode();
  const label = colorMode === "dark" ? "切换到浅色模式" : "切换到深色模式";
  return (
    <Button
      aria-label={label}
      title={label}
      className={uiPatterns["icon-button"]}
      onClick={() => setColorMode(colorMode === "dark" ? "light" : "dark")}
      type="button"
    >
      {colorMode === "dark" ? (
        <Sun size={18} aria-hidden="true" />
      ) : (
        <Moon size={18} aria-hidden="true" />
      )}
    </Button>
  );
}
