import { theme } from "antd";
import { describe, expect, it } from "vitest";
import { layoutThemeAliases, platformThemes } from "./ant-design-theme";

describe("platform theme readability", () => {
  for (const mode of ["light", "dark"] as const) {
    it(`${mode} keeps status and ANSI text readable on cards, logs and popovers`, () => {
      const colors = layoutThemeAliases(theme.getDesignToken(platformThemes[mode]));
      for (const foreground of [
        "foreground",
        "muted-foreground",
        "primary-text",
        "success",
        "destructive",
        "info",
        "warning",
        "ansi-magenta",
        "ansi-cyan",
      ] as const) {
        for (const background of ["card", "muted", "popover"] as const) {
          expect(
            contrast(colors[foreground], colors[background]),
            `${foreground} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(colors["primary-foreground"], colors.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.ring, colors.card)).toBeGreaterThanOrEqual(3);
    });
  }
});

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const rgb =
      hex.length === 4 ? [...hex.slice(1)].map((digit) => digit.repeat(2)).join("") : hex.slice(1);
    const channels = rgb.match(/.{2}/gu)!.map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}
