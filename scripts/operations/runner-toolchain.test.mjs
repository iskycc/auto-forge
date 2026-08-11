import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { zipSync } from "fflate";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

test("builds a versioned amd64 Runner toolchain with internal integrity metadata", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-toolchain-"));
  const jdkDirectory = resolve(directory, "jdk");
  const classpathDirectory = resolve(directory, "classpath");
  const output = resolve(directory, "toolchain.tar.gz");
  const extracted = resolve(directory, "extracted");
  try {
    await mkdir(resolve(jdkDirectory, "bin"), { recursive: true });
    await mkdir(classpathDirectory);
    await mkdir(extracted);
    const elfHeader = Buffer.alloc(64);
    elfHeader.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    elfHeader.writeUInt16LE(62, 18);
    await writeFile(resolve(jdkDirectory, "bin/java"), elfHeader);
    await chmod(resolve(jdkDirectory, "bin/java"), 0o755);
    await writeFile(
      resolve(classpathDirectory, "testng-7.11.0.jar"),
      zipSync({
        "META-INF/MANIFEST.MF": new TextEncoder().encode("Manifest-Version: 1.0\n"),
      }),
    );

    await execute(
      "bash",
      [
        "scripts/operations/build-runner-toolchain.sh",
        "--jdk-dir",
        jdkDirectory,
        "--classpath-dir",
        classpathDirectory,
        "--java-version",
        "21.0.8",
        "--testng-version",
        "7.11.0",
        "--architecture",
        "amd64",
        "--output",
        output,
      ],
      { cwd: repositoryRoot, env: { ...process.env, SOURCE_DATE_EPOCH: "1786233600" } },
    );
    await execute("tar", ["-xzf", output, "-C", extracted]);
    const root = resolve(extracted, "autoforge-runner-toolchain");
    const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      platform: "linux",
      architecture: "amd64",
      javaVersion: "21.0.8",
      testNgVersion: "7.11.0",
      javaExecutable: "jdk/bin/java",
      classpathGlob: "lib/*.jar",
      fileIntegrityManifest: "file-sha256sums",
      runtimeDownloadsAllowed: false,
    });
    await execute("sha256sum", ["--check", "--strict", "file-sha256sums"], { cwd: root });
    await execute("sha256sum", ["--check", "--strict", `${output}.sha256`], {
      cwd: directory,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a JDK whose ELF architecture does not match the declared asset", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-toolchain-arch-"));
  const jdkDirectory = resolve(directory, "jdk");
  const classpathDirectory = resolve(directory, "classpath");
  try {
    await mkdir(resolve(jdkDirectory, "bin"), { recursive: true });
    await mkdir(classpathDirectory);
    const arm64Elf = Buffer.alloc(64);
    arm64Elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    arm64Elf.writeUInt16LE(183, 18);
    await writeFile(resolve(jdkDirectory, "bin/java"), arm64Elf);
    await chmod(resolve(jdkDirectory, "bin/java"), 0o755);
    await writeFile(
      resolve(classpathDirectory, "testng.jar"),
      zipSync({ fixture: new Uint8Array() }),
    );

    await assert.rejects(
      execute(
        "bash",
        [
          "scripts/operations/build-runner-toolchain.sh",
          "--jdk-dir",
          jdkDirectory,
          "--classpath-dir",
          classpathDirectory,
          "--java-version",
          "21",
          "--architecture",
          "amd64",
          "--output",
          resolve(directory, "invalid.tar.gz"),
        ],
        { cwd: repositoryRoot },
      ),
      /does not match/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
