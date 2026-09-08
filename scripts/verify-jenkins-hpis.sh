#!/usr/bin/env bash
set -euo pipefail

expected_plugin_version="${1:-1.2.0-SNAPSHOT}"
expected_step_api_version="${2:-700.v6e45cb_a_5a_a_21}"
verification_dir="$(mktemp -d)"
trap 'rm -rf "${verification_dir}"' EXIT

verify_hpi() {
  local short_name="$1"
  local step_class="$2"
  local hpi_path="integrations/jenkins/${short_name}/target/${short_name}.hpi"
  local plugin_jar="${verification_dir}/${short_name}.jar"

  test -s "${hpi_path}"
  unzip -p "${hpi_path}" META-INF/MANIFEST.MF \
    | tr -d '\r' > "${verification_dir}/${short_name}.manifest"
  grep -Fqx "Short-Name: ${short_name}" "${verification_dir}/${short_name}.manifest"
  local actual_plugin_version
  actual_plugin_version="$(sed -n 's/^Plugin-Version: //p' \
    "${verification_dir}/${short_name}.manifest")"
  [[ "${actual_plugin_version}" == "${expected_plugin_version}" \
    || "${actual_plugin_version}" == "${expected_plugin_version} "* ]]
  grep -Fq "Jenkins-Version: 2.479.3" "${verification_dir}/${short_name}.manifest"
  if ! grep -Fqx "Plugin-Dependencies: workflow-step-api:${expected_step_api_version}" \
    "${verification_dir}/${short_name}.manifest"; then
    printf '%s must require only workflow-step-api:%s\n' \
      "${short_name}" "${expected_step_api_version}" >&2
    exit 1
  fi
  unzip -p "${hpi_path}" "WEB-INF/lib/${short_name}.jar" > "${plugin_jar}"
  jar tf "${plugin_jar}" | grep -Fqx "${step_class}"
  local console_library_path
  console_library_path="$(unzip -Z1 "${hpi_path}" \
    | grep -E '^WEB-INF/lib/autoforge-console-[^/]+\.jar$')"
  unzip -p "${hpi_path}" "${console_library_path}" > "${verification_dir}/${short_name}-console.jar"
  jar tf "${verification_dir}/${short_name}-console.jar" \
    | grep -Fqx 'io/autoforge/jenkins/console/ExternalLinkNote.class'
  unzip -p "${verification_dir}/${short_name}-console.jar" META-INF/hudson.remoting.ClassFilter \
    | grep -Fqx 'io.autoforge.jenkins.console.ExternalLinkNote'
}

verify_hpi "autoforge-execution" \
  "io/autoforge/jenkins/execution/AutoForgeRunStep.class"
verify_hpi "autoforge-dependency-publisher" \
  "io/autoforge/jenkins/dependencies/AutoForgePublishDependenciesStep.class"
