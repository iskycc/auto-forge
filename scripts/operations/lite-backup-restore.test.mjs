import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("creates, verifies and restores a stopped Lite data set", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "autoforge-backup-test-"));
  const data = resolve(root, "data");
  const restored = resolve(root, "restored");
  const backup = resolve(root, "backup.tar.gz");
  try {
    await mkdir(resolve(data, "config"), { recursive: true });
    await mkdir(resolve(data, "db"), { recursive: true });
    await mkdir(resolve(data, "objects/projects/project-1"), { recursive: true });
    await writeFile(
      resolve(data, "config/platform.json"),
      `${JSON.stringify({ schemaVersion: 1, revision: 7, mode: "lite" })}\n`,
      { mode: 0o600 },
    );
    await writeFile(resolve(data, "db/autoforge.sqlite"), "sqlite-fixture");
    await writeFile(resolve(data, "objects/projects/project-1/object"), "object-fixture");

    await execute("bash", [
      "scripts/operations/lite-backup.sh",
      "--data-dir",
      data,
      "--output",
      backup,
      "--platform-stopped",
    ]);
    await execute("bash", [
      "scripts/operations/lite-restore.sh",
      "--input",
      backup,
      "--data-dir",
      restored,
      "--platform-stopped",
    ]);

    assert.equal(
      await readFile(resolve(restored, "db/autoforge.sqlite"), "utf8"),
      "sqlite-fixture",
    );
    assert.equal(
      await readFile(resolve(restored, "objects/projects/project-1/object"), "utf8"),
      "object-fixture",
    );
    await assert.rejects(
      execute("bash", [
        "scripts/operations/lite-restore.sh",
        "--input",
        backup,
        "--data-dir",
        restored,
        "--platform-stopped",
      ]),
      /must not exist or must be empty/,
    );

    const tamperedDirectory = resolve(root, "tampered");
    const tamperedBackup = resolve(root, "tampered.tar.gz");
    const tamperedRestore = resolve(root, "tampered-restore");
    await mkdir(tamperedDirectory);
    await execute("tar", ["-xzf", backup, "-C", tamperedDirectory]);
    await writeFile(
      resolve(tamperedDirectory, "autoforge-lite-backup/data/objects/projects/project-1/object"),
      "tampered-object",
    );
    await execute("tar", [
      "-czf",
      tamperedBackup,
      "-C",
      tamperedDirectory,
      "autoforge-lite-backup",
    ]);
    const checksum = await execute("sha256sum", [tamperedBackup]);
    await writeFile(
      `${tamperedBackup}.sha256`,
      checksum.stdout.replace(tamperedBackup, "tampered.tar.gz"),
    );
    await assert.rejects(
      execute("bash", [
        "scripts/operations/lite-restore.sh",
        "--input",
        tamperedBackup,
        "--data-dir",
        tamperedRestore,
        "--platform-stopped",
      ]),
      /checksum did NOT match/,
    );

    const copiedBackup = resolve(root, "copied.tar.gz");
    await copyFile(backup, copiedBackup);
    await assert.rejects(
      execute("bash", [
        "scripts/operations/lite-restore.sh",
        "--input",
        copiedBackup,
        "--data-dir",
        resolve(root, "missing-checksum-restore"),
        "--platform-stopped",
      ]),
      /archive or its \.sha256 file is missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
