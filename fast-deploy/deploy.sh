#!/usr/bin/env bash
set -Eeuo pipefail
readonly task_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${task_directory}"
if [[ ! -f host-role || ! -f .env ]]; then
  printf '%s\n' 'Use the generated/node-a, node-b or node-c directory produced by prepare.sh.' >&2
  exit 1
fi
readonly task_role="$(cat host-role)"
readonly task_action="${1:-up}"
if [[ ! "${task_action}" =~ ^(up|check|full|worker|log-database|status|logs|stop)$ ]]; then
  printf '%s\n' 'Usage: bash deploy.sh up|check|full|worker|log-database|status|logs|stop' >&2
  exit 1
fi
if [[ ! "${task_role}" =~ ^node-(a|b|c)$ ]]; then
  printf '%s\n' 'Unknown host role; restore the generated host-role file.' >&2
  exit 1
fi

compose() {
  docker compose --project-directory "${task_directory}" \
    --env-file "${task_directory}/.env" -f "${task_directory}/docker-compose.yml" "$@"
}
# Inspection and shutdown must remain available when a credential file is lost.
case "${task_action}" in
  status) compose --profile worker --profile log-database ps --all; exit 0 ;;
  logs) compose --profile worker --profile log-database logs --tail 100; exit 0 ;;
  stop) compose --profile worker --profile log-database stop; exit 0 ;;
esac

require_secret() {
  local task_secret="${1:?secret filename is required}"
  if [[ ! -f "${task_secret}" ]]; then
    printf 'Secret %s is missing; restore the file from the original generated configuration.\n' "${task_secret}" >&2
    exit 1
  fi
  if [[ ! -s "${task_secret}" || -z "$(tr -d '\r\n' < "${task_secret}")" ]]; then
    printf 'Secret %s is empty; restore the original credential before starting Docker.\n' "${task_secret}" >&2
    exit 1
  fi
}

task_services=()
case "${task_role}" in
  node-a) task_services=(web) ;;
  node-b)
    for task_secret in postgres-password redis-password redis.conf; do require_secret "secrets/${task_secret}"; done
    task_services=(postgres redis)
    ;;
  node-c)
    for task_secret in nats.conf minio-root-user minio-root-password; do require_secret "secrets/${task_secret}"; done
    task_services=(nats minio minio-init)
    ;;
esac
if [[ "${task_action}" == full && "${task_role}" != node-a ]]; then
  printf '%s\n' 'Full initialization belongs on node-a.' >&2
  exit 1
fi
if [[ "${task_action}" == full ]]; then
  require_secret setup-values.json
  require_secret initialize-platform.mjs
fi
if [[ "${task_action}" == worker ]]; then
  if [[ "${task_role}" != node-a || ! -f data/platform/config/platform.json ]] || \
    ! grep -Eq '"mode"[[:space:]]*:[[:space:]]*"full"' data/platform/config/platform.json; then
    printf '%s\n' 'Configure Full mode on node-a /setup and restart web before starting its worker.' >&2
    exit 1
  fi
  task_services=(worker)
fi
if [[ "${task_action}" == log-database ]]; then
  if [[ "${task_role}" != node-c ]]; then printf '%s\n' 'Log database belongs on node-c.' >&2; exit 1; fi
  require_secret secrets/log-postgres-password
  task_services=(log-postgres)
fi

compose config --quiet
task_images="$(compose --profile worker --profile log-database config --images "${task_services[@]}")"
while IFS= read -r task_image; do
  if ! docker image inspect "${task_image}" >/dev/null 2>&1; then
    printf 'Required offline image %s is missing. Load its verified Docker tar first.\n' "${task_image}" >&2
    exit 1
  fi
done <<< "${task_images}"
if [[ "${task_action}" == check ]]; then
  printf 'Configuration, credentials and local images passed for %s.\n' "${task_role}"
  exit 0
fi
if [[ "$(id -u)" != 0 ]]; then printf '%s\n' 'Run this startup command with sudo or as root to initialize bind directory ownership.' >&2; exit 1; fi
case "${task_role}" in
  node-a) install -d -o 1000 -g 1000 -m 0700 data/platform ;;
  node-b) install -d -m 0700 data/postgres data/redis ;;
  node-c) install -d -m 0700 data/minio data/nats data/log-postgres ;;
esac
case "${task_action}" in
  full)
    compose up --detach --wait --wait-timeout 180 web
    # The runtime drops capabilities; even uid 0 cannot read the private node-owned config.
    chown 1000:1000 initialize-platform.mjs setup-values.json
    compose run --rm --no-deps --user 1000:1000 \
      --volume "${task_directory}/initialize-platform.mjs:/opt/initialize-platform.mjs:ro" \
      --volume "${task_directory}/setup-values.json:/opt/setup-values.json:ro" \
      web node /opt/initialize-platform.mjs
    compose restart web
    compose up --detach --wait --wait-timeout 180 web
    compose --profile worker up --detach --wait --wait-timeout 180 worker
    ;;
  worker) compose --profile worker up --detach --wait --wait-timeout 180 worker ;;
  log-database) compose --profile log-database up --detach --wait --wait-timeout 180 log-postgres ;;
  up)
    if [[ "${task_role}" == node-c ]]; then
      compose up --detach --wait --wait-timeout 180 minio nats
      compose run --rm --no-deps minio-init
    else
      compose up --detach --wait --wait-timeout 180 "${task_services[@]}"
    fi
    ;;
esac
compose --profile worker --profile log-database ps --all
