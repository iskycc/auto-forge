import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");

test("signs and verifies a release checksum list with Ed25519", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-signature-"));
  const privateKey = resolve(directory, "private.pem");
  const publicKey = resolve(directory, "public.pem");
  const checksums = resolve(directory, "SHA256SUMS");
  const signature = resolve(directory, "SHA256SUMS.sig");

  try {
    await execute("openssl", ["genpkey", "-algorithm", "ED25519", "-out", privateKey]);
    await execute("openssl", ["pkey", "-in", privateKey, "-pubout", "-out", publicKey]);
    await writeFile(checksums, `${"a".repeat(64)}  artifact.tar.zst\n`);

    await execute(
      "bash",
      ["scripts/release/sign-checksums.sh", privateKey, checksums, signature, publicKey],
      { cwd: repositoryRoot },
    );
    await execute("openssl", [
      "pkeyutl",
      "-verify",
      "-rawin",
      "-pubin",
      "-inkey",
      publicKey,
      "-sigfile",
      signature,
      "-in",
      checksums,
    ]);

    await writeFile(checksums, `${"b".repeat(64)}  artifact.tar.zst\n`);
    await assert.rejects(
      execute("openssl", [
        "pkeyutl",
        "-verify",
        "-rawin",
        "-pubin",
        "-inkey",
        publicKey,
        "-sigfile",
        signature,
        "-in",
        checksums,
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
