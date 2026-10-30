import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { logViewerSourceDigest } from "./log-viewer-resources.mjs";

test("shared ANSI, theme and log presentation changes invalidate embedded viewer resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "viewer-source-digest-"));
  try {
    // Copy only source inputs read by the digest, never mutate the working tree.
    for (const path of [
      "apps/log-archive-viewer",
      "apps/web/src/archive-viewer",
      "apps/web/src/lib",
      "apps/web/src/components/ui/semantic-status-tag.tsx",
      "apps/web/src/components/ui/use-reduced-motion.ts",
      "apps/web/server/build-log-archive-ui.mjs",
      "scripts/release/build-log-archive-viewer-resources.sh",
      "scripts/release/create-log-viewer-manifest.mjs",
      "scripts/release/log-viewer-resources.mjs",
      "LICENSE",
      "docs/licenses/ant-design-icons.txt",
      "pnpm-lock.yaml",
    ]) {
      await cp(resolve(path), join(root, path), { recursive: true });
    }
    const before = await logViewerSourceDigest(root);
    for (const path of [
      "safe-ansi.ts",
      "log-levels.ts",
      "log-presentation.ts",
      "ant-design-theme.ts",
    ]) {
      const filename = join(root, "apps/web/src/lib", path);
      const original = await readFile(filename, "utf8");
      await writeFile(filename, original + "\n// fixture source change\n");
      assert.notEqual(await logViewerSourceDigest(root), before, path);
      await writeFile(filename, original);
    }
    const generated = join(root, "apps/log-archive-viewer/cmd/viewer/assets/viewer.js");
    await writeFile(generated, "generated bundle bytes are verified by manifest separately");
    assert.equal(await logViewerSourceDigest(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
