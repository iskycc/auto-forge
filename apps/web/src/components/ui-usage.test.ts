import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_PRIMITIVE = join(SOURCE_ROOT, "components", "ui.tsx");
const NATIVE_CONTROL = /<(?:button|input|select|textarea)\b/;

describe("shared UI controls", () => {
  it("keeps native form controls inside the shared component boundary", () => {
    const violations = typescriptReactFiles(SOURCE_ROOT)
      .filter((file) => file !== UI_PRIMITIVE)
      .filter((file) => NATIVE_CONTROL.test(readFileSync(file, "utf8")))
      .map((file) => relative(SOURCE_ROOT, file));

    expect(violations).toEqual([]);
  });
});

function typescriptReactFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptReactFiles(path);
    return entry.isFile() && extname(entry.name) === ".tsx" ? [path] : [];
  });
}
