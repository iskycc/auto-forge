#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "Real LDAP acceptance is restricted to GitHub Actions because it builds the Web app and runs isolated containers." >&2
  exit 1
fi

readonly repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly acceptance_directory="$(mktemp -d)"
readonly run_identity="${GITHUB_RUN_ID//[^0-9A-Za-z_-]/_}-${GITHUB_RUN_ATTEMPT//[^0-9A-Za-z_-]/_}"
readonly external_network="${E2E_LDAP_EXTERNAL_NETWORK:-}"
readonly external_directory_host="${E2E_LDAP_EXTERNAL_DIRECTORY_HOST:-}"
readonly external_ldaps_port="${E2E_LDAP_LDAPS_PORT:-5636}"
readonly external_starttls_port="${E2E_LDAP_STARTTLS_PORT:-5389}"
readonly network_name="${external_network:-autoforge-ldap-${run_identity}}"
readonly ldap_container="autoforge-ldap-directory-${run_identity}"
readonly web_container="autoforge-ldap-web-${run_identity}"
readonly ldap_image="osixia/openldap:1.5.0@sha256:18742e9c449c9c1afe129d3f2f3ee15fb34cc43e5f940a20f3399728f41d7c28"
readonly node_image="node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203"

cleanup() {
  local exit_status="$?"
  set +e
  docker rm --force "${web_container}" "${ldap_container}" >/dev/null 2>&1
  if [[ -z "${external_network}" ]]; then
    docker network rm "${network_name}" >/dev/null 2>&1
  fi
  rm -rf -- "${acceptance_directory}"
  return "${exit_status}"
}
trap cleanup EXIT

wait_until() {
  local description="${1:?description is required}"
  shift
  for _ in $(seq 1 180); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Timed out waiting for ${description}." >&2
  docker logs "${ldap_container}" >&2 || true
  docker logs "${web_container}" >&2 || true
  return 1
}

prepare_certificates() {
  mkdir -p "${acceptance_directory}/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj "/CN=AutoForge LDAP Acceptance CA" \
    -keyout "${acceptance_directory}/certs/ca.key" \
    -out "${acceptance_directory}/certs/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes \
    -subj "/CN=ldap" \
    -keyout "${acceptance_directory}/certs/ldap.key" \
    -out "${acceptance_directory}/certs/ldap.csr" >/dev/null 2>&1
  openssl x509 -req -days 2 \
    -in "${acceptance_directory}/certs/ldap.csr" \
    -CA "${acceptance_directory}/certs/ca.crt" \
    -CAkey "${acceptance_directory}/certs/ca.key" \
    -CAcreateserial \
    -extfile "${repository_root}/tests/fixtures/ldap/server-cert.ext" \
    -out "${acceptance_directory}/certs/ldap.crt" >/dev/null 2>&1
  chmod 0600 "${acceptance_directory}/certs/ldap.key" "${acceptance_directory}/certs/ca.key"
}

prepare_directory_entries() {
  mkdir -p "${acceptance_directory}/ldif"
  cp "${repository_root}/tests/fixtures/ldap/50-directory.ldif" \
    "${acceptance_directory}/ldif/50-directory.ldif"
  for index in $(seq -w 1 50); do
    {
      printf 'dn: uid=page-%s,ou=people,dc=example,dc=test\n' "${index}"
      printf 'objectClass: inetOrgPerson\n'
      printf 'uid: page-%s\n' "${index}"
      printf 'cn: Page User %s\n' "${index}"
      printf 'sn: User%s\n' "${index}"
      printf 'displayName: Page User %s\n' "${index}"
      printf 'mail: page-%s@example.test\n' "${index}"
      printf 'userPassword: Directory!Page%s\n\n' "${index}"
    } >>"${acceptance_directory}/ldif/60-paged-users.ldif"
  done
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
        publicBaseUrl: "http://127.0.0.1:3101",
        publicDashboardRefreshSeconds: 5,
      },
    }, current.revision);
  ' "${acceptance_directory}/platform-data"
  E2E_ADMIN_BOOTSTRAP_TOKEN="$(node -p \
    "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).secrets.adminBootstrapToken" \
    "${acceptance_directory}/platform-data/config/platform.json")"
  export E2E_ADMIN_BOOTSTRAP_TOKEN
}

start_isolated_services() {
  local -a directory_publish_arguments=()
  if [[ -n "${external_directory_host}" ]]; then
    directory_publish_arguments=(
      --publish "127.0.0.1:${external_ldaps_port}:636"
      --publish "127.0.0.1:${external_starttls_port}:389"
    )
  fi
  if [[ "${E2E_LDAP_SKIP_PULL:-0}" != "1" ]]; then
    docker pull "${ldap_image}" >/dev/null
    if [[ -z "${E2E_LDAP_EXTERNAL_BASE_URL:-}" ]]; then
      docker pull "${node_image}" >/dev/null
    fi
  fi
  if [[ -z "${external_network}" ]]; then
    docker network create --internal "${network_name}" >/dev/null
  fi
  docker run --detach \
    --name "${ldap_container}" \
    --hostname ldap \
    --network "${network_name}" \
    --network-alias ldap \
    "${directory_publish_arguments[@]}" \
    --env LDAP_ORGANISATION="AutoForge Acceptance" \
    --env LDAP_DOMAIN="example.test" \
    --env LDAP_ADMIN_PASSWORD="Admin!Directory123" \
    --env LDAP_CONFIG_PASSWORD="Config!Directory123" \
    --env LDAP_TLS="true" \
    --env LDAP_TLS_CRT_FILENAME="ldap.crt" \
    --env LDAP_TLS_KEY_FILENAME="ldap.key" \
    --env LDAP_TLS_CA_CRT_FILENAME="ca.crt" \
    --env LDAP_TLS_VERIFY_CLIENT="never" \
    --volume "${acceptance_directory}/certs:/container/service/slapd/assets/certs:ro" \
    --volume "${acceptance_directory}/ldif:/container/service/slapd/assets/config/bootstrap/ldif/custom:ro" \
    --volume "${repository_root}/tests/fixtures/ldap/conflicting-user.ldif:/fixtures/conflicting-user.ldif:ro" \
    "${ldap_image}" --copy-service >/dev/null
  wait_until OpenLDAP docker exec "${ldap_container}" ldapsearch \
    -x -H ldap://127.0.0.1:389 \
    -D cn=admin,dc=example,dc=test -w "Admin!Directory123" \
    -b dc=example,dc=test -s base dn

  if [[ -n "${E2E_LDAP_EXTERNAL_BASE_URL:-}" ]]; then
    return
  fi

  docker run --detach \
    --name "${web_container}" \
    --network "${network_name}" \
    --publish 127.0.0.1:3101:3000 \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --user "$(id -u):$(id -g)" \
    --workdir /workspace \
    --volume "${repository_root}:/workspace:ro" \
    --volume "${acceptance_directory}/platform-data:/var/lib/autoforge" \
    "${node_image}" \
    node apps/web/dist-server/server/index.js --data-dir=/var/lib/autoforge >/dev/null
  wait_until "isolated AutoForge Web" curl --fail --silent \
    http://127.0.0.1:3101/api/v1/health/ready

  docker exec "${web_container}" node -e \
    "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))"
}

cd "${repository_root}"
for required_command in curl docker node openssl pnpm; do
  command -v "${required_command}" >/dev/null || {
    echo "Missing required command: ${required_command}" >&2
    exit 1
  }
done

prepare_certificates
prepare_directory_entries
if [[ -z "${E2E_LDAP_EXTERNAL_BASE_URL:-}" ]]; then
  initialize_platform
  pnpm --filter @autoforge/web build
elif [[ -z "${E2E_ADMIN_BOOTSTRAP_TOKEN:-}" ]]; then
  echo "E2E_ADMIN_BOOTSTRAP_TOKEN is required with an external AutoForge service." >&2
  exit 1
fi
start_isolated_services

export E2E_BASE_URL="${E2E_LDAP_EXTERNAL_BASE_URL:-http://127.0.0.1:3101}"
export E2E_LDAP_CA_FILE="${acceptance_directory}/certs/ca.crt"
export E2E_LDAP_CONTAINER="${ldap_container}"
if [[ -n "${external_directory_host}" ]]; then
  export E2E_LDAP_LDAPS_URL="ldaps://${external_directory_host}:${external_ldaps_port}"
  export E2E_LDAP_STARTTLS_URL="ldap://${external_directory_host}:${external_starttls_port}"
fi
pnpm exec playwright test --config playwright.full.config.ts tests/e2e/ldap-real.spec.ts
printf 'Real LDAPS/StartTLS identity acceptance passed inside an outbound-blocked service network.\n'
