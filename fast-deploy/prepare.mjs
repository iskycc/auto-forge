import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const templatesDirectory = import.meta.dirname;
const portDefaults = {
  HTTP_PORT: 3000,
  POSTGRES_PORT: 5432,
  REDIS_PORT: 6379,
  NATS_PORT: 4222,
  MINIO_PORT: 9000,
  LOG_POSTGRES_PORT: 5433,
};
const imageNames = {
  POSTGRES_IMAGE: "autoforge/offline-postgres:15-alpine",
  REDIS_IMAGE: "autoforge/offline-redis:7-alpine",
  NATS_IMAGE: "autoforge/offline-nats:2.14.3-alpine3.22",
  MINIO_IMAGE: "autoforge/offline-minio:RELEASE.2025-04-22T22-12-26Z",
  MINIO_CLIENT_IMAGE: "autoforge/offline-minio-client:RELEASE.2025-04-16T18-13-26Z",
};

function deploymentSettings(file) {
  const allowed = new Set([
    "NODE_A_IP",
    "NODE_B_IP",
    "NODE_C_IP",
    "AUTOFORGE_VERSION",
    "ARCH",
    "BACKEND_IMAGE",
    "PUBLIC_BASE_URL",
    "RUNNER_BASE_URL",
    ...Object.keys(portDefaults),
    ...Object.keys(imageNames),
  ]);
  const settings = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !allowed.has(match[1]))
      throw new Error(
        "Unknown or invalid deployment setting; use KEY=value without shell expressions.",
      );
    const [, key, value] = match;
    if (Object.hasOwn(settings, key)) throw new Error(`Duplicate setting: ${key}`);
    settings[key] = value.trim();
  }
  for (const key of ["NODE_A_IP", "NODE_B_IP", "NODE_C_IP"])
    if (isIP(settings[key] ?? "") !== 4)
      throw new Error(`${key} must be this host's private IPv4 address.`);
  if (!/^\d+\.\d+\.\d+$/u.test(settings.AUTOFORGE_VERSION ?? ""))
    throw new Error("AUTOFORGE_VERSION must be a loaded release such as 1.21.4.");
  if (!["amd64", "arm64"].includes(settings.ARCH)) throw new Error("ARCH must be amd64 or arm64.");
  for (const [key, fallback] of Object.entries(portDefaults)) {
    const value = settings[key] ?? String(fallback);
    if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535)
      throw new Error(`${key} must be between 1 and 65535.`);
    settings[key] = String(Number(value));
  }
  for (const ports of [
    ["POSTGRES_PORT", "REDIS_PORT"],
    ["MINIO_PORT", "NATS_PORT", "LOG_POSTGRES_PORT"],
  ])
    if (new Set(ports.map((key) => settings[key])).size !== ports.length)
      throw new Error(`Ports on the same host must differ: ${ports.join(", ")}`);
  settings.BACKEND_IMAGE ??= `autoforge/backend:${settings.AUTOFORGE_VERSION}-${settings.ARCH}`;
  for (const [key, name] of Object.entries(imageNames))
    settings[key] ??= `${name}-${settings.ARCH}`;
  for (const key of ["BACKEND_IMAGE", ...Object.keys(imageNames)])
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]+$/u.test(settings[key]))
      throw new Error(`${key} must be a verified local image reference.`);
  settings.PUBLIC_BASE_URL ??= `http://${settings.NODE_A_IP}:${settings.HTTP_PORT}`;
  settings.RUNNER_BASE_URL ??= settings.PUBLIC_BASE_URL;
  for (const key of ["PUBLIC_BASE_URL", "RUNNER_BASE_URL"]) {
    const url = new URL(settings[key]);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(`${key} must be an HTTP(S) origin.`);
    settings[key] = url.origin;
  }
  return settings;
}

function writePrivate(directory, name, content) {
  const target = join(directory, name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { flag: "wx", mode: 0o600 });
}

function writeHost(output, role, values, secrets) {
  const directory = join(output, role);
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, source] of [
    ["docker-compose.yml", join(templatesDirectory, role, "docker-compose.yml")],
    ["deploy.sh", join(templatesDirectory, "deploy.sh")],
    ["README.md", join(templatesDirectory, "README.md")],
  ])
    writePrivate(directory, name, readFileSync(source));
  writePrivate(directory, "host-role", `${role}\n`);
  writePrivate(
    directory,
    ".env",
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  for (const [name, value] of Object.entries(secrets))
    writePrivate(directory, `secrets/${name}`, `${value}\n`);
  return directory;
}

export function prepareDeployment(configurationFile, outputDirectory) {
  const settings = deploymentSettings(configurationFile);
  const output = resolve(outputDirectory);
  if (existsSync(output))
    throw new Error(
      "Output already exists; keep its deployed passwords and configuration. Use a new directory for a new installation.",
    );
  const secret = () => randomBytes(32).toString("base64url");
  const postgresPassword = secret(),
    redisPassword = secret(),
    natsToken = secret();
  const minioPassword = secret(),
    logPostgresPassword = secret();
  mkdirSync(output, { mode: 0o700 });
  try {
    const platform = writeHost(
      output,
      "node-a",
      {
        SERVICE_BIND: settings.NODE_A_IP,
        HTTP_PORT: settings.HTTP_PORT,
        BACKEND_IMAGE: settings.BACKEND_IMAGE,
        WEB_CPUS: "0",
        WEB_MEMORY_LIMIT: "0",
        WORKER_CPUS: "0",
        WORKER_MEMORY_LIMIT: "0",
      },
      {},
    );
    writePrivate(
      platform,
      "initialize-platform.mjs",
      readFileSync(join(templatesDirectory, "initialize-platform.mjs")),
    );
    writeHost(
      output,
      "node-b",
      {
        SERVICE_BIND: settings.NODE_B_IP,
        POSTGRES_PORT: settings.POSTGRES_PORT,
        REDIS_PORT: settings.REDIS_PORT,
        POSTGRES_IMAGE: settings.POSTGRES_IMAGE,
        REDIS_IMAGE: settings.REDIS_IMAGE,
      },
      {
        "postgres-password": postgresPassword,
        "redis-password": redisPassword,
        "redis.conf": `bind 0.0.0.0\nprotected-mode yes\nrequirepass "${redisPassword}"\nappendonly yes\nsave 60 1\ndir /data`,
      },
    );
    writeHost(
      output,
      "node-c",
      {
        SERVICE_BIND: settings.NODE_C_IP,
        MINIO_PORT: settings.MINIO_PORT,
        NATS_PORT: settings.NATS_PORT,
        LOG_POSTGRES_PORT: settings.LOG_POSTGRES_PORT,
        MINIO_IMAGE: settings.MINIO_IMAGE,
        MINIO_CLIENT_IMAGE: settings.MINIO_CLIENT_IMAGE,
        NATS_IMAGE: settings.NATS_IMAGE,
        POSTGRES_IMAGE: settings.POSTGRES_IMAGE,
      },
      {
        "nats.conf": `jetstream { store_dir: "/data" }\nhttp_port: 8222\nauthorization { token: "${natsToken}" }`,
        "minio-root-user": "autoforge",
        "minio-root-password": minioPassword,
        "log-postgres-password": logPostgresPassword,
      },
    );
    writePrivate(
      platform,
      "setup-values.json",
      `${JSON.stringify(
        {
          publicBaseUrl: settings.PUBLIC_BASE_URL,
          runnerBaseUrl: settings.RUNNER_BASE_URL,
          full: {
            databaseUrl: `postgres://autoforge:${postgresPassword}@${settings.NODE_B_IP}:${settings.POSTGRES_PORT}/autoforge`,
            redisUrl: `redis://:${redisPassword}@${settings.NODE_B_IP}:${settings.REDIS_PORT}`,
            natsServers: [`nats://${settings.NODE_C_IP}:${settings.NATS_PORT}`],
            natsToken,
            minio: {
              endpoint: `http://${settings.NODE_C_IP}:${settings.MINIO_PORT}`,
              accessKey: "autoforge",
              secretKey: minioPassword,
              bucket: "autoforge-objects",
              region: "us-east-1",
            },
          },
          optionalLogDatabase: {
            host: settings.NODE_C_IP,
            port: Number(settings.LOG_POSTGRES_PORT),
            administrator: "autoforge_logs",
            password: logPostgresPassword,
            maintenanceDatabase: "postgres",
            prefix: "autoforge_logs",
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch (cause) {
    rmSync(output, { recursive: true, force: true });
    throw new Error("Could not prepare deployment files; no existing deployment was changed.", {
      cause,
    });
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [configurationFile = ".env", outputDirectory = "generated"] = process.argv.slice(2);
  const output = prepareDeployment(configurationFile, outputDirectory);
  process.stdout.write(
    `Prepared ${output}/node-a, node-b and node-c. Keep their private credentials; distribute each directory to its matching host.\n`,
  );
}
