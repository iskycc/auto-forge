#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Immutable Release offline acceptance is restricted to GitHub Actions." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly current_version="${1:?usage: test-release-offline.sh CURRENT_VERSION CURRENT_DIR PREVIOUS_VERSION PREVIOUS_DIR [PHASE]}"
readonly current_release_directory="$(realpath "${2:?current release directory is required}")"
readonly previous_version="${3:?previous release version is required}"
readonly previous_release_directory="$(realpath "${4:?previous release directory is required}")"
readonly acceptance_phase="${5:-all}"

case "${acceptance_phase}" in
  all | assets | backup-restore | business-assets | business-governance | ldap | real-agent | upgrade-rollback) ;;
  *)
    printf 'Unknown published Release acceptance phase: %s\n' "${acceptance_phase}" >&2
    exit 2
    ;;
esac
readonly acceptance_directory="$(mktemp -d)"
readonly phase_identity="${acceptance_phase//[^0-9A-Za-z_-]/_}"
readonly run_identity="${GITHUB_RUN_ID//[^0-9A-Za-z_-]/_}-${GITHUB_RUN_ATTEMPT//[^0-9A-Za-z_-]/_}-${phase_identity}"
readonly network_name="autoforge-release-offline-${run_identity}"
readonly current_container="autoforge-release-current-${run_identity}"
readonly previous_container="autoforge-release-previous-${run_identity}"
readonly restored_container="autoforge-release-restored-${run_identity}"
readonly rollback_container="autoforge-release-rollback-${run_identity}"
readonly upgraded_container="autoforge-release-upgraded-${run_identity}"
readonly ldap_image="osixia/openldap:1.5.0@sha256:18742e9c449c9c1afe129d3f2f3ee15fb34cc43e5f940a20f3399728f41d7c28"
readonly current_data="${acceptance_directory}/current-data"
readonly restored_data="${acceptance_directory}/restored-data"
readonly previous_data="${acceptance_directory}/previous-data"
readonly failed_migration_data="${acceptance_directory}/failed-migration-data"
readonly rollback_data="${acceptance_directory}/rollback-data"
readonly current_deploy_root="${acceptance_directory}/current-deploy"
readonly release_agent="${acceptance_directory}/autoforge-agent"
readonly release_adapter="${acceptance_directory}/cotest-testng-adapter.jar"
readonly upgrade_sentinel="Release upgrade sentinel ${run_identity}"
readonly agent_proxy_ready_file="${acceptance_directory}/agent-proxy-url"

current_image=""
previous_image=""
agent_proxy_pid=""
agent_proxy_url=""

cleanup() {
  local exit_status="$?"
  set +e
  stop_agent_loopback_proxy
  docker rm --force \
    "${current_container}" "${previous_container}" "${restored_container}" \
    "${rollback_container}" "${upgraded_container}" >/dev/null 2>&1
  docker network rm "${network_name}" >/dev/null 2>&1
  if [[ "${acceptance_directory}" == /tmp/* ]]; then rm -rf -- "${acceptance_directory}"; fi
  return "${exit_status}"
}
trap cleanup EXIT

stop_agent_loopback_proxy() {
  if [[ "${agent_proxy_pid}" =~ ^[1-9][0-9]*$ ]]; then
    kill "${agent_proxy_pid}" >/dev/null 2>&1 || true
    wait "${agent_proxy_pid}" >/dev/null 2>&1 || true
  fi
  agent_proxy_pid=""
  agent_proxy_url=""
}

require_tools() {
  local missing=0
  for command_name in curl docker node openssl pnpm sha256sum sudo tar; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "Missing release acceptance command: ${command_name}" >&2
      missing=1
    fi
  done
  [[ "${missing}" -eq 0 ]]
}

verify_current_release() {
  cmp --silent \
    "${repository_root}/release-signing-public-key.pem" \
    "${current_release_directory}/release-signing-public-key.pem"
  verify_signature "${current_release_directory}"
  (cd "${current_release_directory}" && sha256sum --check --strict SHA256SUMS)
  node --input-type=module - \
    "${repository_root}" "${current_release_directory}" "${current_version}" <<'NODE'
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [repositoryRoot, directory, expectedVersion] = process.argv.slice(2);
const { expectedArtifactNames } = await import(
  pathToFileURL(join(repositoryRoot, "scripts/release/create-manifest.mjs")).href
);
const manifest = JSON.parse(readFileSync(join(directory, "release-manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || manifest.product !== "AutoForge" || manifest.version !== expectedVersion) {
  throw new Error("Release manifest identity is invalid.");
}
const expectedNames = expectedArtifactNames(expectedVersion).sort();
const actualNames = manifest.artifacts.map((artifact) => artifact.name).sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  throw new Error(`Unexpected release assets: ${actualNames.join(", ")}`);
}
for (const artifact of manifest.artifacts) {
  const path = join(directory, artifact.name);
  if (!statSync(path).isFile() || statSync(path).size !== artifact.sizeBytes) throw new Error(`Invalid asset ${artifact.name}`);
}
for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".spdx.json"))) {
  const sbom = JSON.parse(readFileSync(join(directory, name), "utf8"));
  if (!String(sbom.spdxVersion ?? "").startsWith("SPDX-")) throw new Error(`Invalid SPDX document ${name}`);
}
for (const required of ["LICENSE", "NOTICE", "THIRD_PARTY_LICENSES.json", "CHANGELOG.md", "COMPATIBILITY.md"]) {
  if (!statSync(join(directory, required)).isFile()) throw new Error(`Missing legal or operations asset ${required}`);
}
NODE
}

verify_previous_release() {
  verify_signature "${previous_release_directory}"
  (cd "${previous_release_directory}" && sha256sum --ignore-missing --check --strict SHA256SUMS)
}

verify_signature() {
  local directory="${1:?release directory is required}"
  openssl pkeyutl -verify -rawin -pubin \
    -inkey "${directory}/release-signing-public-key.pem" \
    -sigfile "${directory}/SHA256SUMS.sig" \
    -in "${directory}/SHA256SUMS" >/dev/null
}

load_release_image() {
  local version="${1:?version is required}"
  local directory="${2:?release directory is required}"
  local archive="${directory}/autoforge-backend-${version}-amd64.docker.tar"
  local legacy_archive="${archive}.zst"
  local metadata="${directory}/autoforge-backend-${version}-amd64.image.json"
  if [[ -f "${archive}" ]]; then
    docker load --input "${archive}" >/dev/null
  elif [[ -f "${legacy_archive}" ]]; then
    if ! command -v zstd >/dev/null 2>&1; then
      echo "Legacy Release ${version} requires zstd for upgrade acceptance." >&2
      exit 1
    fi
    zstd --decompress --stdout "${legacy_archive}" | docker load >/dev/null
  else
    echo "Release ${version} does not contain a Docker image archive." >&2
    exit 1
  fi
  local image
  image="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).immutableImageId" "${metadata}")"
  if [[ ! "${image}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "Release image metadata does not contain an immutable image ID." >&2
    exit 1
  fi
  docker image inspect "${image}" >/dev/null
  printf '%s\n' "${image}"
}

prepare_release_content() {
  mkdir -p "${current_deploy_root}"
  tar -xzf "${current_release_directory}/autoforge-deploy-${current_version}.tar.gz" \
    -C "${current_deploy_root}"
  docker compose \
    --env-file "${current_deploy_root}/autoforge-deploy-${current_version}/lite/.env.example" \
    --file "${current_deploy_root}/autoforge-deploy-${current_version}/lite/docker-compose.yml" \
    config --quiet
  if grep -R --include='docker-compose.yml' -nE 'pull_policy:[[:space:]]+(always|missing)' \
    "${current_deploy_root}/autoforge-deploy-${current_version}"; then
    echo "Release Compose configuration may pull images at runtime." >&2
    exit 1
  fi
}

# Published ports are unreachable from the host on an --internal network, so
# host-side checks and browsers use the container IP on the isolated bridge.
container_ip() {
  docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    "${1:?container name is required}"
}

start_platform() {
  local name="${1:?container name is required}"
  local image="${2:?image is required}"
  local data_directory="${3:?data directory is required}"
  mkdir -p "${data_directory}"
  docker run --detach \
    --name "${name}" \
    --network "${network_name}" \
    --pull never \
    --user "$(id -u):$(id -g)" \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --security-opt no-new-privileges \
    --cap-drop ALL \
    --volume "${data_directory}:/var/lib/autoforge" \
    "${image}" >/dev/null
  local base_url="http://$(container_ip "${name}"):3000"
  wait_ready "${base_url}"
  printf '%s\n' "${base_url}"
}

stop_platform() {
  docker stop --time 15 "${1:?container name is required}" >/dev/null
  docker rm "${1}" >/dev/null
}

wait_ready() {
  local base_url="${1:?base URL is required}"
  for _ in $(seq 1 180); do
    if curl --fail --silent "${base_url}/api/v1/health/ready" >/dev/null; then return; fi
    sleep 0.5
  done
  echo "Release platform did not become ready at ${base_url}." >&2
  return 1
}

start_agent_loopback_proxy() {
  local target_url="${1:?target URL is required}"
  node - "${target_url}" "${agent_proxy_ready_file}" <<'NODE' &
const { writeFileSync } = require("node:fs");
const net = require("node:net");

const [targetValue, readyFile] = process.argv.slice(2);
const target = new URL(targetValue);
const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, target.hostname);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
server.on("error", (error) => {
  console.error(`Agent loopback proxy failed: ${error.message}`);
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback proxy address is invalid.");
  writeFileSync(readyFile, `http://127.0.0.1:${address.port}\n`, { mode: 0o600 });
});
process.on("SIGTERM", () => process.exit(0));
NODE
  agent_proxy_pid="$!"

  for _ in $(seq 1 100); do
    if [[ -s "${agent_proxy_ready_file}" ]]; then
      read -r agent_proxy_url <"${agent_proxy_ready_file}"
      wait_ready "${agent_proxy_url}"
      return
    fi
    if ! kill -0 "${agent_proxy_pid}" >/dev/null 2>&1; then
      echo "Agent loopback proxy exited before becoming ready." >&2
      return 1
    fi
    sleep 0.1
  done
  echo "Agent loopback proxy did not become ready." >&2
  return 1
}

read_platform_secret() {
  local data_directory="${1:?data directory is required}"
  local property="${2:?secret property is required}"
  node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets[process.argv[2]]" \
    "${data_directory}/config/platform.json" "${property}"
}

run_current_release_browser() {
  local base_url="${1:?base URL is required}"
  local browser_phase="${2:?Release browser phase is required}"
  local browser_specs=()
  case "${browser_phase}" in
    assets)
      browser_specs=(
        tests/e2e/case-suite-lifecycle.spec.ts
        tests/e2e/jar-import.spec.ts
        tests/e2e/project-isolation.spec.ts
      )
      ;;
    governance)
      browser_specs=(
        tests/e2e/identity-rbac.spec.ts
        tests/e2e/management-operations.spec.ts
        tests/e2e/platform-operations.spec.ts
      )
      ;;
    *)
      printf 'Unknown published Release browser phase: %s\n' "${browser_phase}" >&2
      return 2
      ;;
  esac
  local admin_token runner_master_key runner_token
  admin_token="$(read_platform_secret "${current_data}" adminBootstrapToken)"
  runner_master_key="$(read_platform_secret "${current_data}" masterKey)"
  runner_token="$(read_platform_secret "${current_data}" runnerBootstrapToken)"
  E2E_BASE_URL="${base_url}" \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_token}" \
  E2E_RUNNER_BOOTSTRAP_TOKEN="${runner_token}" \
  E2E_RUNNER_BOOTSTRAP_MASTER_KEY="${runner_master_key}" \
    pnpm exec playwright test --config playwright.full.config.ts \
      "${browser_specs[@]}"
}

run_current_release_agent() {
  local base_url="${1:?base URL is required}"
  local admin_token runner_token
  admin_token="$(read_platform_secret "${current_data}" adminBootstrapToken)"
  runner_token="$(read_platform_secret "${current_data}" runnerBootstrapToken)"
  docker cp "${current_container}:/app/resources/agents/linux-amd64/autoforge-agent" \
    "${release_agent}"
  docker cp "${current_container}:/app/resources/agents/cotest-testng-adapter.jar" \
    "${release_adapter}"
  chmod 0755 "${release_agent}"
  start_agent_loopback_proxy "${base_url}"
  E2E_REAL_AGENT_EXTERNAL_BASE_URL="${base_url}" \
  E2E_REAL_AGENT_SERVER_URL="${agent_proxy_url}" \
  E2E_PREBUILT_AGENT_BINARY="${release_agent}" \
  E2E_PREBUILT_ADAPTER_JAR="${release_adapter}" \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_token}" \
  E2E_RUNNER_BOOTSTRAP_TOKEN="${runner_token}" \
    bash "${repository_root}/scripts/quality/test-real-agent.sh"
  stop_agent_loopback_proxy
}

run_current_release_ldap() {
  local base_url="${1:?base URL is required}"
  local admin_token
  admin_token="$(read_platform_secret "${current_data}" adminBootstrapToken)"
  E2E_LDAP_EXTERNAL_BASE_URL="${base_url}" \
  E2E_LDAP_EXTERNAL_NETWORK="${network_name}" \
  E2E_LDAP_SKIP_PULL=1 \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_token}" \
    bash "${repository_root}/scripts/quality/test-ldap-e2e.sh"
}

run_upgrade_phase() {
  local base_url="${1:?base URL is required}"
  local data_directory="${2:?data directory is required}"
  local phase="${3:?phase is required}"
  E2E_BASE_URL="${base_url}" \
  E2E_ADMIN_BOOTSTRAP_TOKEN="$(read_platform_secret "${data_directory}" adminBootstrapToken)" \
  E2E_UPGRADE_PHASE="${phase}" \
  E2E_UPGRADE_SENTINEL="${upgrade_sentinel}" \
    pnpm exec playwright test --config playwright.full.config.ts tests/e2e/release-upgrade.spec.ts
}

run_platform_restart_phase() {
  local base_url="${1:?base URL is required}"
  local data_directory="${2:?data directory is required}"
  local phase="${3:?platform restart phase is required}"
  E2E_BASE_URL="${base_url}" \
  E2E_ADMIN_BOOTSTRAP_TOKEN="$(read_platform_secret "${data_directory}" adminBootstrapToken)" \
  E2E_PLATFORM_RESTART_PHASE="${phase}" \
    pnpm exec playwright test --config playwright.full.config.ts tests/e2e/platform-restart.spec.ts
}

release_operations_directory() {
  printf '%s\n' "${current_deploy_root}/autoforge-deploy-${current_version}/operations"
}

backup_data() {
  local data_directory="${1:?data directory is required}"
  local backup_path="${2:?backup path is required}"
  bash "$(release_operations_directory)/lite-backup.sh" \
    --data-dir "${data_directory}" --output "${backup_path}" --platform-stopped
}

restore_data() {
  local backup_path="${1:?backup path is required}"
  local data_directory="${2:?data directory is required}"
  bash "$(release_operations_directory)/lite-restore.sh" \
    --input "${backup_path}" --data-dir "${data_directory}" --platform-stopped
}

assert_restored_statistics() {
  local before_statistics="${1:?statistics before restore are required}"
  local after_statistics="${2:?statistics after restore are required}"
  node - "${before_statistics}" "${after_statistics}" <<'NODE'
const [beforeValue, afterValue] = process.argv.slice(2);
const before = JSON.parse(beforeValue);
const after = JSON.parse(afterValue);
const runtimeFields = new Set([
  "generatedAt",
  "onlineRunnerCount",
  "busyRunnerCount",
  "refreshSeconds",
]);
const stableEntries = (statistics) =>
  Object.entries(statistics)
    .filter(([name]) => !runtimeFields.has(name))
    .sort(([left], [right]) => left.localeCompare(right));

const beforeStable = JSON.stringify(stableEntries(before));
const afterStable = JSON.stringify(stableEntries(after));
if (beforeStable !== afterStable) {
  throw new Error(`Restored business statistics differ. Before: ${beforeStable}; after: ${afterStable}`);
}
NODE
}

run_migration() {
  local image="${1:?image is required}"
  local data_directory="${2:?data directory is required}"
  docker run --rm --network none --pull never \
    --user "$(id -u):$(id -g)" \
    --volume "${data_directory}:/var/lib/autoforge" \
    "${image}" node apps/web/dist-server/server/migrate.js --data-dir=/var/lib/autoforge
}

initialize_current_acceptance_platform() {
  # Create the bind source as the runner user. If Docker creates a missing
  # source directory, it is owned by root and the non-root release container
  # cannot initialize /var/lib/autoforge.
  mkdir -p "${current_data}"
  run_migration "${current_image}" "${current_data}"
  node --input-type=module - "${current_data}" <<'NODE'
import { PlatformConfigurationStore } from "./packages/platform-config/src/platform-configuration.ts";

const [dataDirectory] = process.argv.slice(2);
const store = new PlatformConfigurationStore(dataDirectory);
const current = store.read();
store.replace(
  {
    ...current,
    limits: {
      ...current.limits,
      // All browser scenarios share one isolated bridge address. Keep the
      // aggregate address limiter above their bounded login count while the
      // identity scenario still exercises the per-user lock threshold.
      authLoginAttemptsPerWindow: 500,
    },
  },
  current.revision,
);
NODE
}

inject_migration_integrity_failure() {
  local data_directory="${1:?data directory is required}"
  docker run --rm --network none --pull never \
    --user "$(id -u):$(id -g)" \
    --volume "${data_directory}:/var/lib/autoforge" \
    --workdir /app/apps/web \
    "${current_image}" node -e '
      const Database = require("better-sqlite3");
      const db = new Database("/var/lib/autoforge/db/autoforge.sqlite");
      const row = db.prepare("SELECT name FROM _autoforge_migrations ORDER BY name LIMIT 1").get();
      if (!row) process.exit(2);
      db.prepare("UPDATE _autoforge_migrations SET sha256 = ? WHERE name = ?").run("0".repeat(64), row.name);
      db.close();
    '
}

verify_backup_restore() {
  local current_base_url="${1:?current base URL is required}"
  local before_statistics backup_path after_statistics restored_base_url
  run_platform_restart_phase "${current_base_url}" "${current_data}" seed
  before_statistics="$(curl --fail --silent "${current_base_url}/api/v1/public/statistics")"
  stop_platform "${current_container}"
  backup_path="${acceptance_directory}/current-backup.tar.gz"
  backup_data "${current_data}" "${backup_path}"
  restore_data "${backup_path}" "${restored_data}"
  diff --recursive --brief "${current_data}" "${restored_data}"
  restored_base_url="$(start_platform "${restored_container}" "${current_image}" "${restored_data}")"
  after_statistics="$(curl --fail --silent "${restored_base_url}/api/v1/public/statistics")"
  assert_restored_statistics "${before_statistics}" "${after_statistics}"
  run_platform_restart_phase "${restored_base_url}" "${restored_data}" verify
  stop_platform "${restored_container}"
}

verify_upgrade_and_rollback() {
  local previous_base_url rollback_base_url upgraded_base_url
  previous_base_url="$(start_platform "${previous_container}" "${previous_image}" "${previous_data}")"
  run_upgrade_phase "${previous_base_url}" "${previous_data}" seed
  stop_platform "${previous_container}"

  local previous_backup="${acceptance_directory}/previous-backup.tar.gz"
  backup_data "${previous_data}" "${previous_backup}"
  restore_data "${previous_backup}" "${failed_migration_data}"
  inject_migration_integrity_failure "${failed_migration_data}"
  if run_migration "${current_image}" "${failed_migration_data}"; then
    echo "The injected migration integrity failure was unexpectedly accepted." >&2
    exit 1
  fi

  restore_data "${previous_backup}" "${rollback_data}"
  rollback_base_url="$(start_platform "${rollback_container}" "${previous_image}" "${rollback_data}")"
  run_upgrade_phase "${rollback_base_url}" "${rollback_data}" verify
  stop_platform "${rollback_container}"

  run_migration "${current_image}" "${previous_data}"
  upgraded_base_url="$(start_platform "${upgraded_container}" "${current_image}" "${previous_data}")"
  run_upgrade_phase "${upgraded_base_url}" "${previous_data}" verify
  stop_platform "${upgraded_container}"
}

prepare_current_platform() {
  current_image="$(load_release_image "${current_version}" "${current_release_directory}")"
  docker network create --internal "${network_name}" >/dev/null
  initialize_current_acceptance_platform
  current_base_url="$(start_platform "${current_container}" "${current_image}" "${current_data}")"
  docker exec "${current_container}" node -e \
    "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))"
}

cd "${repository_root}"
require_tools

case "${acceptance_phase}" in
  assets)
    verify_current_release
    verify_previous_release
    prepare_release_content
    ;;
  business-assets)
    prepare_current_platform
    run_current_release_browser "${current_base_url}" assets
    ;;
  business-governance)
    prepare_current_platform
    run_current_release_browser "${current_base_url}" governance
    ;;
  real-agent)
    prepare_current_platform
    run_current_release_agent "${current_base_url}"
    ;;
  ldap)
    docker image inspect "${ldap_image}" >/dev/null
    prepare_current_platform
    run_current_release_ldap "${current_base_url}"
    ;;
  backup-restore)
    prepare_release_content
    prepare_current_platform
    verify_backup_restore "${current_base_url}"
    ;;
  upgrade-rollback)
    prepare_release_content
    current_image="$(load_release_image "${current_version}" "${current_release_directory}")"
    previous_image="$(load_release_image "${previous_version}" "${previous_release_directory}")"
    docker network create --internal "${network_name}" >/dev/null
    verify_upgrade_and_rollback
    ;;
  all)
    verify_current_release
    verify_previous_release
    prepare_release_content
    previous_image="$(load_release_image "${previous_version}" "${previous_release_directory}")"
    docker image inspect "${ldap_image}" >/dev/null
    prepare_current_platform
    run_current_release_browser "${current_base_url}" assets
    run_current_release_browser "${current_base_url}" governance
    run_current_release_agent "${current_base_url}"
    run_current_release_ldap "${current_base_url}"
    verify_backup_restore "${current_base_url}"
    verify_upgrade_and_rollback
    ;;
esac

printf 'Published Release acceptance phase passed: %s.\n' "${acceptance_phase}"
