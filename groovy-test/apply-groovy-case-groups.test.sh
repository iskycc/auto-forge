#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT

source_root="${fixture_root}/cases"
workbook="${source_root}/normal-groovy-cases.xlsx"
compiled_classes="${repository_root}/groovy-test/target/classes"
dependency_directory="${repository_root}/groovy-test/target/dependency"
mkdir -p "${source_root}"

if [[ ! -f "${compiled_classes}/ApplyGroovyCaseGroups.class" ]]; then
  echo 'Build groovy-test classes before running this regression test.' >&2
  exit 1
fi

runtime_classpath="${compiled_classes}:${dependency_directory}/*"
javap -classpath "${compiled_classes}" ApplyGroovyCaseGroups \
  | grep -Fq 'public static void main(java.lang.String[]);'

printf '%s\n' \
  'package sample.cases' \
  '' \
  '@Grab("missing.fixture:must-not-be-resolved:1.0")' \
  'class EmptyParenCase {' \
  '    @Test()' \
  '    void testEmptyGroup() { assert true }' \
  '' \
  '    String annotationExample() {' \
  '        return "@Test(group = [TestCaseGroup.L2])"' \
  '    }' \
  '}' \
  '' \
  'class ExistingGroupCase {' \
  '    @Test(group = [TestCaseGroup.Completed])' \
  '    void testExistingGroup() { assert true }' \
  '}' >"${source_root}/01MixedCases.groovy"

printf '%s\n' \
  'package sample.cases' \
  '' \
  'class WrongLevelCase {' \
  '    @org.testng.annotations.Test(' \
  '        group = [TestCaseGroup.Completed, TestCaseGroup.L1],' \
  '        description = "replace an existing level")' \
  '    void testWrongLevel() { assert true }' \
  '}' >"${source_root}/02WrongLevelCase.groovy"

printf '%s\n' \
  'package sample.cases' \
  '' \
  'class BareAnnotationCase {' \
  '    @Test' \
  '    void testBareAnnotation() { assert true }' \
  '}' >"${source_root}/03BareAnnotationCase.groovy"

printf '%s\n' \
  'package sample.cases' \
  '' \
  '@Test(group = [])' \
  'class ClassAndMethodCase {' \
  '    @Test(description = "method annotation")' \
  '    void testClassAndMethod() { assert true }' \
  '}' >"${source_root}/04ClassAndMethodCase.groovy"

git -C "${source_root}" init -q
git -C "${source_root}" config user.name 'Groovy group test'
git -C "${source_root}" config user.email 'groovy-group-test@example.invalid'
git -C "${source_root}" add -- .
git -C "${source_root}" commit -qm 'test fixture baseline'

java -cp "${runtime_classpath}" AnalyzeNormalGroovyCases \
  --source "${source_root}" --output "${workbook}" --no-review >/dev/null

review_output="$(printf '01501' | java -cp "${runtime_classpath}" AnalyzeNormalGroovyCases \
  --source "${source_root}" --output "${workbook}")"
grep -Fq '人工分级已完成，所有导出用例均已标记。' <<<"${review_output}"

before_dry_run="$(sha256sum "${source_root}"/*.groovy)"
dry_run_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}" --dry-run)"
after_dry_run="$(sha256sum "${source_root}"/*.groovy)"
grep -Fq 'Would update 6 @Test annotation(s) in 4 Groovy file(s); 0 annotation(s) were already correct.' \
  <<<"${dry_run_output}"
grep -Fq 'Dry run only; no Groovy source file was changed.' <<<"${dry_run_output}"
if [[ "${before_dry_run}" != "${after_dry_run}" ]]; then
  echo 'Dry run changed a Groovy source file.' >&2
  exit 1
fi
if [[ -n "$(git -C "${source_root}" diff --cached --name-only)" ]]; then
  echo 'Dry run staged a Groovy source file.' >&2
  exit 1
fi

apply_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}")"
grep -Fq 'Loaded 5 graded case(s)' <<<"${apply_output}"
grep -Fq 'Updated 6 @Test annotation(s) in 4 Groovy file(s); 0 annotation(s) were already correct.' \
  <<<"${apply_output}"
grep -Fq 'Ran git add after 5 changed case(s).' <<<"${apply_output}"
if [[ "$(grep -Fc 'then ran git add --' <<<"${apply_output}")" -ne 5 ]]; then
  echo 'git add was not run once after each changed case.' >&2
  exit 1
fi
if [[ "$(git -C "${source_root}" diff --cached --name-only | wc -l)" -ne 4 ]]; then
  echo 'The changed Groovy files were not staged.' >&2
  exit 1
fi

grep -Fq '@Test(group = [TestCaseGroup.L0])' "${source_root}/01MixedCases.groovy"
grep -Fq '@Test(group = [TestCaseGroup.Completed, TestCaseGroup.L1])' \
  "${source_root}/01MixedCases.groovy"
grep -Fq 'return "@Test(group = [TestCaseGroup.L2])"' \
  "${source_root}/01MixedCases.groovy"
grep -Fq 'group = [TestCaseGroup.Completed, TestCaseGroup.L2],' \
  "${source_root}/02WrongLevelCase.groovy"
if grep -Fq 'group = [TestCaseGroup.Completed, TestCaseGroup.L1],' \
  "${source_root}/02WrongLevelCase.groovy"; then
  echo 'The old L1 marker was not replaced by the workbook L2 level.' >&2
  exit 1
fi
grep -Fq '@Test(group = [TestCaseGroup.L0])' \
  "${source_root}/03BareAnnotationCase.groovy"
grep -Fq '@Test(group = [TestCaseGroup.L1])' \
  "${source_root}/04ClassAndMethodCase.groovy"
grep -Fq '@Test(description = "method annotation", group = [TestCaseGroup.L1])' \
  "${source_root}/04ClassAndMethodCase.groovy"

after_apply="$(sha256sum "${source_root}"/*.groovy)"
idempotent_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}")"
after_idempotent_run="$(sha256sum "${source_root}"/*.groovy)"
grep -Fq 'Updated 0 @Test annotation(s) in 0 Groovy file(s); 6 annotation(s) were already correct.' \
  <<<"${idempotent_output}"
grep -Fq 'Ran git add after 0 changed case(s).' <<<"${idempotent_output}"
if [[ "${after_apply}" != "${after_idempotent_run}" ]]; then
  echo 'An idempotent rerun changed a Groovy source file.' >&2
  exit 1
fi

sed -i '0,/@Test(group = \[TestCaseGroup.L0\])/s//\@Test(group = [TestCaseGroup.L1])/' \
  "${source_root}/01MixedCases.groovy"
sed -i '/@Test(group = \[TestCaseGroup.L0\])/d' \
  "${source_root}/03BareAnnotationCase.groovy"
before_failed_validation="$(sha256sum "${source_root}"/*.groovy)"
set +e
failed_validation_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}" 2>&1)"
failed_validation_status=$?
set -e
after_failed_validation="$(sha256sum "${source_root}"/*.groovy)"
if [[ ${failed_validation_status} -ne 2 ]]; then
  echo 'A missing @Test annotation did not fail validation.' >&2
  exit 1
fi
grep -Fq 'no class-level or method-level @Test annotation was found' \
  <<<"${failed_validation_output}"
if [[ "${before_failed_validation}" != "${after_failed_validation}" ]]; then
  echo 'Validation failure caused a partial source update.' >&2
  exit 1
fi

echo 'apply-groovy-case-groups tests passed'
