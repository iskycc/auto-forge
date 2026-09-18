import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const containerRoles = ["current", "previous", "restored", "rollback", "upgraded"];

function runDocker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new Error("Docker diagnostic command failed.", { cause: result.error });
  return args[0] === "logs" ? result.stdout + result.stderr : result.stdout;
}

export async function collectReleaseDiagnostics(
  { source, destination, exitStatus, containers },
  docker = runDocker,
) {
  await mkdir(destination, { recursive: true });
  const secrets = [];
  let secretsReadable = true;
  for (const directory of ["current-data", "previous-data", "restored-data", "rollback-data"]) {
    try {
      const configuration = JSON.parse(
        await readFile(join(source, directory, "config/platform.json"), "utf8"),
      );
      secrets.push(
        ...Object.values(configuration.secrets ?? {}).filter(
          (value) => typeof value === "string" && value.length > 0,
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT") secretsReadable = false;
    }
  }
  const redact = (text) =>
    secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
  const summary = { exitStatus, collectedAt: new Date().toISOString(), containers: [] };
  for (const [index, name] of containers.entries()) {
    const role = containerRoles[index];
    if (!role) throw new Error("Unexpected Release container role.");
    const report = { role, name };
    summary.containers.push(report);
    try {
      const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", name]));
      // Never export the full inspect result: Env and mounts can expose secrets.
      report.state = {
        status: state.Status,
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
        startedAt: state.StartedAt,
        finishedAt: state.FinishedAt,
        health: state.Health?.Status,
      };
    } catch {
      report.stateUnavailable = true;
      continue;
    }
    if (!secretsReadable || secrets.length === 0) {
      report.logsOmitted = "Platform secrets unavailable for redaction.";
      continue;
    }
    try {
      const logs = docker(["logs", "--timestamps", "--tail", "400", name]);
      await writeFile(join(destination, `${role}.log`), redact(logs));
    } catch {
      report.logsUnavailable = true;
    }
  }
  await writeFile(join(destination, "fixture.json"), JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination, exitStatus, ...containers] = process.argv.slice(2);
  if (
    !source ||
    !destination ||
    !/^\d+$/.test(exitStatus ?? "") ||
    containers.length !== containerRoles.length
  )
    throw new Error(
      "Expected fixture directory, evidence directory, exit status and five container names.",
    );
  await collectReleaseDiagnostics({
    source,
    destination,
    exitStatus: Number(exitStatus),
    containers,
  });
}
