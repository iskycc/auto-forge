import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const credentials = {
  POSTGRES_PASSWORD: "FixturePostgres-OnlyForTests-2026",
  LOG_POSTGRES_PASSWORD: "FixtureLogPostgres-OnlyForTests-2026",
  REDIS_PASSWORD: "FixtureRedis-OnlyForTests-2026",
  NATS_TOKEN: "FixtureNats-OnlyForTests-2026",
  MINIO_ROOT_PASSWORD: "FixtureMinio-OnlyForTests-2026",
};

async function compose(host, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-direct-compose-"));
  try {
    const source = resolve("fast-deploy", host);
    const example = await readFile(join(source, ".env.example"), "utf8");
    const values = { ...credentials, ...overrides };
    const environment = join(directory, ".env");
    const configured = example
      .split("\n")
      .map((line) => {
        const key = line.split("=", 1)[0];
        if (!Object.hasOwn(values, key)) return line;
        return values[key] === undefined ? undefined : `${key}=${values[key]}`;
      })
      .filter((line) => line !== undefined)
      .join("\n");
    await writeFile(environment, configured, { mode: 0o600 });
    const inherited = { ...process.env };
    for (const key of Object.keys(values)) delete inherited[key];
    const result = await execute(
      "docker",
      [
        "compose",
        "--project-directory",
        source,
        "--env-file",
        environment,
        "-f",
        join(source, "docker-compose.yml"),
        "config",
        "--format",
        "json",
      ],
      { env: inherited },
    );
    return JSON.parse(result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ships three host configurations and an independent amd64 log database without prerequisite scripts", async () => {
  const files = await readdir(resolve("fast-deploy"), { recursive: true });
  assert(!files.some((name) => /\.(sh|mjs)$/u.test(name)));
  for (const host of ["node-a", "node-b", "node-c", "log-postgres"]) {
    const specification = await compose(host);
    assert.equal(Object.keys(specification.volumes ?? {}).length, 0);
    for (const service of Object.values(specification.services)) {
      assert.equal(service.platform, "linux/amd64");
      assert.equal(service.pull_policy, "never");
      assert(service.image.endsWith("-amd64"));
      assert(!service.image.includes("latest"));
      for (const volume of service.volumes ?? []) assert.equal(volume.type, "bind");
    }
    const template = await readFile(resolve("fast-deploy", host, "docker-compose.yml"), "utf8");
    assert.doesNotMatch(template, /prepare\.sh|deploy\.sh|initialize-platform|ARCH|secrets:/u);
  }
});

test("explicitly passes the required PostgreSQL password and authenticated Redis settings", async () => {
  const { services } = await compose("node-b");
  assert.equal(services.postgres.environment.POSTGRES_PASSWORD, credentials.POSTGRES_PASSWORD);
  assert.equal(services.postgres.environment.POSTGRES_USER, "autoforge");
  assert(!Object.hasOwn(services.postgres.environment, "POSTGRES_HOST_AUTH_METHOD"));
  assert(!Object.hasOwn(services.postgres.environment, "POSTGRES_PASSWORD_FILE"));
  assert.equal(services.redis.environment.REDIS_PASSWORD, credentials.REDIS_PASSWORD);
  assert(services.redis.command[0].includes("--requirepass"));
  assert(!services.redis.command[0].includes(credentials.REDIS_PASSWORD));
});

test("rejects missing PostgreSQL and storage passwords before a container can start", async () => {
  for (const password of ["", undefined]) {
    await assert.rejects(compose("node-b", { POSTGRES_PASSWORD: password }), /POSTGRES_PASSWORD/u);
    await assert.rejects(
      compose("log-postgres", { LOG_POSTGRES_PASSWORD: password }),
      /LOG_POSTGRES_PASSWORD/u,
    );
    await assert.rejects(
      compose("node-c", { MINIO_ROOT_PASSWORD: password }),
      /MINIO_ROOT_PASSWORD/u,
    );
  }
});

test("isolates the daily log database from business data and supports a separate host or port", async () => {
  const logs = await compose("log-postgres");
  const business = await compose("node-b");
  assert.notEqual(logs.name, business.name);
  assert.deepEqual(Object.keys(logs.services), ["postgres"]);
  const { postgres } = logs.services;
  assert.equal(postgres.environment.POSTGRES_PASSWORD, credentials.LOG_POSTGRES_PASSWORD);
  assert.equal(postgres.environment.POSTGRES_USER, "autoforge_logs");
  assert.equal(postgres.environment.POSTGRES_DB, "postgres");
  assert(!Object.hasOwn(postgres.environment, "POSTGRES_HOST_AUTH_METHOD"));
  assert(!Object.hasOwn(postgres.environment, "POSTGRES_PASSWORD_FILE"));
  assert.equal(postgres.ports[0].published, "5433");
  assert.equal(postgres.volumes[0].source, resolve("fast-deploy/log-postgres/data/postgres"));
  assert.equal(postgres.volumes[0].bind.create_host_path, false);
  const custom = await compose("log-postgres", {
    SERVICE_BIND: "127.0.0.1",
    LOG_POSTGRES_PORT: "15433",
  });
  assert.equal(custom.services.postgres.ports[0].host_ip, "127.0.0.1");
  assert.equal(custom.services.postgres.ports[0].published, "15433");
});

test("uses the same MinIO credentials for its server and bucket initialization", async () => {
  const { services } = await compose("node-c");
  for (const service of [services.minio, services["minio-init"]]) {
    assert.equal(service.environment.MINIO_ROOT_PASSWORD, credentials.MINIO_ROOT_PASSWORD);
    assert.equal(service.environment.MINIO_ROOT_USER, "autoforge");
  }
  const index = services.nats.command.indexOf("--auth");
  assert.equal(services.nats.command[index + 1], credentials.NATS_TOKEN);
  assert.equal(services["minio-init"].depends_on.minio.condition, "service_healthy");
});

test("PostgreSQL healthcheck atomically reports its own data filesystem and keeps readiness independent from sampling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-pg-sample-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const ready = join(bin, "pg_isready");
    await writeFile(ready, "#!/bin/sh\nexit 0\n");
    await chmod(ready, 0o755);
    const data = join(directory, "database with spaces");
    await mkdir(data);
    const logCommand = (
      await compose("log-postgres")
    ).services.postgres.healthcheck.test[1].replaceAll("$$", "$");
    const mainCommand = (await compose("node-b")).services.postgres.healthcheck.test[1].replaceAll(
      "$$",
      "$",
    );
    assert.equal(logCommand, mainCommand);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PGDATA: data,
      POSTGRES_USER: "fixture",
      POSTGRES_DB: "postgres",
    };
    await execute("sh", ["-c", logCommand], { env });
    const samplePath = join(data, "autoforge-storage-capacity.json");
    const sample = JSON.parse(await readFile(samplePath, "utf8"));
    assert.equal(sample.schemaVersion, 1);
    assert(sample.capacityBytes > 0);
    assert(sample.availableBytes >= 0 && sample.availableBytes <= sample.capacityBytes);
    assert(Number.isFinite(Date.parse(sample.sampledAt)));
    const df = join(bin, "df");
    await writeFile(df, "#!/bin/sh\nexit 1\n");
    await chmod(df, 0o755);
    const failure = await execute("sh", ["-c", logCommand], { env });
    assert.match(failure.stderr, /Warning/u);
    assert.deepEqual(JSON.parse(await readFile(samplePath, "utf8")), sample);
    assert(!(await readdir(data)).some((name) => name.endsWith(".tmp")));
    await writeFile(ready, "#!/bin/sh\nexit 1\n");
    await assert.rejects(execute("sh", ["-c", logCommand], { env }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
