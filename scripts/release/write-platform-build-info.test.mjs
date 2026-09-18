import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { platformBuildInfo } from "./write-platform-build-info.mjs";

test("uses release inputs instead of the workspace package version", () => {
  assert.deepEqual(platformBuildInfo("1.17.8", "a".repeat(40), "2026-09-18T00:00:00Z"), {
    version: "1.17.8",
    kind: "release",
    revision: "a".repeat(40),
    createdAt: "2026-09-18T00:00:00.000Z",
  });
  assert.deepEqual(platformBuildInfo("dev", "unknown", "1970-01-01T00:00:00Z"), {
    version: "dev",
    kind: "development",
  });
});

test("rejects malformed release metadata", () => {
  assert.throws(() => platformBuildInfo("main", "abc", "today"));
  assert.throws(() => platformBuildInfo("1.17.8", "unknown", "2026-09-18T00:00:00Z"));
  assert.throws(() => platformBuildInfo("1.17.8", "a".repeat(40), "invalid"));
});

test("writes metadata into the build context independently of the calling directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "autoforge-build-info-"));
  try {
    await mkdir(join(root, "scripts/release"), { recursive: true });
    await mkdir(join(root, "apps/web/src/lib"), { recursive: true });
    const script = join(root, "scripts/release/write-platform-build-info.mjs");
    await copyFile("scripts/release/write-platform-build-info.mjs", script);
    const result = spawnSync(
      process.execPath,
      [script, "1.17.8", "b".repeat(40), "2026-09-18T00:00:00Z"],
      { cwd: tmpdir(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "apps/web/src/lib/platform-build-info.json"), "utf8")),
      {
        version: "1.17.8",
        kind: "release",
        revision: "b".repeat(40),
        createdAt: "2026-09-18T00:00:00.000Z",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("embeds the same immutable metadata before compiling the web application", async () => {
  const dockerfile = await readFile("deploy/docker/backend.Dockerfile", "utf8");
  const builder = dockerfile
    .split("FROM dependencies AS builder")[1]
    .split("FROM ${NODE_IMAGE} AS runtime")[0];
  assert.match(builder, /ARG VERSION=dev/);
  assert.match(builder, /ARG REVISION=unknown/);
  assert.match(builder, /ARG CREATED=/);
  assert.ok(
    builder.indexOf("write-platform-build-info.mjs") < builder.indexOf("@autoforge/web build"),
  );
  assert.match(
    builder,
    /write-platform-build-info\.mjs "\$\{VERSION\}" "\$\{REVISION\}" "\$\{CREATED\}"/,
  );
});
