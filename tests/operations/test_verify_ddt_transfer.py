"""Offline integrity and HTTP contract checks for the standalone verifier."""

from __future__ import annotations

import contextlib
import copy
import csv
import importlib.util
import io
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "verify_ddt_transfer", ROOT / "scripts/operations/verify_ddt_transfer.py"
)
verifier = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verifier
SPEC.loader.exec_module(verifier)


def column_name(index):
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def workbook(path, sheets, shared=False):
    strings = []
    sheet_xml = []
    for rows in sheets.values():
        contents = []
        for number, row in enumerate(rows, 1):
            cells = []
            for column, value in enumerate(row, 1):
                if value is None:
                    continue
                coordinate = f'{column_name(column)}{number}'
                if isinstance(value, bool):
                    cell = f'<c r="{coordinate}" t="b"><v>{int(value)}</v></c>'
                elif isinstance(value, (int, float)):
                    cell = f'<c r="{coordinate}"><v>{value}</v></c>'
                elif isinstance(value, tuple):
                    cell = f'<c r="{coordinate}"><f>{value[0]}</f><v>2</v></c>'
                elif shared:
                    strings.append(value)
                    cell = f'<c r="{coordinate}" t="s"><v>{len(strings) - 1}</v></c>'
                else:
                    cell = f'<c r="{coordinate}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
                cells.append(cell)
            contents.append(f'<row r="{number}">{"".join(cells)}</row>')
        sheet_xml.append(
            f'<worksheet xmlns="{verifier.XML_NAMESPACE[1:-1]}">'
            f'<sheetData>{"".join(contents)}</sheetData></worksheet>'
        )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        catalog = "".join(
            f'<sheet name="{escape(name)}" sheetId="{number}" r:id="r{number}"/>'
            for number, name in enumerate(sheets, 1)
        )
        archive.writestr("xl/workbook.xml", (
            f'<workbook xmlns="{verifier.XML_NAMESPACE[1:-1]}" '
            f'xmlns:r="{verifier.REL_NAMESPACE[1:-1]}"><sheets>{catalog}</sheets></workbook>'
        ))
        archive.writestr("xl/_rels/workbook.xml.rels", (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(
                f'<Relationship Id="r{number}" Target="worksheets/sheet{number}.xml"/>'
                for number in range(1, len(sheets) + 1)
            ) + '</Relationships>'
        ))
        for number, contents in enumerate(sheet_xml, 1):
            archive.writestr(f"xl/worksheets/sheet{number}.xml", contents)
        if shared:
            archive.writestr("xl/sharedStrings.xml", (
                f'<sst xmlns="{verifier.XML_NAMESPACE[1:-1]}">'
                + "".join(f'<si><t>{escape(text)}</t></si>' for text in strings) + '</sst>'
            ))


class SpreadsheetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.connection = sqlite3.connect(self.directory / "index.sqlite")
        self.index = verifier.CaseIndex(self.connection)

    def tearDown(self):
        self.connection.close()
        self.temporary.cleanup()

    def read(self, sheets, shared=False, book=0):
        path = self.directory / f"book-{book}.xlsx"
        workbook(path, sheets, shared)
        verifier.read_spreadsheet(self.index, path, book, "utf-8-sig", 100 * 1024 * 1024)

    def payload(self, case_id):
        return json.loads(self.index.item("table", verifier.case_key(case_id))[1])

    def test_sparse_cells_preserve_chinese_zero_false_whitespace_and_multiline(self):
        expected = {
            "CaseID": "中文/钱包?01#%", "srNum": "Wallet", "零": 0,
            "布尔": False, "空白": "  ", "文本": "0001\n<请求>&😀",
        }
        self.read({"data": [
            ["caseid", "SRNUM", "空列", "零", "布尔", "空白", "文本"],
            [expected["CaseID"], "Wallet", None, 0, False, "  ", expected["文本"]],
        ]})
        self.assertEqual(self.payload(expected["CaseID"]), expected)

    def test_shared_strings_decode_excel_escapes_once(self):
        self.read({"data": [
            ["CaseID", "srNum", "escaped", "emoji"],
            ["000012", "钱包", "_x005F_x0041_", "_xD83D__xDE00_"],
        ]}, shared=True)
        self.assertEqual(self.payload("000012")["escaped"], "_x0041_")
        self.assertEqual(self.payload("000012")["emoji"], "😀")

    def test_csv_long_fields_bom_and_quoted_newlines(self):
        path = self.directory / "cases.csv"
        text = "中文,\"原文\"\n" + "长" * 200_000
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            csv.writer(stream).writerows([["CaseID", "srNum", "body"], ["0001", "SR", text]])
        verifier.read_spreadsheet(self.index, path, 0, "utf-8-sig", 1000000)
        self.assertEqual(self.payload("0001")["body"], text)

    def test_journey_missing_step_marker_does_not_invent_a_step(self):
        self.read({
            "data": [["CaseID", "srNum"], ["ordinary", "SR"]],
            "step1": [["CaseID", "srNum", "amount"], ["J1", "SR", 0], ["J2", "SR", 1]],
            "step2": [["CaseID", "srNum", verifier.STEP_PRESENT, "ok"],
                      ["J1", "SR", False, None], ["J2", "SR", True, False]],
        })
        self.assertEqual(self.index.count("table"), 3)
        self.assertEqual(self.payload("J1")[verifier.JOURNEY], {
            "step1": {"CaseID": "J1", "srNum": "SR", "amount": 0},
        })
        self.assertIs(self.payload("J2")[verifier.JOURNEY]["step2"]["ok"], False)

    def test_journey_misalignment_and_missing_step_are_rejected(self):
        for sheets in (
            {"step2": [["CaseID", "srNum"], ["J1", "SR"]]},
            {"step1": [["CaseID", "srNum"], ["J1", "SR"]],
             "step2": [["CaseID", "srNum"], ["J2", "SR"]]},
        ):
            with self.subTest(sheets=list(sheets)):
                with self.assertRaises(verifier.VerificationError):
                    self.read(sheets)
                self.connection.execute("DELETE FROM rows")

    def test_duplicate_headers_and_ids_are_rejected(self):
        for rows in (
            [["CaseID", "srNum", "name", "Name"], ["A", "SR", "x", "y"]],
            [["CaseID", "srNum"], ["A", "SR"], [" a ", "SR"]],
            [["CaseID", "srNum", None], ["A", "SR", "undeclared"]],
        ):
            with self.subTest(rows=rows):
                with self.assertRaises(verifier.VerificationError):
                    self.read({"data": rows})
                self.connection.execute("DELETE FROM rows")

    def test_duplicates_across_files_are_rejected(self):
        sheets = {"data": [["CaseID", "srNum"], ["same", "SR"]]}
        self.read(sheets)
        with self.assertRaises(verifier.VerificationError):
            self.read(sheets, book=1)

    def test_formula_and_execution_result_workbooks_are_rejected(self):
        for sheets in (
            {"data": [["CaseID", "srNum", "value"], ["A", "SR", ("1+1",)]]},
            {"执行结果": [["用例", "结果"], ["case", "Pass"]]},
        ):
            with self.assertRaises(verifier.VerificationError):
                self.read(sheets)

    def test_xml_entities_and_utf16_bypass_are_rejected(self):
        for content in (
            b'<!DOCTYPE s [<!ENTITY x "boom">]><s>&x;</s>',
            '<!DOCTYPE s [<!ENTITY x "boom">]><s>&x;</s>'.encode("utf-16"),
        ):
            with self.assertRaises(verifier.VerificationError):
                verifier.SafeXmlStream(io.BytesIO(content)).read()

    def test_wide_8100_case_workbook_preserves_all_populated_cells(self):
        headers = ["CaseID", "srNum"] + [f"参数-{number}" for number in range(2048)]
        # A deliberately sparse XML fixture: 16 million absent cells must stay absent.
        path = self.directory / "wide.xlsx"
        workbook(path, {"data": [headers]})
        with zipfile.ZipFile(path) as archive:
            members = {name: archive.read(name) for name in archive.namelist()}
        contents = members["xl/worksheets/sheet1.xml"].decode()
        rows = []
        for number in range(8100):
            row = number + 2
            field = number % 2048
            rows.append(
                f'<row r="{row}"><c r="A{row}" t="inlineStr"><is><t>中文-{number}</t></is></c>'
                f'<c r="B{row}" t="inlineStr"><is><t>SR-{field}</t></is></c>'
                f'<c r="{column_name(field + 3)}{row}"><v>{number}</v></c></row>'
            )
        members["xl/worksheets/sheet1.xml"] = contents.replace(
            '</sheetData>', "".join(rows) + '</sheetData>'
        ).encode()
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, body in members.items():
                archive.writestr(name, body)
        verifier.read_spreadsheet(self.index, path, 0, "utf-8-sig", 100 * 1024 * 1024)
        self.assertEqual(self.index.count("table"), 8100)
        for number in range(8100):
            field = number % 2048
            self.assertEqual(self.payload(f"中文-{number}"), {
                "CaseID": f"中文-{number}", "srNum": f"SR-{field}", f"参数-{field}": number,
            })


class ComparisonTests(unittest.TestCase):
    def test_nested_map_order_does_not_change_hash_or_create_report_differences(self):
        left = {"outer": {"b": 2, "a": 1}, "items": [{"y": False, "x": "中文"}]}
        right = {"items": [{"x": "中文", "y": False}], "outer": {"a": 1, "b": 2}}
        self.assertEqual(verifier.fingerprint(left), verifier.fingerprint(right))
        with tempfile.TemporaryDirectory() as directory:
            report = verifier.Report(Path(directory) / "report", True, False)
            try:
                # Equality must be established from values, independently of report digests.
                with patch.object(verifier, "fingerprint", side_effect=AssertionError("unexpected digest")):
                    self.assertFalse(report.compare("A", "file:2", "source_target", left, right))
                self.assertEqual(report.summary["differences"], 0)
            finally:
                report.close()
            with (report.directory / "differences.csv").open(encoding="utf-8-sig", newline="") as stream:
                self.assertEqual(list(csv.DictReader(stream)), [])

    def test_json_text_difference_preserves_original_strings_for_local_diagnosis(self):
        left = {"payload": '{"b":2,"a":1}'}
        right = {"payload": '{ "a": 1, "b": 2 }'}
        self.assertEqual(json.loads(left["payload"]), json.loads(right["payload"]))
        with tempfile.TemporaryDirectory() as directory:
            report = verifier.Report(Path(directory) / "report", True, False)
            try:
                self.assertTrue(report.compare("A", "file:2", "source_target", left, right))
            finally:
                report.close()
            with (report.directory / "differences.csv").open(encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["json_pointer"], "/payload")
            self.assertEqual((rows[0]["left_type"], rows[0]["right_type"]), ("string", "string"))
            self.assertEqual(json.loads(rows[0]["left_value_json"]), left["payload"])
            self.assertEqual(json.loads(rows[0]["right_value_json"]), right["payload"])
            self.assertEqual(rows[0]["comparison_result"], "值不同")
            self.assertNotIn("left_sha256", rows[0])
            readable = (report.directory / "differences.diff").read_text()
            self.assertIn("--- 源平台 (string)", readable)
            self.assertIn("+++ 目标平台 (string)", readable)

    def test_readable_diff_distinguishes_types_missing_fields_and_ignored_empty_values(self):
        with tempfile.TemporaryDirectory() as directory:
            report = verifier.Report(Path(directory) / "report", True, True)
            try:
                self.assertTrue(report.compare("钱包-01", "cases.xlsx/data:2", "table_source",
                                               {"amount": 100, "flag": False, "missing": None},
                                               {"amount": "100", "flag": 0, "extra": "x"}))
            finally:
                report.close()
            with (report.directory / "differences.csv").open(encoding="utf-8-sig", newline="") as stream:
                rows = {row["json_pointer"]: row for row in csv.DictReader(stream)}
            self.assertEqual(rows["/amount"]["comparison_result"], "类型不同")
            self.assertEqual(rows["/amount"]["left_value_json"], "100")
            self.assertEqual(rows["/amount"]["right_value_json"], '"100"')
            self.assertEqual(rows["/extra"]["comparison_result"], "仅右侧存在")
            self.assertEqual(rows["/extra"]["left_value_json"], "<missing>")
            self.assertEqual(rows["/flag"]["left_value_json"], "false")
            self.assertEqual(rows["/flag"]["right_value_json"], "0")
            self.assertEqual(rows["/missing"]["comparison_result"], "已忽略空值差异")
            readable = (report.directory / "differences.diff").read_text()
            for expected in ('CaseID: "钱包-01"', "表格 → 源平台", '字段路径: "/amount"',
                             "--- 表格 (number)", "+++ 源平台 (string)", "-100\n", '+"100"\n',
                             "已忽略空值差异", "<字段不存在>"):
                self.assertIn(expected, readable)

    def test_report_creation_failure_closes_already_opened_files(self):
        opened = [io.StringIO(), io.StringIO()]
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(verifier, "private_file", side_effect=[*opened, OSError("disk full")]):
                with self.assertRaisesRegex(OSError, "disk full"):
                    verifier.Report(Path(directory) / "report", True, False)
        self.assertTrue(all(stream.closed for stream in opened))

    def test_inventory_hash_ignores_row_and_metadata_order_but_detects_revision_changes(self):
        rows = [
            ("A", {"id": "a", "revision": 1, "updatedAt": "2026-11-04T00:00:00Z"}),
            ("B", {"id": "b", "revision": 2, "updatedAt": "2026-11-04T00:01:00Z"}),
        ]
        with contextlib.closing(sqlite3.connect(":memory:")) as connection:
            index = verifier.CaseIndex(connection)
            for case_id, metadata in rows:
                index.add("source", case_id, metadata)
            for case_id, metadata in reversed(rows):
                index.add("source_after", case_id, dict(reversed(list(metadata.items()))))
            self.assertEqual(index.inventory_hash("source"), index.inventory_hash("source_after"))
            connection.execute("UPDATE cases SET body=? WHERE origin=? AND key=?", (
                verifier.encoded({**rows[0][1], "revision": 2}), "source_after", "a",
            ))
            self.assertNotEqual(index.inventory_hash("source"), index.inventory_hash("source_after"))

    def test_missing_null_empty_number_false_and_json_pointer_are_distinct(self):
        pairs = list(verifier.differences(
            {"empty": "", "null": None, "zero": 0, "false": False, "a/b~": {"value": "x"}},
            {"null": "", "zero": "0", "false": 0, "a/b~": {"value": "y"}},
        ))
        self.assertEqual({item[0] for item in pairs}, {
            "/empty", "/null", "/zero", "/false", "/a~1b~0/value",
        })

    def test_case_key_matches_platform_without_sharp_s_casefolding(self):
        self.assertEqual(verifier.case_key(" 钱包ABC "), "钱包abc")
        self.assertNotEqual(verifier.case_key("ß"), verifier.case_key("ss"))

    def test_nested_array_types_and_missing_items_do_not_compare_as_equal(self):
        pairs = list(verifier.differences({"values": [False, {"n": 0}, "last"]},
                                         {"values": [0, {"n": "0"}]}))
        self.assertEqual({item[0] for item in pairs}, {"/values/0", "/values/1/n", "/values/2"})

    def test_reports_never_overwrite_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "existing"
            path.mkdir()
            marker = path / "differences.csv"
            marker.write_text("previous report")
            with self.assertRaises(FileExistsError):
                verifier.Report(path, False, False)
            self.assertEqual(marker.read_text(), "previous report")

    def test_empty_tolerance_records_ignored_differences_and_does_not_hide_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            report = verifier.Report(Path(directory) / "report", True, True)
            try:
                self.assertFalse(report.compare("A", "file:2", "source_target", {"v": None}, {}))
                self.assertTrue(report.compare("A", "file:2", "source_target", {"v": 0}, {"v": ""}))
                self.assertEqual(report.summary["ignoredEmptyDifferences"], 1)
                self.assertEqual(report.summary["rawApiDifferences"], 2)
            finally:
                report.close()
            self.assertEqual(json.loads((report.directory / "summary.json").read_text())["differences"], 1)


class FakePlatforms:
    """A local HTTP contract fixture; it never starts or writes to a real platform."""

    def __init__(self, cases):
        self.cases = {name: copy.deepcopy(cases) for name in ("source", "target")}
        self.requests = []
        self.listings = {name: 0 for name in self.cases}
        self.mutate = False
        self.failure = None
        self.cycle = False
        self.after_read = None
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                query = parse_qs(url.query)
                origin = query.get("projectId", [None])[0]
                inventory = url.path == "/api/v1/ddt/cases"
                if not inventory:
                    origin = url.path.split("/projects/")[1].split("/")[0]
                fixture.requests.append((url.path, query, self.headers.get("Authorization")))
                if inventory:
                    if self.headers.get("Authorization") != "Bearer test-read-only":
                        return self.reply({"error": {"code": "UNAUTHENTICATED"}}, 401)
                    fixture.listings[origin] += 1
                    offset = int(query.get("cursor", ["0"])[0])
                    cases = list(fixture.cases[origin].values())
                    items = [{
                        "id": f"{origin}-{position}", "caseId": row["CaseID"], "srNum": row["srNum"],
                        "projectId": origin, "projectVersionId": "version", "testStageId": "stage",
                        "revision": 2 if fixture.mutate and fixture.listings[origin] > 1 else 1,
                        "updatedAt": "2026-10-31T00:00:00Z",
                    } for position, row in enumerate(cases[offset:offset + 100], offset)]
                    response = {"items": items}
                    if offset + 100 < len(cases) or fixture.cycle:
                        response["nextCursor"] = "100" if fixture.cycle else str(offset + 100)
                    return self.reply(response)
                case_id = query["caseId"][0]
                if fixture.failure and origin == "target":
                    return self.reply(fixture.failure, 503)
                result = fixture.cases[origin].get(case_id)
                if fixture.after_read:
                    fixture.after_read()
                if result is None:
                    return self.reply({"error": {"code": "DDT_CASE_NOT_FOUND", "requestId": "test"}}, 404)
                self.reply(result)

            def reply(self, payload, status=200):
                body = json.dumps(payload, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def url(self, origin):
        return (f"http://127.0.0.1:{self.server.server_port}/api/v1/public/ddt/projects/"
                f"{origin}/versions/version/stages/stage")


class HttpVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def run_verification(self, fixture, cases, **settings):
        path = self.directory / "cases.xlsx"
        headers = list(dict.fromkeys(field for row in cases for field in row))
        workbook(path, {"data": [headers] + [[row.get(field) for field in headers] for row in cases]})
        report = self.directory / "report"
        config = verifier.VerificationConfig(
            files=(str(path),), source_url=fixture.url("source"), target_url=fixture.url("target"),
            output_dir=str(report), requests_per_second=100, retries=0,
            source_api_key="test-read-only", target_api_key="test-read-only", **settings,
        )
        with patch.object(verifier, "CONFIG", config), contextlib.redirect_stdout(io.StringIO()):
            code = verifier.main()
        summary = json.loads((report / "summary.json").read_text())
        with (report / "differences.csv").open(encoding="utf-8-sig", newline="") as stream:
            differences = list(csv.DictReader(stream))
        return code, summary, differences

    def test_full_pagination_encoded_ids_data_field_and_inventory_stability(self):
        cases = [{"CaseID": f"中文/钱包?{number}#%", "srNum": "Wallet", "data": "原始字段", "zero": 0}
                 for number in range(101)]
        with FakePlatforms({row["CaseID"]: row for row in cases}) as fixture:
            code, summary, differences = self.run_verification(fixture, cases)
            self.assertEqual(code, 0)
            self.assertTrue(summary["complete"])
            self.assertTrue(summary["inventoryVerified"])
            self.assertTrue(summary["stabilityVerified"])
            self.assertEqual(summary["checkedCases"], 101)
            self.assertEqual(summary["caseCounts"], {"table": 101, "source": 101, "target": 101})
            self.assertEqual(fixture.listings, {"source": 4, "target": 4})
            self.assertEqual(differences, [])
            self.assertTrue(all(token is None for path, _, token in fixture.requests if path.endswith("/case")))

    def test_missing_extra_changed_and_type_changed_cases_are_all_reported(self):
        cases = [{"CaseID": key, "srNum": "SR", "value": 0} for key in ("missing", "changed", "typed")]
        with FakePlatforms({row["CaseID"]: row for row in cases}) as fixture:
            fixture.cases["target"].pop("missing")
            fixture.cases["target"]["changed"]["value"] = 1
            fixture.cases["target"]["typed"]["value"] = "0"
            fixture.cases["source"]["extra"] = {"CaseID": "extra", "srNum": "SR"}
            code, summary, differences = self.run_verification(fixture, cases, include_values=False)
        self.assertEqual(code, 1)
        self.assertEqual(summary["differentCases"], 4)
        self.assertEqual({row["CaseID"] for row in differences}, {"missing", "changed", "typed", "extra"})
        self.assertTrue(summary["complete"])
        self.assertNotIn("left_value_json", differences[0])
        self.assertIn("left_sha256", differences[0])
        self.assertFalse((self.directory / "report/differences.diff").exists())

    def test_default_http_verification_reports_actual_values_and_readable_diff(self):
        cases = [{"CaseID": "钱包-01", "srNum": "Wallet", "amount": 100}]
        with FakePlatforms({row["CaseID"]: row for row in cases}) as fixture:
            fixture.cases["target"]["钱包-01"]["amount"] = "100"
            code, summary, differences = self.run_verification(fixture, cases)
        self.assertEqual(code, 1)
        self.assertTrue(summary["complete"])
        self.assertEqual(summary["valueReporting"], "raw_values")
        self.assertEqual({row["pair"] for row in differences}, {"table_target", "source_target"})
        for row in differences:
            self.assertEqual(row["json_pointer"], "/amount")
            self.assertEqual(row["comparison_result"], "类型不同")
            self.assertEqual(row["left_value_json"], "100")
            self.assertEqual(row["right_value_json"], '"100"')
            self.assertNotIn("left_sha256", row)
        readable = (self.directory / "report/differences.diff").read_text()
        self.assertIn("表格 → 目标平台", readable)
        self.assertIn("源平台 → 目标平台", readable)
        self.assertIn("# 结果: different", readable)

    def test_changed_revision_prevents_certification(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.mutate = True
            code, summary, _ = self.run_verification(fixture, cases)
        self.assertEqual(code, 3)
        self.assertFalse(summary["complete"])
        self.assertFalse(summary["stabilityVerified"])

    def test_pending_error_response_never_becomes_a_missing_or_matching_case(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.failure = {"error": {"code": "DATABASE_BUSY", "message": "secret should not appear"}}
            code, summary, _ = self.run_verification(fixture, cases)
        self.assertEqual(code, 3)
        self.assertEqual(summary["readErrors"], 1)
        self.assertNotIn("secret should not appear", (self.directory / "report/errors.csv").read_text())

    def test_repeating_pagination_cursor_is_incomplete(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.cycle = True
            code, summary, _ = self.run_verification(fixture, cases)
        self.assertEqual(code, 3)
        self.assertFalse(summary["complete"])

    def test_anonymous_file_scope_reports_missing_case_but_cannot_certify_inventory(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.cases["target"].pop("A")
            code, summary, _ = self.run_verification(fixture, cases, file_scope_only=True)
        self.assertEqual(code, 1)
        self.assertTrue(summary["complete"])
        self.assertFalse(summary["inventoryVerified"])
        self.assertFalse(summary["stabilityVerified"])
        self.assertIsNone(summary["caseCounts"]["source"])

    def test_modifying_input_file_during_verification_prevents_certification(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.after_read = lambda: (self.directory / "cases.xlsx").write_bytes(b"changed")
            code, summary, _ = self.run_verification(fixture, cases)
        self.assertEqual(code, 3)
        self.assertFalse(summary["complete"])

    def test_explicit_empty_tolerance_never_claims_a_strict_raw_match(self):
        cases = [{"CaseID": "A", "srNum": "SR", "empty": None, "zero": 0, "false": False}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.cases["target"]["A"].pop("empty")
            code, summary, differences = self.run_verification(fixture, cases, ignore_empty=True)
        self.assertEqual(code, 0)
        self.assertEqual(summary["result"], "effective_data_match")
        self.assertEqual(summary["ignoredEmptyDifferences"], 2)
        self.assertEqual(summary["rawApiDifferences"], 1)
        self.assertTrue(all(row["ignored"] == "True" for row in differences))

    def test_source_only_empty_string_is_ignored_by_default_but_retained_for_audit(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.cases["source"]["A"]["empty"] = ""
            code, summary, differences = self.run_verification(fixture, cases)
        self.assertEqual(code, 0)
        self.assertTrue(summary["complete"])
        self.assertEqual(summary["comparisonMode"], "ignore_empty")
        self.assertEqual(summary["result"], "effective_data_match")
        self.assertEqual(summary["differentCases"], 0)
        self.assertEqual(summary["differences"], 0)
        self.assertEqual(summary["ignoredEmptyDifferences"], 2)
        self.assertEqual(summary["rawApiDifferences"], 1)
        self.assertEqual({row["pair"] for row in differences}, {"table_source", "source_target"})
        self.assertTrue(all(row["comparison_result"] == "已忽略空值差异" for row in differences))
        self.assertTrue(all(row["ignored"] == "True" for row in differences))

    def test_empty_tolerance_does_not_hide_zero_false_or_nonempty_string_fields(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.cases["source"]["A"].update({
                "empty": "", "zero": 0, "false": False, "textZero": "0", "textFalse": "false",
            })
            code, summary, differences = self.run_verification(fixture, cases)
        self.assertEqual(code, 1)
        self.assertEqual(summary["differences"], 8)
        self.assertEqual(summary["ignoredEmptyDifferences"], 2)
        self.assertEqual({row["json_pointer"] for row in differences if row["ignored"] == "False"},
                         {"/zero", "/false", "/textZero", "/textFalse"})

    def test_strict_mode_still_reports_a_source_only_empty_string(self):
        cases = [{"CaseID": "A", "srNum": "SR"}]
        with FakePlatforms({"A": cases[0]}) as fixture:
            fixture.cases["source"]["A"]["empty"] = ""
            code, summary, differences = self.run_verification(fixture, cases, ignore_empty=False)
        self.assertEqual(code, 1)
        self.assertEqual(summary["comparisonMode"], "strict")
        self.assertEqual(summary["differences"], 2)
        self.assertEqual(summary["ignoredEmptyDifferences"], 0)
        self.assertEqual({row["comparison_result"] for row in differences}, {"仅左侧存在", "仅右侧存在"})

    def test_complete_inventory_requires_explicit_api_key_without_falling_back_to_anonymous(self):
        with FakePlatforms({}) as fixture:
            config = verifier.VerificationConfig(
                files=(str(self.directory / "not-read.xlsx"),),
                source_url=fixture.url("source"), target_url=fixture.url("target"),
                output_dir=str(self.directory / "report"),
            )
            with patch.dict("os.environ", {
                "AUTOFORGE_SOURCE_API_KEY": "test-read-only",
                "AUTOFORGE_TARGET_API_KEY": "test-read-only",
            }, clear=True), contextlib.redirect_stderr(io.StringIO()):
                code = verifier.main(config)
            self.assertEqual(fixture.requests, [])
        self.assertEqual(code, 2)
        self.assertFalse((self.directory / "report").exists())


class ScriptConfigurationTests(unittest.TestCase):
    def test_default_configuration_reports_values_directly(self):
        config = verifier.VerificationConfig(files=("cases.xlsx",), source_url="source", target_url="target")
        self.assertTrue(config.include_values)
        self.assertTrue(verifier.CONFIG.include_values)
        self.assertTrue(config.ignore_empty)
        self.assertTrue(verifier.CONFIG.ignore_empty)

    def test_run_without_arguments_reads_script_configuration_and_relative_paths(self):
        cases = {"中文-01": {"CaseID": "中文-01", "srNum": "Wallet", "value": 0}}
        with tempfile.TemporaryDirectory() as directory, FakePlatforms(cases) as fixture:
            root = Path(directory)
            workbook(root / "cases.xlsx", {"data": [
                ["CaseID", "srNum", "value"], ["中文-01", "Wallet", 0],
            ]})
            config = verifier.VerificationConfig(
                files=("cases.xlsx",), source_url=fixture.url("source"),
                target_url=fixture.url("target"), source_api_key="test-read-only",
                target_api_key="test-read-only", output_dir="report",
                requests_per_second=100, retries=0, ignore_empty=False,
            )
            with (patch.object(verifier, "CONFIG", config),
                  patch.object(verifier, "__file__", str(root / "verify_ddt_transfer.py")),
                  patch.object(sys, "argv", ["verify_ddt_transfer.py"]),
                  contextlib.redirect_stdout(io.StringIO())):
                code = verifier.main()
            self.assertEqual(code, 0)
            summary = json.loads((root / "report/summary.json").read_text())
            self.assertEqual(summary["result"], "exact_match")
            self.assertEqual(summary["checkedCases"], 1)

    def test_blank_configuration_fails_before_any_api_request(self):
        config = verifier.VerificationConfig(files=("",), source_url="", target_url="")
        with patch.object(verifier, "CONFIG", config), patch.object(verifier.ApiReader, "get") as get:
            with contextlib.redirect_stderr(io.StringIO()) as errors:
                code = verifier.main()
            get.assert_not_called()
        self.assertEqual(code, 2)
        self.assertIn("CONFIG.files", errors.getvalue())

    def test_configuration_repr_does_not_expose_api_keys(self):
        config = verifier.VerificationConfig(
            files=("cases.xlsx",), source_url="source", target_url="target",
            source_api_key="source-secret", target_api_key="target-secret",
        )
        self.assertNotIn("source-secret", repr(config))
        self.assertNotIn("target-secret", repr(config))

    def test_invalid_optional_settings_stop_before_api_requests(self):
        for settings in (
            {"requests_per_second": float("nan")}, {"timeout": 0}, {"retries": 6},
            {"max_uncompressed_mib": 0}, {"ignore_empty": "False"},
            {"csv_encoding": "not-a-real-encoding"},
        ):
            with self.subTest(settings=settings):
                config = verifier.VerificationConfig(
                    files=("cases.xlsx",), source_url="http://source", target_url="http://target",
                    source_api_key="source-key", target_api_key="target-key", **settings,
                )
                with patch.object(verifier.ApiReader, "get") as get:
                    with contextlib.redirect_stderr(io.StringIO()):
                        code = verifier.main(config)
                    get.assert_not_called()
                self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
