#!/usr/bin/env bash
set -euo pipefail

expected_plugin_version="${1:-1.0.2-SNAPSHOT}"
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
  grep -Fq "workflow-step-api:724.v538c2362b_dfb_" "${verification_dir}/${short_name}.manifest"
  unzip -p "${hpi_path}" "WEB-INF/lib/${short_name}.jar" > "${plugin_jar}"
  jar tf "${plugin_jar}" | grep -Fqx "${step_class}"
}

verify_hpi "autoforge-execution" \
  "io/autoforge/jenkins/execution/AutoForgeRunStep.class"
verify_hpi "autoforge-dependency-publisher" \
  "io/autoforge/jenkins/dependencies/AutoForgePublishDependenciesStep.class"
