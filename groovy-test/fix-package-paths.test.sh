#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="${repository_root}/groovy-test/fixPackagePaths.groovy"

fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT

run_fixer() {
  if [[ -n "${GROOVY_JAR:-}" ]]; then
    java -cp "${GROOVY_JAR}" groovy.ui.GroovyMain "${script_path}" "$@"
  elif command -v groovy >/dev/null 2>&1; then
    groovy "${script_path}" "$@"
  else
    echo 'Install Groovy or set GROOVY_JAR to run this test.' >&2
    return 1
  fi
}

mkdir -p "${fixture_root}/source/com/example/nested"
mkdir -p "${fixture_root}/source/defaults"
mkdir -p "${fixture_root}/source/unchanged"

printf '%s\n' 'package wrong.name // keep this note' '' 'class RootCase {}' >"${fixture_root}/source/RootCase.groovy"
printf '%s\n' 'package wrong.name' '' 'class GroovyCase {}' >"${fixture_root}/source/com/example/GroovyCase.groovy"
printf '%s\n' '/* license */' '' 'package wrong.name;' '' 'class JavaCase {}' >"${fixture_root}/source/com/example/nested/JavaCase.java"
printf '%s\n' '// header' 'class MissingPackageCase {}' >"${fixture_root}/source/defaults/MissingPackageCase.groovy"
printf '%s\n' 'package unchanged' '' 'class UnchangedCase {}' >"${fixture_root}/source/unchanged/UnchangedCase.groovy"

before_dry_run="$(sha256sum "${fixture_root}/source/com/example/GroovyCase.groovy")"
dry_run_output="$(run_fixer --dry-run "${fixture_root}/source")"
after_dry_run="$(sha256sum "${fixture_root}/source/com/example/GroovyCase.groovy")"
[[ "${before_dry_run}" == "${after_dry_run}" ]]
grep -Fq '4 package declaration(s) would be corrected.' <<<"${dry_run_output}"

run_output="$(run_fixer "${fixture_root}/source")"
grep -Fq '4 package declaration(s) corrected.' <<<"${run_output}"
grep -Fqx '// keep this note' "${fixture_root}/source/RootCase.groovy"
if grep -Eq '^[[:space:]]*package[[:space:]]' "${fixture_root}/source/RootCase.groovy"; then
  echo 'Expected a root source to use the default package.' >&2
  exit 1
fi
grep -Fqx 'package com.example' "${fixture_root}/source/com/example/GroovyCase.groovy"
grep -Fqx 'package com.example.nested;' "${fixture_root}/source/com/example/nested/JavaCase.java"
grep -Fqx 'package defaults' "${fixture_root}/source/defaults/MissingPackageCase.groovy"
grep -Fqx 'package unchanged' "${fixture_root}/source/unchanged/UnchangedCase.groovy"

idempotent_output="$(run_fixer "${fixture_root}/source")"
grep -Fq '0 package declaration(s) corrected.' <<<"${idempotent_output}"

mkdir -p "${fixture_root}/scoped/child"
printf '%s\n' 'package incorrect' '' 'class ScopedCase {}' >"${fixture_root}/scoped/child/ScopedCase.groovy"
run_fixer --base-package com.acme "${fixture_root}/scoped" >/dev/null
grep -Fqx 'package com.acme.child' "${fixture_root}/scoped/child/ScopedCase.groovy"

mkdir -p "${fixture_root}/invalid/valid" "${fixture_root}/invalid/not-valid"
printf '%s\n' 'package old' 'class ValidCase {}' >"${fixture_root}/invalid/valid/ValidCase.groovy"
printf '%s\n' 'package old' 'class InvalidCase {}' >"${fixture_root}/invalid/not-valid/InvalidCase.groovy"
valid_before="$(sha256sum "${fixture_root}/invalid/valid/ValidCase.groovy")"
if run_fixer "${fixture_root}/invalid" >/dev/null 2>&1; then
  echo 'Expected an invalid directory name to fail validation.' >&2
  exit 1
fi
valid_after="$(sha256sum "${fixture_root}/invalid/valid/ValidCase.groovy")"
[[ "${valid_before}" == "${valid_after}" ]]

echo 'fix-package-paths tests passed'
