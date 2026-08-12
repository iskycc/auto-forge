import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_PRIMITIVE = join(SOURCE_ROOT, "components", "ui.tsx");
const GLOBAL_STYLES = join(SOURCE_ROOT, "app", "globals.css");
const NATIVE_CONTROL = /<(?:button|input|select|textarea)\b/;
const MINIMUM_READABLE_FONT_SIZE_PX = 12;
const REQUIRED_LAYOUT_CLASSES = [
  "content-card",
  "settings-page-header",
  "settings-tabs",
  "environment-manager-grid",
  "environment-detail-panel",
  "secret-manager-grid",
] as const;

describe("shared UI controls", () => {
  it("keeps native form controls inside the shared component boundary", () => {
    const violations = typescriptReactFiles(SOURCE_ROOT)
      .filter((file) => file !== UI_PRIMITIVE)
      .filter((file) => NATIVE_CONTROL.test(readFileSync(file, "utf8")))
      .map((file) => relative(SOURCE_ROOT, file));

    expect(violations).toEqual([]);
  });

  it("keeps explicit UI text at the documented readable size", () => {
    const stylesheet = readFileSync(GLOBAL_STYLES, "utf8");
    const undersizedDeclarations = [...stylesheet.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)]
      .map((match) => ({
        declaration: match[0],
        pixels: Number(match[1]) * (match[2] === "rem" ? 14 : 1),
      }))
      .filter(({ pixels }) => pixels > 0 && pixels < MINIMUM_READABLE_FONT_SIZE_PX);

    expect(undersizedDeclarations).toEqual([]);
  });

  it("defines structural styles for shared settings layouts", () => {
    const stylesheet = readFileSync(GLOBAL_STYLES, "utf8");
    const missingClasses = REQUIRED_LAYOUT_CLASSES.filter(
      (className) => !stylesheet.includes(`.${className}`),
    );

    expect(missingClasses).toEqual([]);
  });

  it("keeps the focus indicator on the control instead of outlining its whole label", () => {
    const stylesheet = readFileSync(GLOBAL_STYLES, "utf8");

    expect(stylesheet).not.toContain("label:focus-within");
    expect(stylesheet).not.toMatch(/(?:input|select|textarea):focus-visible/);
    expect(stylesheet).toContain(".ui-input:focus");
  });
});

function typescriptReactFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptReactFiles(path);
    return entry.isFile() && extname(entry.name) === ".tsx" ? [path] : [];
  });
}
