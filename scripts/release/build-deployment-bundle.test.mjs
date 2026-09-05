import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("builds a versioned deployment bundle with Lite, Full and five-host templates", async () => {
  const outputDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-deploy-output-"));
  const extractedDirectory = await mkdtemp(resolve(tmpdir(), "autoforge-deploy-extract-"));
  try {
    await execute(
      "bash",
      ["scripts/release/build-deployment-bundle.sh", "1.2.3", outputDirectory],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        env: { ...process.env, SOURCE_DATE_EPOCH: "1786233600" },
      },
    );
    const archivePath = resolve(outputDirectory, "autoforge-deploy-1.2.3.tar.gz");
    assert.ok(
      (await stat(archivePath)).size < 500_000,
      "deployment bundle must not carry repository design or archive assets",
    );
    await execute("tar", ["-xzf", archivePath, "-C", extractedDirectory]);

    const packageDirectory = resolve(extractedDirectory, "autoforge-deploy-1.2.3");
    const liteCompose = await readFile(
      resolve(packageDirectory, "lite/docker-compose.yml"),
      "utf8",
    );
    const fullCompose = await readFile(
      resolve(packageDirectory, "full/docker-compose.yml"),
      "utf8",
    );
    assert.doesNotMatch(liteCompose, /AUTOFORGE_MODE|AUTOFORGE_MASTER_KEY/);
    assert.doesNotMatch(fullCompose, /AUTOFORGE_DATABASE_URL|AUTOFORGE_MASTER_KEY/);
    assert.match(fullCompose, /POSTGRES_PASSWORD_FILE/);
    assert.match(fullCompose, /--data-dir=\/var\/lib\/autoforge/);
    assert.match(
      await readFile(resolve(packageDirectory, "lite/.env.example"), "utf8"),
      /autoforge\/backend:1\.2\.3-amd64/,
    );
    assert.equal(await readFile(resolve(packageDirectory, "VERSION"), "utf8"), "1.2.3\n");
    assert.match(
      await readFile(resolve(packageDirectory, "COMPATIBILITY.md"), "utf8"),
      /Compatibility matrix/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "release-signing-public-key.pem"), "utf8"),
      /BEGIN PUBLIC KEY/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "operations/lite-backup.sh"), "utf8"),
      /--platform-stopped/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "operations/migrate.sh"), "utf8"),
      /migrate\.js/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "docs/manuals/administrator.md"), "utf8"),
      /备份与恢复/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "docs/architecture/ddt-management.md"), "utf8"),
      /DDT/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "docs/operations/performance-baseline.md"), "utf8"),
      /性能与稳定性基线/,
    );
    const packagedFiles = await readdir(packageDirectory, { recursive: true });
    await assertFiveHostTemplates(packageDirectory, packagedFiles);
    for (const template of [
      "distributed/platform/docker-compose.yml",
      "distributed/infrastructure/docker-compose.yml",
      "distributed/infrastructure/prepare-secrets.mjs",
      "distributed/edge/nginx.conf",
      "docs/adr/0012-full-distributed-node-local-logs.md",
      "docs/adr/0013-platform-time-authority.md",
    ])
      assert.ok(
        packagedFiles.includes(template),
        `missing distributed deployment asset: ${template}`,
      );
    assert.ok(
      !packagedFiles.some(
        (name) =>
          name.endsWith("/.env") || name.includes("/secrets/") || name.endsWith("/platform.json"),
      ),
    );
    assert.match(
      await readFile(resolve(packageDirectory, "distributed/platform/.env.example"), "utf8"),
      /autoforge\/backend:1\.2\.3-amd64/,
    );
    assert.match(
      await readFile(resolve(packageDirectory, "distributed/README.md"), "utf8"),
      /\]\(\.\.\/docs\/adr\/0012-full-distributed-node-local-logs\.md\)/,
    );
    assert.ok(!packagedFiles.includes("docs/design/autoforge-apple-like-e-dashboard.png"));
    assert.match(
      await readFile(resolve(packageDirectory, "full-five-hosts/README.md"), "utf8"),
      /\]\(\.\.\/docs\/adr\/0013-platform-time-authority\.md\)/,
    );
    assert.ok(!packagedFiles.some((name) => name.startsWith("docs/archive/")));
    assert.ok(!packagedFiles.includes("docs/project-roadmap.md"));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await rm(extractedDirectory, { recursive: true, force: true });
  }
});

async function assertFiveHostTemplates(packageDirectory, packagedFiles) {
  for (const host of ["platform-1", "platform-2", "platform-3", "nginx", "infrastructure"]) {
    for (const template of ["docker-compose.yml", ".env.example"]) {
      const templatePath = `full-five-hosts/${host}/${template}`;
      assert.ok(packagedFiles.includes(templatePath), `missing host asset: ${templatePath}`);
    }
  }

  for (const nodeNumber of [1, 2, 3]) {
    const hostDirectory = resolve(packageDirectory, `full-five-hosts/platform-${nodeNumber}`);
    assert.match(
      await readFile(resolve(hostDirectory, ".env.example"), "utf8"),
      /AUTOFORGE_BACKEND_IMAGE=autoforge\/backend:1\.2\.3-amd64/,
    );
  }

  const nginxConfiguration = await readFile(
    resolve(packageDirectory, "full-five-hosts/nginx/nginx.conf"),
    "utf8",
  );
  const platformUpstream = nginxConfiguration.match(/upstream platform \{([^}]+)\}/)?.[1];
  assert.ok(platformUpstream, "IP gateway must include the three platform upstreams");
  assert.deepEqual(
    [...platformUpstream.matchAll(/server ([^; ]+)/g)].map((match) => match[1]),
    ["10.20.0.11:3000", "10.20.0.12:3000", "10.20.0.13:3000"],
  );
  assert.match(nginxConfiguration, /listen 8080 default_server;/);
  assert.match(nginxConfiguration, /server_name _;/);

  const instructions = await readFile(
    resolve(packageDirectory, "full-five-hosts/README.md"),
    "utf8",
  );
  assert.match(instructions, /\.\.\/distributed\/infrastructure\/prepare-secrets\.mjs/);
  assert.ok(packagedFiles.includes("distributed/infrastructure/prepare-secrets.mjs"));
}
