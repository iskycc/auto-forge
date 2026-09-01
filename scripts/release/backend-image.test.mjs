import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertPackagedNextRoutes,
  assertSafeRuntimeDestination,
  isExcludedRuntimePath,
  isNextTraceFile,
} from "./package-backend-runtime.mjs";

test("packages only the traced custom-server runtime", async () => {
  const [dockerfile, nextConfiguration, webPackage, serverBuild, runtimePackager] =
    await Promise.all([
      readFile("deploy/docker/backend.Dockerfile", "utf8"),
      readFile("apps/web/next.config.ts", "utf8"),
      readFile("apps/web/package.json", "utf8"),
      readFile("apps/web/server/build-server.mjs", "utf8"),
      readFile("scripts/release/package-backend-runtime.mjs", "utf8"),
    ]);

  assert.doesNotMatch(nextConfiguration, /output:\s*["']standalone["']/);
  assert.match(dockerfile, /\bCI=1\b/);

  const vendoredDependencies = dockerfile.indexOf("COPY vendor/ ./vendor/");
  const dependencyFetch = dockerfile.indexOf("pnpm fetch --frozen-lockfile --ignore-scripts");
  assert.ok(vendoredDependencies >= 0, "vendored offline dependencies must enter the image");
  assert.ok(
    dependencyFetch > vendoredDependencies,
    "vendored offline dependencies must be available before pnpm fetch",
  );

  const webBuild = dockerfile.indexOf("pnpm --filter @autoforge/web build");
  const workerBuild = dockerfile.indexOf("pnpm --filter @autoforge/worker build");
  const runtimePackaging = dockerfile.indexOf(
    "node scripts/release/package-backend-runtime.mjs /workspace/backend-runtime",
  );
  assert.ok(webBuild >= 0, "the Web production build must be present");
  assert.ok(workerBuild > webBuild, "the worker must be built after the Web application");
  assert.ok(
    runtimePackaging > workerBuild,
    "the traced runtime must be packaged only after all production builds",
  );

  assert.match(
    dockerfile,
    /COPY --from=builder --chown=node:node \/workspace\/backend-runtime \.\//,
  );
  assert.doesNotMatch(dockerfile, /COPY --from=builder[^\n]*\/workspace\/node_modules/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder[^\n]*\/workspace\/packages/);
  assert.doesNotMatch(dockerfile, /COPY --from=builder[^\n]*\/workspace\/apps\/web\/\.next/);
  assert.doesNotMatch(dockerfile, /\.next\/standalone/);

  const scripts = JSON.parse(webPackage).scripts;
  assert.match(scripts.build, /next build && pnpm run build:server/);
  assert.match(scripts["build:server"], /build-server\.mjs/);
  assert.match(serverBuild, /external:\s*\[[^\]]*"nats"/s);
  assert.match(runtimePackager, /externalModuleClosures\s*=\s*\["apps\/web\/node_modules\/nats"\]/);
});

test("excludes development output and protects runtime packaging destinations", () => {
  for (const path of [
    "apps/web/.next/cache/turbopack.bin",
    "apps/web/.next/server/page.js.map",
    "apps/web/data/db/autoforge.sqlite",
    "apps/web/src/page.test.ts",
    "coverage/index.html",
  ]) {
    assert.equal(isExcludedRuntimePath(path), true, `${path} must not enter the image`);
  }
  assert.equal(isExcludedRuntimePath("apps/web/.next/server/page.js"), false);
  assert.equal(isExcludedRuntimePath("apps/web/.next/server/app/api/v1/ldap/test/route.js"), false);
  assert.equal(
    isExcludedRuntimePath("apps/web/.next/server/app/api/v1/webhooks/[webhookId]/test/route.js"),
    false,
  );
  assert.equal(isExcludedRuntimePath("packages/db/drizzle/sqlite/0001.sql"), false);
  assert.equal(isNextTraceFile("next-server.js.nft.json"), true);
  assert.equal(isNextTraceFile("next-server.js"), false);

  assert.throws(() => assertSafeRuntimeDestination("/"), /unsafe runtime destination/);
  assert.throws(() => assertSafeRuntimeDestination(process.cwd()), /unsafe runtime destination/);
});

test("requires every module declared by the Next.js app paths manifest", async () => {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "autoforge-runtime-routes-"));
  const serverDirectory = join(runtimeDirectory, "apps/web/.next/server");
  const presentRoute = "app/api/v1/health/live/route.js";
  const missingRoute = "app/api/v1/ldap/test/route.js";
  try {
    await mkdir(join(serverDirectory, "app/api/v1/health/live"), { recursive: true });
    await writeFile(join(serverDirectory, presentRoute), "export const route = true;\n");
    await writeFile(
      join(serverDirectory, "app-paths-manifest.json"),
      JSON.stringify({
        "/api/v1/health/live/route": presentRoute,
        "/api/v1/ldap/test/route": missingRoute,
      }),
    );

    await assert.rejects(
      assertPackagedNextRoutes(runtimeDirectory),
      /missing Next\.js routes: \/api\/v1\/ldap\/test\/route/,
    );
    await mkdir(join(serverDirectory, "app/api/v1/ldap/test"), { recursive: true });
    await writeFile(join(serverDirectory, missingRoute), "export const route = true;\n");
    await assert.doesNotReject(assertPackagedNextRoutes(runtimeDirectory));
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("enforces the backend Docker archive size budget", async () => {
  const buildScript = await readFile("scripts/release/build-backend-image.sh", "utf8");
  assert.match(buildScript, /AUTOFORGE_BACKEND_IMAGE_MAX_BYTES:-188743680/);
  assert.match(buildScript, /archive_bytes > maximum_archive_bytes/);
});

test("executes the migration entry point while verifying a release image", async () => {
  const verificationScript = await readFile("scripts/release/verify-backend-image.sh", "utf8");

  assert.match(verificationScript, /node \/app\/apps\/web\/dist-server\/server\/migrate\.js/);
  assert.match(verificationScript, /--workdir \/app\/apps\/web/);
  assert.match(verificationScript, /await import\("nats"\)/);
  assert.doesNotMatch(
    verificationScript,
    /test -f \/app\/apps\/web\/dist-server\/server\/migrate\.js/,
  );
});

test("resolves migration-integrity dependencies from the production web workspace", async () => {
  const acceptanceScript = await readFile("scripts/quality/test-release-offline.sh", "utf8");

  assert.match(
    acceptanceScript,
    /inject_migration_integrity_failure\(\)[\s\S]*?--workdir \/app\/apps\/web[\s\S]*?require\("better-sqlite3"\)/,
  );
  assert.doesNotMatch(acceptanceScript, /autoforge-runner-toolchain-linux/);
  assert.doesNotMatch(acceptanceScript, /E2E_PREBUILT_TOOLCHAIN_ROOT=/);
});

test("validates signed archive identity without assuming Docker image ID semantics", async () => {
  const acceptanceScript = await readFile("scripts/quality/test-release-offline.sh", "utf8");

  assert.match(acceptanceScript, /AUTOFORGE_RELEASE_ACCEPTANCE_VARIANT:-amd64/);
  assert.match(acceptanceScript, /archive_config_digest="sha256:\$\{archive_config_path##\*\/\}"/);
  assert.match(acceptanceScript, /archive_config_digest.*expected_config_digest/s);
  assert.match(acceptanceScript, /docker image inspect --format[\s\S]*?image_reference/);
  assert.doesNotMatch(acceptanceScript, /docker image inspect "\$\{image\}"/);
});

test("builds host-native Agents without a libc runtime dependency", async () => {
  const [buildScript, muslVerification, releaseWorkflow] = await Promise.all([
    readFile("scripts/release/build-agent.sh", "utf8"),
    readFile("scripts/release/verify-agent-musl-runtime.sh", "utf8"),
    readFile(".github/workflows/release.yml", "utf8"),
  ]);

  assert.match(buildScript, /CGO_ENABLED=0 GOARCH=/);
  assert.match(buildScript, /readelf --program-headers[\s\S]*?'INTERP'/);
  assert.match(buildScript, /readelf --dynamic[\s\S]*?'\(NEEDED\)'/);
  assert.match(buildScript, /go version -m[\s\S]*?CGO_ENABLED=0/);
  assert.match(muslVerification, /node:24\.16\.0-alpine3\.23@sha256:[a-f0-9]{64}/);
  assert.match(muslVerification, /--network none/);
  assert.match(muslVerification, /--entrypoint \/opt\/autoforge-agent/);
  assert.match(releaseWorkflow, /Verify embedded Agent in musl user space/);
});
