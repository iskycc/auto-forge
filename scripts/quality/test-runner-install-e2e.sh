#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Runner SSH installation acceptance is restricted to GitHub Actions because it builds Web/SSH images and starts privileged systemd." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly acceptance_directory="$(mktemp -d)"
readonly run_identity="${GITHUB_RUN_ID//[^0-9A-Za-z_-]/_}-${GITHUB_RUN_ATTEMPT//[^0-9A-Za-z_-]/_}"
readonly network_name="autoforge-ssh-${run_identity}"
readonly web_container="autoforge-ssh-web-${run_identity}"
readonly ssh_container="autoforge-ssh-host-${run_identity}"
readonly fixture_image="autoforge/ssh-fixture:${run_identity}"
readonly ubuntu_image="ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea"
readonly node_image="node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203"

cleanup() {
  local exit_status="$?"
  set +e
  docker rm --force "${ssh_container}" "${web_container}" >/dev/null 2>&1
  docker network rm "${network_name}" >/dev/null 2>&1
  docker image rm --force "${fixture_image}" >/dev/null 2>&1
  rm -rf -- "${acceptance_directory}"
  return "${exit_status}"
}
trap cleanup EXIT

wait_until() {
  local description="${1:?description is required}"
  shift
  for _ in $(seq 1 240); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Timed out waiting for ${description}." >&2
  docker logs "${web_container}" >&2 || true
  docker logs "${ssh_container}" >&2 || true
  return 1
}

initialize_platform() {
  mkdir -p "${acceptance_directory}/platform-data"
  node --input-type=module -e '
    import { PlatformConfigurationStore } from "./packages/platform-config/src/platform-configuration.ts";
    const [dataDirectory] = process.argv.slice(1);
    const store = new PlatformConfigurationStore(dataDirectory);
    const current = store.initialize();
    store.replace({
      ...current,
      web: {
        ...current.web,
        hostname: "0.0.0.0",
        port: 3000,
        publicBaseUrl: "http://127.0.0.1:3000",
        publicDashboardRefreshSeconds: 5,
      },
    }, current.revision);
  ' "${acceptance_directory}/platform-data"
  E2E_ADMIN_BOOTSTRAP_TOKEN="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.adminBootstrapToken" \
    "${acceptance_directory}/platform-data/config/platform.json")"
  export E2E_ADMIN_BOOTSTRAP_TOKEN
}

start_services() {
  docker pull "${node_image}" >/dev/null
  docker build \
    --build-arg "UBUNTU_IMAGE=${ubuntu_image}" \
    --tag "${fixture_image}" \
    "${repository_root}/tests/fixtures/ssh" >/dev/null
  docker network create --internal "${network_name}" >/dev/null

  docker run --detach \
    --name "${web_container}" \
    --network "${network_name}" \
    --publish 127.0.0.1:3102:3000 \
    --publish 127.0.0.1:2222:22 \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --user "$(id -u):$(id -g)" \
    --workdir /workspace \
    --volume "${repository_root}:/workspace:ro" \
    --volume "${acceptance_directory}/platform-data:/var/lib/autoforge" \
    "${node_image}" \
    node apps/web/dist-server/server/index.js --data-dir=/var/lib/autoforge >/dev/null
  wait_until "AutoForge Web" curl --fail --silent http://127.0.0.1:3102/api/v1/health/ready

  docker run --detach \
    --name "${ssh_container}" \
    --network "container:${web_container}" \
    --cgroupns private \
    --privileged \
    --tmpfs /run:rw,nosuid,size=64m \
    --tmpfs /run/lock:rw,nosuid,size=16m \
    "${fixture_image}" >/dev/null
  wait_until SSH docker exec "${ssh_container}" systemctl is-active --quiet ssh.service

  docker exec "${web_container}" node -e \
    "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))"
  docker exec "${ssh_container}" sh -c \
    "if curl --fail --silent --connect-timeout 2 --max-time 3 https://example.com >/dev/null 2>&1; then exit 1; fi"
}

prepare_agent_ca() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj "/CN=AutoForge Runner Control Plane Acceptance CA" \
    -keyout "${acceptance_directory}/runner-ca.key" \
    -out "${acceptance_directory}/runner-ca.crt" >/dev/null 2>&1
  chmod 0600 "${acceptance_directory}/runner-ca.key"
}

cd "${repository_root}"
for required_command in curl docker node openssl pnpm; do
  command -v "${required_command}" >/dev/null || {
    echo "Missing required command: ${required_command}" >&2
    exit 1
  }
done

initialize_platform
prepare_agent_ca
pnpm build:agent-resources
pnpm --filter @autoforge/web build
start_services

export E2E_BASE_URL="http://127.0.0.1:3102"
export E2E_SSH_CONTAINER="${ssh_container}"
export E2E_SSH_CA_FILE="${acceptance_directory}/runner-ca.crt"
pnpm exec playwright test --config playwright.full.config.ts tests/e2e/runner-install.spec.ts
printf 'Password and Keyboard-Interactive SSH probe, offline systemd installation and Runner lifecycle passed.\n'
