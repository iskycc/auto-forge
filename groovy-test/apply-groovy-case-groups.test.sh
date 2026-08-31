#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture_root="$(mktemp -d)"
trap 'rm -rf -- "${fixture_root}"' EXIT

source_root="${fixture_root}/cases"
workbook="${source_root}/normal-groovy-cases.xlsx"
unreviewed_workbook="${source_root}/unreviewed-groovy-cases.xlsx"
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
  'import java.util.List' \
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

printf '%s\n' \
  'package sample.cases' \
  '' \
  'class PluralGroupsCase {' \
  '    @Test(groups = [TestCaseGroup.Completed])' \
  '    void testPluralGroups() { assert true }' \
  '}' >"${source_root}/05PluralGroupsCase.groovy"

printf '%s\n' \
  'package sample.cases' \
  '' \
  'class ExpectedErrorCase {' \
  '    @Test(group = [TestCaseGroup.Completed])' \
  '    void testExpectedError() { assert true }' \
  '}' >"${source_root}/06ExpectedErrorCase.groovy"

git -C "${source_root}" init -q
git -C "${source_root}" config user.name 'Groovy group test'
git -C "${source_root}" config user.email 'groovy-group-test@example.invalid'
git -C "${source_root}" add -- .
git -C "${source_root}" commit -qm 'test fixture baseline'

java -cp "${runtime_classpath}" AnalyzeNormalGroovyCases \
  --source "${source_root}" --output "${workbook}" --no-review >/dev/null
cp "${workbook}" "${unreviewed_workbook}"

set +e
unreviewed_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${unreviewed_workbook}" --dry-run 2>&1)"
unreviewed_status=$?
set -e
if [[ ${unreviewed_status} -ne 2 ]]; then
  echo 'An unreviewed workbook did not fail with a diagnostic error.' >&2
  exit 1
fi
grep -Fq "Worksheet '导出用例' contains case rows but has no reviewed level column." \
  <<<"${unreviewed_output}"
grep -Fq 'Complete and save the manual review before applying groups.' \
  <<<"${unreviewed_output}"

review_output="$(printf '015010' | java -cp "${runtime_classpath}" AnalyzeNormalGroovyCases \
  --source "${source_root}" --output "${workbook}")"
grep -Fq '人工分级已完成，所有导出用例均已标记。' <<<"${review_output}"

node --input-type=module - "${repository_root}" "${workbook}" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const repositoryRoot = process.argv[2];
const workbookPath = process.argv[3];
const xlsx = await import(
  pathToFileURL(`${repositoryRoot}/packages/ddt-import/node_modules/xlsx/xlsx.mjs`).href
);
const workbook = xlsx.read(readFileSync(workbookPath));
for (const sheetName of ["导出用例", "排除明细"]) {
  const sheet = workbook.Sheets[sheetName];
  const range = xlsx.utils.decode_range(sheet["!ref"]);
  let levelColumn = -1;
  let classColumn = -1;
  for (let column = range.s.c; column <= range.e.c; column++) {
    const cell = sheet[xlsx.utils.encode_cell({ r: 0, c: column })];
    if (cell?.v === "类名") classColumn = column;
    if (cell?.v === "人工等级") {
      levelColumn = column;
      cell.v = sheetName === "导出用例" ? "用例等级" : "Case Level";
      cell.w = cell.v;
      break;
    }
  }
  if (levelColumn < 0) continue;
  let transformedLevel = 0;
  for (let row = 1; row <= range.e.r; row++) {
    const address = xlsx.utils.encode_cell({ r: row, c: levelColumn });
    const cell = sheet[address];
    if (!cell?.v) continue;
    const level = String(cell.v).trim().toUpperCase();
    if (transformedLevel === 0) {
      sheet[address] = { t: "s", f: `="${level}"`, v: level };
    } else if (level === "L0") {
      sheet[address] = { t: "s", v: "L0级" };
    } else if (level === "L1") {
      sheet[address] = { t: "s", v: "等级 L1" };
    } else if (level === "L2") {
      sheet[address] = { t: "n", v: 5 };
    }
    transformedLevel++;
  }
  if (sheetName === "排除明细" && classColumn >= 0) {
    for (let row = 1; row <= range.e.r; row++) {
      const classCell = sheet[xlsx.utils.encode_cell({ r: row, c: classColumn })];
      if (classCell?.v === "ExpectedErrorCase") {
        const levelAddress = xlsx.utils.encode_cell({ r: row, c: levelColumn });
        sheet[levelAddress] = { t: "s", v: "L0" };
      }
    }
  }
}
writeFileSync(workbookPath, xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }));
NODE

before_dry_run="$(sha256sum "${source_root}"/*.groovy)"
dry_run_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}" --dry-run)"
after_dry_run="$(sha256sum "${source_root}"/*.groovy)"
grep -Fq 'Would update 8 @Test annotation(s) in 6 Groovy file(s); 0 annotation(s) were already correct.' \
  <<<"${dry_run_output}"
grep -Fq 'Would add 6 missing cotest.define.TestCaseGroup import(s).' \
  <<<"${dry_run_output}"
grep -Fq 'Planned cotest.define.TestCaseGroup imports for 6 Groovy file(s):' \
  <<<"${dry_run_output}"
grep -Fq '<not imported> -> import cotest.define.TestCaseGroup' \
  <<<"${dry_run_output}"
grep -Fq 'Dry run only; no Groovy source file was changed.' <<<"${dry_run_output}"
grep -Fq '[1/7] sample.cases.EmptyParenCase (L0) - 01MixedCases.groovy' \
  <<<"${dry_run_output}"
grep -Fq 'sample.cases.ExpectedErrorCase (L2) - 06ExpectedErrorCase.groovy' \
  <<<"${dry_run_output}"
grep -Fq '@Test line 5 (group): <not set> -> [TestCaseGroup.L0]' <<<"${dry_run_output}"
grep -Fq '[TestCaseGroup.Completed] -> [TestCaseGroup.Completed, TestCaseGroup.L1]' \
  <<<"${dry_run_output}"
grep -Fq '@Test line 4 (groups): [TestCaseGroup.Completed] -> [TestCaseGroup.Completed, TestCaseGroup.L0]' \
  <<<"${dry_run_output}"
if [[ "$(grep -Ec '^\[[1-7]/7\]' <<<"${dry_run_output}")" -ne 7 ]]; then
  echo 'Dry run did not print every case group.' >&2
  exit 1
fi
if [[ "${before_dry_run}" != "${after_dry_run}" ]]; then
  echo 'Dry run changed a Groovy source file.' >&2
  exit 1
fi
if [[ -n "$(git -C "${source_root}" diff --cached --name-only)" ]]; then
  echo 'Dry run staged a Groovy source file.' >&2
  exit 1
fi

before_cancel="$(sha256sum "${source_root}"/*.groovy)"
cancel_output="$(printf 'n\n' | java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}")"
after_cancel="$(sha256sum "${source_root}"/*.groovy)"
grep -Fq 'Apply all group/import changes and run git add after each changed case? [y/N]:' \
  <<<"${cancel_output}"
grep -Fq 'Cancelled by user; no Groovy source file was changed or staged.' \
  <<<"${cancel_output}"
if [[ "${before_cancel}" != "${after_cancel}" ]] \
  || [[ -n "$(git -C "${source_root}" diff --cached --name-only)" ]]; then
  echo 'Declining confirmation changed or staged a Groovy source file.' >&2
  exit 1
fi

apply_output="$(printf 'y\n' | java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}")"
grep -Fq 'Loaded 7 workbook case(s) across 6 source file(s)' <<<"${apply_output}"
grep -Fq '(5 from 导出用例; 2 from 排除明细 forced to L2).' <<<"${apply_output}"
grep -Fq 'Updated 8 @Test annotation(s) in 6 Groovy file(s); 0 annotation(s) were already correct.' \
  <<<"${apply_output}"
grep -Fq 'Added 6 missing cotest.define.TestCaseGroup import(s).' <<<"${apply_output}"
grep -Fq 'Ran git add after 7 changed case(s).' <<<"${apply_output}"
preview_line="$(grep -nF 'Planned @Test group values for 7 case(s):' <<<"${apply_output}" | cut -d: -f1)"
confirmation_line="$(grep -nF 'Apply all group/import changes and run git add after each changed case?' \
  <<<"${apply_output}" | cut -d: -f1)"
first_apply_line="$(grep -nF 'then ran git add --' <<<"${apply_output}" | head -n 1 | cut -d: -f1)"
if (( preview_line >= confirmation_line || confirmation_line >= first_apply_line )); then
  echo 'Group preview and confirmation were not completed before source updates.' >&2
  exit 1
fi
if [[ "$(grep -Fc 'then ran git add --' <<<"${apply_output}")" -ne 7 ]]; then
  echo 'git add was not run once after each changed case.' >&2
  exit 1
fi
if [[ "$(git -C "${source_root}" diff --cached --name-only | wc -l)" -ne 6 ]]; then
  echo 'The changed Groovy files were not staged.' >&2
  exit 1
fi

for groovy_file in "${source_root}"/*.groovy; do
  if [[ "$(grep -Fxc 'import cotest.define.TestCaseGroup' "${groovy_file}")" -ne 1 ]]; then
    echo "The exact TestCaseGroup import was not added once to ${groovy_file}." >&2
    exit 1
  fi
done
if [[ "$(sed -n '2p' "${source_root}/01MixedCases.groovy")" \
    != 'import cotest.define.TestCaseGroup' ]] \
  || [[ "$(sed -n '4p' "${source_root}/02WrongLevelCase.groovy")" \
    != 'import cotest.define.TestCaseGroup' ]]; then
  echo 'The TestCaseGroup import was not placed after the package/import block.' >&2
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
grep -Fq '@Test(groups = [TestCaseGroup.Completed, TestCaseGroup.L0])' \
  "${source_root}/05PluralGroupsCase.groovy"
grep -Fq '@Test(group = [TestCaseGroup.Completed, TestCaseGroup.L2])' \
  "${source_root}/06ExpectedErrorCase.groovy"
if grep -Fq '@Test(groups = [TestCaseGroup.Completed], group =' \
  "${source_root}/05PluralGroupsCase.groovy"; then
  echo 'A singular group member was added beside an existing plural groups member.' >&2
  exit 1
fi

sed -i '/^import cotest\.define\.TestCaseGroup$/d' "${source_root}"/*.groovy
git -C "${source_root}" add -- '*.groovy'
git -C "${source_root}" commit -qm 'fixture with reviewed groups and missing imports'

before_import_dry_run="$(sha256sum "${source_root}"/*.groovy)"
import_dry_run_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}" --dry-run)"
after_import_dry_run="$(sha256sum "${source_root}"/*.groovy)"
grep -Fq 'Would update 0 @Test annotation(s) in 6 Groovy file(s); 8 annotation(s) were already correct.' \
  <<<"${import_dry_run_output}"
grep -Fq 'Would add 6 missing cotest.define.TestCaseGroup import(s).' \
  <<<"${import_dry_run_output}"
if [[ "${before_import_dry_run}" != "${after_import_dry_run}" ]] \
  || [[ -n "$(git -C "${source_root}" diff --cached --name-only)" ]]; then
  echo 'The import-only dry run changed or staged a Groovy source file.' >&2
  exit 1
fi

import_apply_output="$(printf 'y\n' | java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}")"
grep -Fq 'Updated 0 @Test annotation(s) in 6 Groovy file(s); 8 annotation(s) were already correct.' \
  <<<"${import_apply_output}"
grep -Fq 'Added 6 missing cotest.define.TestCaseGroup import(s).' \
  <<<"${import_apply_output}"
grep -Fq 'Ran git add after 6 changed case(s).' <<<"${import_apply_output}"
if [[ "$(grep -Fc 'then ran git add --' <<<"${import_apply_output}")" -ne 6 ]] \
  || [[ "$(git -C "${source_root}" diff --cached --name-only | wc -l)" -ne 6 ]]; then
  echo 'The import-only supplement did not stage every changed file.' >&2
  exit 1
fi
for groovy_file in "${source_root}"/*.groovy; do
  if [[ "$(grep -Fxc 'import cotest.define.TestCaseGroup' "${groovy_file}")" -ne 1 ]]; then
    echo "The import-only supplement failed for ${groovy_file}." >&2
    exit 1
  fi
done

after_import_apply="$(sha256sum "${source_root}"/*.groovy)"
idempotent_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}")"
after_idempotent_run="$(sha256sum "${source_root}"/*.groovy)"
grep -Fq 'Updated 0 @Test annotation(s) in 0 Groovy file(s); 8 annotation(s) were already correct.' \
  <<<"${idempotent_output}"
grep -Fq 'Added 0 missing cotest.define.TestCaseGroup import(s).' <<<"${idempotent_output}"
grep -Fq 'Ran git add after 0 changed case(s).' <<<"${idempotent_output}"
if [[ "${after_import_apply}" != "${after_idempotent_run}" ]]; then
  echo 'An idempotent group/import rerun changed a Groovy source file.' >&2
  exit 1
fi

sed -i 's/^import cotest\.define\.TestCaseGroup$/import cotest.define.*/' \
  "${source_root}/05PluralGroupsCase.groovy"
before_wildcard_run="$(sha256sum "${source_root}/05PluralGroupsCase.groovy")"
wildcard_output="$(java -cp "${runtime_classpath}" ApplyGroovyCaseGroups \
  --source "${source_root}" --workbook "${workbook}")"
after_wildcard_run="$(sha256sum "${source_root}/05PluralGroupsCase.groovy")"
grep -Fq 'Updated 0 @Test annotation(s) in 0 Groovy file(s); 8 annotation(s) were already correct.' \
  <<<"${wildcard_output}"
grep -Fq 'Added 0 missing cotest.define.TestCaseGroup import(s).' <<<"${wildcard_output}"
if [[ "${before_wildcard_run}" != "${after_wildcard_run}" ]]; then
  echo 'An existing cotest.define wildcard import was rewritten.' >&2
  exit 1
fi

sed -i '0,/@Test(group = \[TestCaseGroup.L0\])/s//\@Test(group = [TestCaseGroup.L1])/' \
  "${source_root}/01MixedCases.groovy"
sed -i '/@Test(group = \[TestCaseGroup.L0\])/d' \
  "${source_root}/03BareAnnotationCase.groovy"
sed -i 's/@Test(groups = \[TestCaseGroup.Completed, TestCaseGroup.L0\])/@Test(groups = [TestCaseGroup.Completed], group = [TestCaseGroup.L0])/' \
  "${source_root}/05PluralGroupsCase.groovy"
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
grep -Fq "@Test contains both 'group' and 'groups'; the intended member is ambiguous" \
  <<<"${failed_validation_output}"
if [[ "${before_failed_validation}" != "${after_failed_validation}" ]]; then
  echo 'Validation failure caused a partial source update.' >&2
  exit 1
fi

echo 'apply-groovy-case-groups tests passed'
