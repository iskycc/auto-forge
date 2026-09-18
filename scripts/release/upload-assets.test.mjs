import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const uploadScript = resolve(import.meta.dirname, "upload-assets.sh");

async function uploadFixture(context, mode, assetNames = ["first artifact.tar", "second.tar"]) {
  const directory = await mkdtemp(resolve(tmpdir(), "autoforge-upload-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binaries = resolve(directory, "bin");
  const assets = resolve(directory, "assets");
  const statePath = resolve(directory, "calls.json");
  await mkdir(binaries);
  await mkdir(assets);
  await writeFile(statePath, JSON.stringify({ uploads: [], timeouts: [], sleeps: [] }));
  for (const name of assetNames) await writeFile(resolve(assets, name), "fixture");
  const mock = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.AUTOFORGE_UPLOAD_TEST_STATE;
const state = JSON.parse(fs.readFileSync(statePath));
if (command === "timeout") {
  state.timeouts.push(args.slice(0, 3));
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (process.env.AUTOFORGE_UPLOAD_TEST_MODE === "timeout") process.exit(124);
  const child = spawnSync(args[2], args.slice(3), { stdio: "inherit", env: process.env });
  process.exit(child.status ?? 1);
}
if (command === "sleep") {
  state.sleeps.push(args[0]);
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
state.uploads.push(args);
fs.writeFileSync(statePath, JSON.stringify(state));
const attempt = state.uploads.filter(call => call[3] === args[3]).length;
if (process.env.AUTOFORGE_UPLOAD_TEST_MODE === "permanent" ||
    (process.env.AUTOFORGE_UPLOAD_TEST_MODE === "transient" && attempt === 1)) {
  process.stderr.write("simulated HTTP 500\\n");
  process.exit(1);
}
`;
  for (const command of ["gh", "timeout", "sleep"])
    await writeFile(resolve(binaries, command), mock, { mode: 0o755 });
  return {
    run: (tag = "v1.17.8") =>
      execute("bash", [uploadScript, tag, assets], {
        env: {
          ...process.env,
          PATH: `${binaries}:${process.env.PATH}`,
          AUTOFORGE_UPLOAD_TEST_STATE: statePath,
          AUTOFORGE_UPLOAD_TEST_MODE: mode,
        },
      }),
    calls: async () => JSON.parse(await readFile(statePath, "utf8")),
  };
}

test("retries transient asset failures and preserves filenames with spaces", async (context) => {
  const fixture = await uploadFixture(context, "transient");
  await fixture.run();
  const calls = await fixture.calls();
  assert.equal(calls.uploads.length, 4);
  assert.deepEqual(calls.sleeps, ["5", "5"]);
  assert(
    calls.uploads.every(
      (call) =>
        call[0] === "release" &&
        call[1] === "upload" &&
        call[2] === "v1.17.8" &&
        call[4] === "--clobber",
    ),
  );
  assert.match(calls.uploads[0][3], /first artifact\.tar$/);
  assert(
    calls.timeouts.every(
      (call) => JSON.stringify(call) === JSON.stringify(["--kill-after=10s", "180s", "gh"]),
    ),
  );
});

test("stops after three failures without attempting later assets", async (context) => {
  const fixture = await uploadFixture(context, "permanent");
  await assert.rejects(
    fixture.run(),
    (error) => error.code === 1 && /first artifact\.tar/.test(error.stderr),
  );
  const calls = await fixture.calls();
  assert.equal(calls.uploads.length, 3);
  assert(calls.uploads.every((call) => /first artifact\.tar$/.test(call[3])));
  assert.deepEqual(calls.sleeps, ["5", "10"]);
});

test("bounds timeouts to three attempts", async (context) => {
  const fixture = await uploadFixture(context, "timeout");
  await assert.rejects(fixture.run());
  const calls = await fixture.calls();
  assert.equal(calls.timeouts.length, 3);
  assert.deepEqual(calls.sleeps, ["5", "10"]);
});

test("rejects an empty asset directory before contacting GitHub", async (context) => {
  const fixture = await uploadFixture(context, "success", []);
  await assert.rejects(fixture.run());
  assert.deepEqual((await fixture.calls()).uploads, []);
});
