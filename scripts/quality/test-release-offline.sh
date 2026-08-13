#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Immutable Release offline acceptance is restricted to GitHub Actions." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly current_version="${1:?usage: test-release-offline.sh CURRENT_VERSION CURRENT_DIR PREVIOUS_VERSION PREVIOUS_DIR}"
readonly current_release_directory="$(realpath "${2:?current release directory is required}")"
readonly previous_version="${3:?previous release version is required}"
readonly previous_release_directory="$(realpath "${4:?previous release directory is required}")"
readonly acceptance_directory="$(mktemp -d)"
readonly run_identity="${GITHUB_RUN_ID//[^0-9A-Za-z_-]/_}-${GITHUB_RUN_ATTEMPT//[^0-9A-Za-z_-]/_}"
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
readonly toolchain_parent="${acceptance_directory}/toolchain"
readonly release_agent="${acceptance_directory}/autoforge-agent"
readonly upgrade_sentinel="Release upgrade sentinel ${run_identity}"

current_image=""
previous_image=""

cleanup() {
  local exit_status="$?"
  set +e
  docker rm --force \
    "${current_container}" "${previous_container}" "${restored_container}" \
    "${rollback_container}" "${upgraded_container}" >/dev/null 2>&1
  docker network rm "${network_name}" >/dev/null 2>&1
  if [[ "${acceptance_directory}" == /tmp/* ]]; then rm -rf -- "${acceptance_directory}"; fi
  return "${exit_status}"
}
trap cleanup EXIT

require_tools() {
  local missing=0
  for command_name in curl docker node openssl pnpm sha256sum sudo tar zstd; do
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
  node - "${current_release_directory}" "${current_version}" <<'NODE'
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const [directory, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(directory, "release-manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || manifest.product !== "AutoForge" || manifest.version !== expectedVersion) {
  throw new Error("Release manifest identity is invalid.");
}
if (manifest.artifacts.length !== 27) throw new Error(`Unexpected release asset count: ${manifest.artifacts.length}`);
for (const artifact of manifest.artifacts) {
  const path = join(directory, artifact.name);
  if (!statSync(path).isFile() || statSync(path).size !== artifact.sizeBytes) throw new Error(`Invalid asset ${artifact.name}`);
}
for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".spdx.json"))) {
  const sbom = JSON.parse(readFileSync(join(directory, name), "utf8"));
  if (!String(sbom.spdxVersion ?? "").startsWith("SPDX-")) throw new Error(`Invalid SPDX document ${name}`);
}
for (const required of ["LICENSE", "NOTICE", "THIRD_PARTY_LICENSES.json", "RUNNER_TOOLCHAIN_NOTICES.md", "CHANGELOG.md", "COMPATIBILITY.md"]) {
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
  local archive="${directory}/autoforge-backend-${version}-amd64.docker.tar.zst"
  local metadata="${directory}/autoforge-backend-${version}-amd64.image.json"
  zstd --decompress --stdout "${archive}" | docker load >/dev/null
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
  mkdir -p "${current_deploy_root}" "${toolchain_parent}"
  tar -xzf "${current_release_directory}/autoforge-deploy-${current_version}.tar.gz" \
    -C "${current_deploy_root}"
  tar -xzf \
    "${current_release_directory}/autoforge-runner-toolchain-linux-amd64-java21-testng7.11.0.tar.gz" \
    -C "${toolchain_parent}"
  (cd "${toolchain_parent}/autoforge-runner-toolchain" && sha256sum --check --strict file-sha256sums)
  "${toolchain_parent}/autoforge-runner-toolchain/jdk/bin/java" -version >/dev/null
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

read_platform_secret() {
  local data_directory="${1:?data directory is required}"
  local property="${2:?secret property is required}"
  node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets[process.argv[2]]" \
    "${data_directory}/config/platform.json" "${property}"
}

run_current_release_business() {
  local base_url="${1:?base URL is required}"
  local admin_token runner_token
  admin_token="$(read_platform_secret "${current_data}" adminBootstrapToken)"
  runner_token="$(read_platform_secret "${current_data}" runnerBootstrapToken)"
  E2E_BASE_URL="${base_url}" \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_token}" \
  E2E_RUNNER_BOOTSTRAP_TOKEN="${runner_token}" \
    pnpm exec playwright test --config playwright.full.config.ts \
      tests/e2e/case-suite-lifecycle.spec.ts \
      tests/e2e/identity-rbac.spec.ts \
      tests/e2e/jar-import.spec.ts \
      tests/e2e/management-operations.spec.ts \
      tests/e2e/platform-operations.spec.ts \
      tests/e2e/project-isolation.spec.ts

  docker cp "${current_container}:/app/resources/agents/linux-amd64/autoforge-agent" \
    "${release_agent}"
  chmod 0755 "${release_agent}"
  E2E_REAL_AGENT_EXTERNAL_BASE_URL="${base_url}" \
  E2E_PREBUILT_AGENT_BINARY="${release_agent}" \
  E2E_PREBUILT_TOOLCHAIN_ROOT="${toolchain_parent}/autoforge-runner-toolchain" \
  E2E_ADMIN_BOOTSTRAP_TOKEN="${admin_token}" \
  E2E_RUNNER_BOOTSTRAP_TOKEN="${runner_token}" \
    bash "${repository_root}/scripts/quality/test-real-agent.sh"

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

run_migration() {
  local image="${1:?image is required}"
  local data_directory="${2:?data directory is required}"
  docker run --rm --network none --pull never \
    --user "$(id -u):$(id -g)" \
    --volume "${data_directory}:/var/lib/autoforge" \
    "${image}" node apps/web/dist-server/server/migrate.js --data-dir=/var/lib/autoforge
}

initialize_current_acceptance_platform() {
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
  before_statistics="$(curl --fail --silent "${current_base_url}/api/v1/public/statistics")"
  stop_platform "${current_container}"
  backup_path="${acceptance_directory}/current-backup.tar.gz"
  backup_data "${current_data}" "${backup_path}"
  restore_data "${backup_path}" "${restored_data}"
  diff --recursive --brief "${current_data}" "${restored_data}"
  restored_base_url="$(start_platform "${restored_container}" "${current_image}" "${restored_data}")"
  after_statistics="$(curl --fail --silent "${restored_base_url}/api/v1/public/statistics")"
  [[ "${before_statistics}" == "${after_statistics}" ]]
  E2E_BASE_URL="${restored_base_url}" \
  E2E_ADMIN_BOOTSTRAP_TOKEN="$(read_platform_secret "${restored_data}" adminBootstrapToken)" \
    pnpm exec playwright test --config playwright.full.config.ts \
      tests/e2e/platform-restart.spec.ts
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

cd "${repository_root}"
require_tools
verify_current_release
verify_previous_release
prepare_release_content
current_image="$(load_release_image "${current_version}" "${current_release_directory}")"
previous_image="$(load_release_image "${previous_version}" "${previous_release_directory}")"
docker image inspect "${ldap_image}" >/dev/null
docker network create --internal "${network_name}" >/dev/null
initialize_current_acceptance_platform
current_base_url="$(start_platform "${current_container}" "${current_image}" "${current_data}")"
docker exec "${current_container}" node -e \
  "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))"
run_current_release_business "${current_base_url}"
verify_backup_restore "${current_base_url}"
verify_upgrade_and_rollback
printf 'Signed Release assets passed offline install, real Agent/toolchain, LDAP, backup, rollback and upgrade acceptance.\n'
