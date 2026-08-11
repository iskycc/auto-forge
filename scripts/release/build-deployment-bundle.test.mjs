import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("builds a versioned deployment bundle with both Compose modes", async () => {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-deploy-output-"));
  const extractedDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-deploy-extract-"));
  try {
    await execute(
      "bash",
      ["scripts/release/build-deployment-bundle.sh", "1.2.3", outputDirectory],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        env: { ...process.env, SOURCE_DATE_EPOCH: "1786233600" },
      },
    );
    const archivePath = resolve(outputDirectory, "autoforge-deploy-1.2.3.tar.gz");
    await execute("tar", ["-xzf", archivePath, "-C", extractedDirectory]);

    const packageDirectory = resolve(extractedDirectory, "autoforge-deploy-1.2.3");
    const liteCompose = await readFile(
      resolve(packageDirectory, "lite/docker-compose.yml"),
      "utf8",
    );
    const fullCompose = await readFile(
      resolve(packageDirectory, "full/docker-compose.yml"),
      "utf8",
    );
    assert.doesNotMatch(liteCompose, /AUTOFORGE_MODE|AUTOFORGE_MASTER_KEY/);
    assert.doesNotMatch(fullCompose, /AUTOFORGE_DATABASE_URL|AUTOFORGE_MASTER_KEY/);
    assert.match(fullCompose, /POSTGRES_PASSWORD_FILE/);
    assert.match(fullCompose, /--data-dir=\/var\/lib\/autoforge/);
    assert.match(
      await readFile(resolve(packageDirectory, "lite/.env.example"), "utf8"),
      /autoforge\/backend:1\.2\.3-amd64/,
    );
    assert.equal(await readFile(resolve(packageDirectory, "VERSION"), "utf8"), "1.2.3\n");
    assert.match(
      await readFile(resolve(packageDirectory, "release-signing-public-key.pem"), "utf8"),
      /BEGIN PUBLIC KEY/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "operations/lite-backup.sh"), "utf8"),
      /--platform-stopped/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "operations/migrate.sh"), "utf8"),
      /migrate\.js/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "docs/manuals/administrator.md"), "utf8"),
      /备份与恢复/,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await rm(extractedDirectory, { recursive: true, force: true });
  }
});
