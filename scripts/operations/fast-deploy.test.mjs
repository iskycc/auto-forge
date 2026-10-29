import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PlatformConfigurationStore } from "@autoforge/platform-config";
import { initializePlatform } from "../../fast-deploy/initialize-platform.mjs";

const execute = promisify(execFile);
const generator = resolve("fast-deploy/prepare.mjs");
const configuration = [
  "NODE_A_IP=127.0.0.1",
  "NODE_B_IP=127.0.0.2",
  "NODE_C_IP=127.0.0.3",
  "AUTOFORGE_VERSION=1.21.4",
  "ARCH=amd64",
].join("\n");

async function withDeployment(run, contents = configuration) {
  const directory = await mkdtemp(join(tmpdir(), "autoforge-fast-deploy-"));
  try {
    const config = join(directory, ".env");
    const output = join(directory, "generated");
    await writeFile(config, contents);
    await run({ directory, config, output });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("generates matching private credentials and self-contained three-host Compose files", async () => {
  await withDeployment(async ({ config, output }) => {
    const result = await execute("node", [generator, config, output]);
    const settings = JSON.parse(await readFile(join(output, "node-a/setup-values.json"), "utf8"));
    const password = (
      await readFile(join(output, "node-b/secrets/postgres-password"), "utf8")
    ).trim();
    assert(password.length >= 32);
    assert.equal(new URL(settings.full.databaseUrl).password, password);
    assert.equal(new URL(settings.full.databaseUrl).hostname, "127.0.0.2");
    assert.equal(new URL(settings.full.minio.endpoint).hostname, "127.0.0.3");
    const redisPassword = (
      await readFile(join(output, "node-b/secrets/redis-password"), "utf8")
    ).trim();
    assert.equal(new URL(settings.full.redisUrl).password, redisPassword);
    assert(
      (await readFile(join(output, "node-c/secrets/nats.conf"), "utf8")).includes(
        settings.full.natsToken,
      ),
    );
    for (const secret of [
      password,
      redisPassword,
      settings.full.natsToken,
      settings.full.minio.secretKey,
    ]) {
      assert(!result.stdout.includes(secret));
    }
    for (const host of ["node-a", "node-b", "node-c"]) {
      const path = join(output, host);
      const compose = await readFile(join(path, "docker-compose.yml"), "utf8");
      assert.match(compose, /pull_policy: never/);
      assert.doesNotMatch(compose, /^volumes:/m);
      assert.match(compose, /type: bind/);
      assert.match(compose, /create_host_path: false/);
      assert.equal((await stat(join(path, ".env"))).mode & 0o777, 0o600);
      assert.equal((await readFile(join(path, "host-role"), "utf8")).trim(), host);
      assert.match(await readFile(join(path, "deploy.sh"), "utf8"), /POSTGRES|postgres-password/);
    }
    assert.equal((await stat(join(output, "node-a/setup-values.json"))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(output, "node-b/secrets/postgres-password"))).mode & 0o777,
      0o600,
    );
    const postgres = await readFile(join(output, "node-b/docker-compose.yml"), "utf8");
    assert.match(postgres, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/postgres-password/);
    assert.match(postgres, /postgres-password:[\s\S]*file: \.\/secrets\/postgres-password/);
    assert.doesNotMatch(postgres, /POSTGRES_HOST_AUTH_METHOD/);
    await assert.rejects(execute("node", [generator, config, output]), /already exists/);
    assert.equal(
      (await readFile(join(output, "node-b/secrets/postgres-password"), "utf8")).trim(),
      password,
    );
  });
});

test("rejects missing addresses, duplicate settings and shell expressions before writing secrets", async () => {
  for (const invalid of [
    configuration.replace("NODE_B_IP=127.0.0.2", "NODE_B_IP="),
    `${configuration}\nNODE_A_IP=127.0.0.4`,
    configuration.replace("NODE_C_IP=127.0.0.3", "NODE_C_IP=$(touch /tmp/should-not-run)"),
    configuration.replace("ARCH=amd64", "ARCH=unknown"),
  ]) {
    await withDeployment(async ({ config, output }) => {
      await assert.rejects(execute("node", [generator, config, output]));
      await assert.rejects(stat(output), { code: "ENOENT" });
    }, invalid);
  }
});

test("stops before Docker starts if PostgreSQL credentials are missing or blank", async () => {
  await withDeployment(async ({ config, output }) => {
    await execute("node", [generator, config, output]);
    const host = join(output, "node-b");
    const password = join(host, "secrets/postgres-password");
    for (const contents of ["", "\n"]) {
      await writeFile(password, contents);
      await assert.rejects(
        execute("bash", [join(host, "deploy.sh"), "check"]),
        /postgres-password.*empty/,
      );
    }
    await rm(password);
    await assert.rejects(
      execute("bash", [join(host, "deploy.sh"), "check"]),
      /postgres-password.*missing/,
    );
  });
});

test("allows inspection and shutdown even when credential files have been lost", async () => {
  await withDeployment(async ({ directory, config, output }) => {
    await execute("node", [generator, config, output]);
    const host = join(output, "node-b");
    await rm(join(host, "secrets"), { recursive: true });
    const binaries = join(directory, "bin");
    await mkdir(binaries);
    await writeFile(join(binaries, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    for (const action of ["status", "logs", "stop"]) {
      const result = await execute("bash", [join(host, "deploy.sh"), action], {
        env: { ...process.env, PATH: `${binaries}:${process.env.PATH}` },
      });
      const argumentsList = result.stdout.trim().split("\n");
      assert(argumentsList.includes("compose"));
      assert(argumentsList.includes({ status: "ps", logs: "logs", stop: "stop" }[action]));
      assert(!argumentsList.includes("up"));
    }
  });
});

test("initializes Full through the existing validated API without rewriting platform keys", async () => {
  await withDeployment(async ({ directory, config, output }) => {
    await execute("node", [generator, config, output]);
    const store = new PlatformConfigurationStore(join(directory, "platform"));
    const original = store.initialize();
    const settingsFile = join(output, "node-a/setup-values.json");
    const settings = JSON.parse(await readFile(settingsFile, "utf8"));
    let requests = 0;
    const send = async (url, request) => {
      requests++;
      assert.equal(String(url), "http://web:3000/api/v1/auth/setup-platform");
      assert.equal(request.headers.origin, "http://web:3000");
      const input = JSON.parse(request.body);
      assert.equal(input.bootstrapToken, original.secrets.adminBootstrapToken);
      assert.equal(input.configuration.revision, original.revision);
      assert.equal(input.configuration.mode, "full");
      assert.deepEqual(input.configuration.full, {
        databaseUrl: settings.full.databaseUrl,
        redisUrl: settings.full.redisUrl,
        natsServers: settings.full.natsServers,
        natsToken: settings.full.natsToken,
        minioEndpoint: settings.full.minio.endpoint,
        minioAccessKey: settings.full.minio.accessKey,
        minioSecretKey: settings.full.minio.secretKey,
        minioBucket: settings.full.minio.bucket,
        minioRegion: settings.full.minio.region,
      });
      assert.deepEqual(input.configuration.scheduler, original.scheduler);
      assert.equal(input.configuration.web.publicBaseUrl, settings.publicBaseUrl);
      return Response.json({ mode: "full" });
    };
    await initializePlatform(store.paths.configurationFile, settingsFile, "http://web:3000", send);
    assert.equal(requests, 1);
    assert.deepEqual(store.read(), original);
    await assert.rejects(
      initializePlatform(store.paths.configurationFile, settingsFile, "http://web:3000", async () =>
        Response.json(
          { error: { code: "BOOTSTRAP_DENIED", requestId: "test-request" } },
          { status: 403 },
        ),
      ),
      /HTTP 403, code BOOTSTRAP_DENIED, request test-request/,
    );
    store.replace({ ...original, mode: "full", full: settings.full }, original.revision);
    assert.equal(
      await initializePlatform(
        store.paths.configurationFile,
        settingsFile,
        "http://web:3000",
        send,
      ),
      "already-configured",
    );
    assert.equal(requests, 1);
    await writeFile(
      settingsFile,
      JSON.stringify({
        ...settings,
        full: { ...settings.full, databaseUrl: "postgres://other.invalid/other" },
      }),
    );
    await assert.rejects(
      initializePlatform(store.paths.configurationFile, settingsFile, "http://web:3000", send),
      /cannot migrate/,
    );
    assert.deepEqual(store.read().secrets, original.secrets);
  });
});
