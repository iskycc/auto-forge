import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [source, destination, exitStatus] = process.argv.slice(2);
if (!source || !destination) throw new Error("Expected fixture and evidence directories.");
await mkdir(join(destination, "services"), { recursive: true });
const secrets = [];
for (const directory of ["platform-data", "platform-replica-data"]) {
  try {
    const configuration = JSON.parse(
      await readFile(join(source, directory, "config/platform.json"), "utf8"),
    );
    secrets.push(...Object.values(configuration.secrets ?? {}));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
for (const name of [
  "web-build",
  "web",
  "web-replica",
  "worker",
  "worker-replica",
  "nats",
  "minio",
  "minio-proxy",
  "fault-controller",
]) {
  try {
    let log = (await readFile(join(source, `${name}.log`), "utf8"))
      .split("\n")
      .slice(-400)
      .join("\n");
    for (const secret of secrets) {
      if (typeof secret === "string" && secret.length >= 8)
        log = log.split(secret).join("[REDACTED]");
    }
    await writeFile(join(destination, "services", `${name}.log`), log);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await writeFile(
  join(destination, "fixture.json"),
  JSON.stringify({ exitStatus: Number(exitStatus), collectedAt: new Date().toISOString() }),
);
