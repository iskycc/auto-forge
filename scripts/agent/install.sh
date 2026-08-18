#!/usr/bin/env bash

set -Eeuo pipefail

readonly agent_binary="${1:?Agent binary path is required}"
readonly agent_configuration="${2:?Agent configuration path is required}"
readonly service_unit="${3:?systemd service unit path is required}"
readonly adapter_jar="${4:?Adapter JAR path is required}"
readonly service_account="${5:?service account is required}"
readonly ca_certificate="${6:-}"
readonly installation_mode="${7:-auto}"
# Optional for backward compatibility: older control planes omit the data directory.
readonly data_directory="${8:-/var/lib/autoforge-agent}"
readonly install_root="/opt/autoforge"
readonly installed_binary="${install_root}/bin/autoforge-agent"
readonly installed_adapter="${install_root}/lib/cotest-testng-adapter.jar"
readonly configuration_root="/etc/autoforge-agent"
readonly installed_configuration="${configuration_root}/config.json"
readonly installed_ca_certificate="${configuration_root}/control-plane-ca.pem"
readonly installed_service_unit="/etc/systemd/system/autoforge-agent.service"

case "${service_account}" in
  root | autoforge-agent) ;;
  *)
    echo "unsupported service account: ${service_account}" >&2
    exit 1
    ;;
esac

case "${data_directory}" in
  /*) ;;
  *)
    echo "data directory must be an absolute path: ${data_directory}" >&2
    exit 1
    ;;
esac
case "${data_directory}" in
  *".."*)
    echo "data directory must not contain ..: ${data_directory}" >&2
    exit 1
    ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "the installer must run as root" >&2
  exit 1
fi

if [ ! -r /etc/os-release ]; then
  echo "/etc/os-release is required" >&2
  exit 1
fi

# shellcheck disable=SC1091
. /etc/os-release
case "${installation_mode}" in
  ubuntu | opensuse | opensuse-leap | opensuse-tumbleweed) ;;
  auto)
    case "${ID:-}" in
      ubuntu | opensuse | opensuse-leap | opensuse-tumbleweed) ;;
      *)
        echo "unsupported operating system: ${ID:-unknown}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unsupported installation mode: ${installation_mode}" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | aarch64 | arm64) ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

for required_command in install systemctl id; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "required command is unavailable: ${required_command}" >&2
    exit 1
  fi
done
if [ "${service_account}" != "root" ] && ! id -u "${service_account}" >/dev/null 2>&1; then
  if ! command -v useradd >/dev/null 2>&1; then
    echo "useradd is required to create the unprivileged service account" >&2
    exit 1
  fi
  nologin_shell="/bin/false"
  for candidate in /usr/sbin/nologin /sbin/nologin; do
    if [ -x "${candidate}" ]; then
      nologin_shell="${candidate}"
      break
    fi
  done
  useradd --system --home-dir "${data_directory}" --shell "${nologin_shell}" \
    --user-group --comment "AutoForge Runner Agent" "${service_account}"
fi
readonly service_group="$(id -gn "${service_account}")"

"${agent_binary}" version >/dev/null
install -d -m 0755 "${install_root}/bin"
install -d -m 0755 "${install_root}/lib"
install -d -m 0700 -o "${service_account}" -g "${service_group}" \
  "${configuration_root}" "${data_directory}"

backup_suffix=".autoforge-previous"
for target in "${installed_binary}" "${installed_adapter}" "${installed_configuration}" "${installed_service_unit}"; do
  if [ -e "${target}" ]; then
    cp -p "${target}" "${target}${backup_suffix}"
  else
    rm -f "${target}${backup_suffix}"
  fi
done
if [ -n "${ca_certificate}" ] && [ -e "${installed_ca_certificate}" ]; then
  cp -p "${installed_ca_certificate}" "${installed_ca_certificate}${backup_suffix}"
fi

rollback_installation() {
  for target in "${installed_binary}" "${installed_adapter}" "${installed_configuration}" "${installed_service_unit}"; do
    if [ -e "${target}${backup_suffix}" ]; then
      mv -f "${target}${backup_suffix}" "${target}"
    else
      rm -f "${target}"
    fi
  done
  if [ -e "${installed_ca_certificate}${backup_suffix}" ]; then
    mv -f "${installed_ca_certificate}${backup_suffix}" "${installed_ca_certificate}"
  elif [ -n "${ca_certificate}" ]; then
    rm -f "${installed_ca_certificate}"
  fi
  systemctl daemon-reload || true
  systemctl restart autoforge-agent.service || true
}

install -m 0755 "${agent_binary}" "${installed_binary}"
install -m 0644 "${adapter_jar}" "${installed_adapter}"
install -m 0600 -o "${service_account}" -g "${service_group}" \
  "${agent_configuration}" "${installed_configuration}"
install -m 0644 "${service_unit}" "${installed_service_unit}"
if [ -n "${ca_certificate}" ]; then
  install -m 0600 -o "${service_account}" -g "${service_group}" \
    "${ca_certificate}" "${installed_ca_certificate}"
fi

if ! systemctl daemon-reload ||
  ! systemctl enable autoforge-agent.service ||
  ! systemctl restart autoforge-agent.service ||
  ! systemctl is-active --quiet autoforge-agent.service; then
  echo "Agent service failed to start; restoring the previous installation" >&2
  rollback_installation
  exit 1
fi

# Retain one verified predecessor so an administrator can perform an offline,
# host-local rollback without fetching another release asset.
printf '%s\n' "AutoForge Agent installation completed"
