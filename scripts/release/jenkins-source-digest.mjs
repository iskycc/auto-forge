import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function jenkinsSourceDigest(root) {
  const digest = createHash("sha256");
  async function visit(relative) {
    const entries = (await readdir(join(root, relative), { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    );
    for (const entry of entries) {
      if (entry.name === "target") continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        digest.update(path);
        digest.update("\0");
        digest.update(await readFile(join(root, path)));
        digest.update("\0");
      }
    }
  }
  await visit("integrations/jenkins");
  return digest.digest("hex");
}
