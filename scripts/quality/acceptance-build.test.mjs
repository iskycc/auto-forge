import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  sealAcceptanceBuild,
  verifyAcceptanceBuild,
  packAcceptanceBuild,
} from "./acceptance-build.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acceptance-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "--quiet");
  await writeFile(join(root, ".gitignore"), "apps/\nresources/\n.acceptance-build/\n");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  for (const name of [
    "apps/web/.next/BUILD_ID",
    "apps/web/.next/server/app-paths-manifest.json",
    "apps/web/dist-server/server/index.js",
    "apps/web/dist-server/server/work-thread.js",
    "apps/worker/dist/worker.mjs",
    "resources/agents/manifest.json",
    "resources/jenkins/manifest.json",
    "resources/log-archive-viewer/manifest.json",
  ]) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), "verified fixture\n");
  }
  return { root, git };
}

test("reuses only complete outputs bound to the exact source and toolchain", async (t) => {
  const { root } = await fixture(t);
  await sealAcceptanceBuild(root);
  await verifyAcceptanceBuild(root, "web");
  await verifyAcceptanceBuild(root, "worker");
  await writeFile(join(root, "pnpm-lock.yaml"), "changed dependency\n");
  await assert.rejects(verifyAcceptanceBuild(root, "web"), /source/);
});

test("rejects changed commit, runtime, missing files and corrupted build bytes", async (t) => {
  const { root, git } = await fixture(t);
  await sealAcceptanceBuild(root);
  const manifestPath = join(root, ".acceptance-build/manifest.json");
  const original = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify({ ...original, runtime: { ...original.runtime, node: "0.0.0" } }),
  );
  await assert.rejects(verifyAcceptanceBuild(root, "web"), /runtime/);
  await writeFile(manifestPath, JSON.stringify(original));
  const output = join(root, "apps/web/.next/BUILD_ID");
  await writeFile(output, "corrupted");
  await assert.rejects(verifyAcceptanceBuild(root, "web"), /BUILD_ID/);
  await rm(output);
  await assert.rejects(verifyAcceptanceBuild(root, "web"), /BUILD_ID/);
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "new source",
  );
  await assert.rejects(verifyAcceptanceBuild(root, "worker"), /revision/);
});

test("artifact excludes the Next cache and development output, preserving runtime outputs", async (t) => {
  const { root } = await fixture(t);
  for (const suffix of ["cache/large-cache", "dev/development-file"]) {
    await mkdir(join(root, "apps/web/.next", suffix, ".."), { recursive: true });
    await writeFile(join(root, "apps/web/.next", suffix), "do not upload");
  }
  await sealAcceptanceBuild(root);
  const archive = await packAcceptanceBuild(root);
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(listing, /apps\/web\/.next\/BUILD_ID/);
  assert.match(listing, /apps\/worker\/dist\/worker.mjs/);
  assert.doesNotMatch(listing, /cache|development-file/);
});

test("does not accept a manifest with omitted mandatory outputs", async (t) => {
  const { root } = await fixture(t);
  await sealAcceptanceBuild(root);
  const path = join(root, ".acceptance-build/manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.files = manifest.files.filter((entry) => !entry.path.endsWith("BUILD_ID"));
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(verifyAcceptanceBuild(root, "web"), /BUILD_ID/);
});

test("exports the actual image outputs, replaces stale files and cleans up the temporary container", async (t) => {
  const { root, git } = await fixture(t);
  const imageFiles = join(root, "image-files");
  for (const name of ["apps", "resources"])
    await cp(join(root, name), join(imageFiles, name), { recursive: true });
  await writeFile(join(root, "apps/web/.next/stale.js"), "stale output");
  await mkdir(join(root, "scripts/quality"), { recursive: true });
  await cp(
    resolve("scripts/quality/acceptance-build.mjs"),
    join(root, "scripts/quality/acceptance-build.mjs"),
  );
  const binaryDirectory = join(root, "bin");
  await mkdir(binaryDirectory);
  const docker = join(binaryDirectory, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_CALLS, args[0] + "\\n");
if (args[0] === "image") process.stdout.write(process.env.FIXTURE_REVISION);
else if (args[0] === "create") process.stdout.write("fixture-container");
else if (args[0] === "cp") fs.cpSync(path.join(process.env.FIXTURE_IMAGE, args[1].split(":/app/")[1]), args[2], { recursive: true });
else if (args[0] !== "rm") process.exit(1);
`,
  );
  await chmod(docker, 0o755);
  const env = {
    ...process.env,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    FIXTURE_IMAGE: imageFiles,
    FIXTURE_CALLS: join(root, "calls"),
    FIXTURE_REVISION: git("rev-parse", "HEAD").toString().trim(),
  };
  const script = resolve("scripts/quality/extract-release-acceptance-build.sh");
  assert.throws(
    () =>
      execFileSync("bash", [script, "fixture:wrong"], {
        cwd: root,
        env: { ...env, FIXTURE_REVISION: "0".repeat(40) },
        stdio: "pipe",
      }),
    /Command failed/,
  );
  assert.equal(await readFile(env.FIXTURE_CALLS, "utf8"), "image\n");
  execFileSync("bash", [script, "fixture:current"], { cwd: root, env, stdio: "pipe" });
  await assert.rejects(readFile(join(root, "apps/web/.next/stale.js")), /ENOENT/);
  await verifyAcceptanceBuild(root, "all");
  assert.match(await readFile(env.FIXTURE_CALLS, "utf8"), /create[\s\S]*rm\n$/);
});
