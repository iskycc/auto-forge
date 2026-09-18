import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { collectReleaseDiagnostics } from "./collect-release-diagnostics.mjs";
import { spawnSync } from "node:child_process";

test("Release failure evidence preserves OOM and request context while redacting bootstrap secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-"));
  try {
    await mkdir(join(root, "current-data/config"), { recursive: true });
    await writeFile(
      join(root, "current-data/config/platform.json"),
      JSON.stringify({ secrets: { adminBootstrapToken: "sensitive-bootstrap" } }),
    );
    const destination = join(root, "evidence");
    const calls = [];
    await collectReleaseDiagnostics(
      { source: root, destination, exitStatus: 1, containers: ["platform", "removed"] },
      (args) => {
        calls.push(args);
        if (args.at(-1) === "removed") throw new Error("No such container");
        if (args[0] === "logs")
          return 'bootstrap sensitive-bootstrap\n{"requestId":"request-1","message":"HTTP request completed"}\n';
        return JSON.stringify({
          Status: "exited",
          ExitCode: 137,
          OOMKilled: true,
          Health: { Status: "unhealthy", Log: [{ Output: "sensitive-health" }] },
          Env: ["sensitive-env"],
        });
      },
    );
    const summaryText = await readFile(join(destination, "fixture.json"), "utf8");
    const summary = JSON.parse(summaryText);
    assert.equal(summary.exitStatus, 1);
    assert.deepEqual(summary.containers[0].state, {
      status: "exited",
      exitCode: 137,
      oomKilled: true,
      health: "unhealthy",
    });
    assert.equal(summary.containers[1].stateUnavailable, true);
    assert.doesNotMatch(summaryText, /sensitive/);
    const logs = await readFile(join(destination, "current.log"), "utf8");
    assert.doesNotMatch(logs, /sensitive-bootstrap/);
    assert.match(logs, /\[REDACTED\]/);
    assert.match(logs, /request-1/);
    assert.deepEqual(
      calls.find((args) => args[0] === "logs"),
      ["logs", "--timestamps", "--tail", "400", "platform"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable secret configuration omits raw logs and still records container state", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-"));
  try {
    await mkdir(join(root, "current-data/config"), { recursive: true });
    await writeFile(join(root, "current-data/config/platform.json"), "broken configuration");
    const destination = join(root, "evidence");
    await collectReleaseDiagnostics(
      { source: root, destination, exitStatus: 1, containers: ["platform"] },
      (args) => {
        assert.equal(args[0], "inspect");
        return JSON.stringify({ Status: "running", ExitCode: 0, OOMKilled: false });
      },
    );
    assert.deepEqual(await readdir(destination), ["fixture.json"]);
    const summary = JSON.parse(await readFile(join(destination, "fixture.json"), "utf8"));
    assert.match(summary.containers[0].logsOmitted, /redaction/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI captures both Docker output streams without exporting secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-cli-"));
  try {
    await mkdir(join(root, "current-data/config"), { recursive: true });
    await writeFile(
      join(root, "current-data/config/platform.json"),
      JSON.stringify({ secrets: { adminBootstrapToken: "cli-bootstrap-secret" } }),
    );
    const binaries = join(root, "bin");
    await mkdir(binaries);
    await writeFile(
      join(binaries, "docker"),
      `#!/usr/bin/env node
if (process.argv[2] === 'inspect') process.stdout.write(JSON.stringify({Status:'exited', ExitCode:1, OOMKilled:false}));
else { process.stdout.write('HTTP request completed\\n'); process.stderr.write('server failure cli-bootstrap-secret\\n'); }
`,
      { mode: 0o755 },
    );
    const destination = join(root, "evidence");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/quality/collect-release-diagnostics.mjs",
        root,
        destination,
        "42",
        "current",
        "previous",
        "restored",
        "rollback",
        "upgraded",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binaries}:${process.env.PATH}` },
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(await readFile(join(destination, "fixture.json"), "utf8"));
    assert.equal(summary.exitStatus, 42);
    const logs = await readFile(join(destination, "current.log"), "utf8");
    assert.match(logs, /HTTP request completed/);
    assert.match(logs, /server failure \[REDACTED\]/);
    assert.doesNotMatch(logs, /cli-bootstrap-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
