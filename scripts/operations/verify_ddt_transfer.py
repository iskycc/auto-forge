#!/usr/bin/env python3
"""Read-only, bounded DDT spreadsheet/source/target reconciliation (Python 3.10+)."""

from __future__ import annotations

import argparse
import codecs
import csv
import hashlib
import json
import math
import os
import posixpath
import re
import sqlite3
import ssl
import sys
import tempfile
import time
import uuid
import zipfile
from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import zip_longest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener
from xml.etree import ElementTree


STEP_PRESENT = "__DDT_INSIGHT_STEP_PRESENT__"
JOURNEY = "用户旅程"
MISSING = object()
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
XML_NAMESPACE = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NAMESPACE = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
SCOPE_PATH = re.compile(
    r"^(.*)/api/v1/public/ddt/projects/([^/]+)/versions/([^/]+)/stages/([^/]+)"
    r"(?:/case|/cases/[^/]+)?/?$"
)


class VerificationError(Exception):
    """Invalid input, incomplete reads or an unstable inventory prevent certification."""


class CaseNotFound(VerificationError):
    """A confirmed absent case differs from an unsuccessful API read."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def encoded(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True)


def fingerprint(value: object) -> str:
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


def is_empty(value: object) -> bool:
    return value is MISSING or value is None or isinstance(value, str) and not value.strip()


def case_key(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 512:
        raise VerificationError("CaseID 必须是长度为 1–512 的字符串。")
    if any(character in value for character in "\r\n\u0085\u2028\u2029"):
        raise VerificationError("CaseID 不能包含换行。")
    # Match toLocaleLowerCase('en-US'); casefold would incorrectly merge ß with ss.
    return value.strip().lower()


def cell_identity(value: object) -> str:
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value) if value is not None else ""


def json_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"API JSON 存在重复字段：{key}")
        result[key] = value
    return result


def reject_constant(value: str):
    raise VerificationError(f"JSON 含非有限数字：{value}")


class CaseIndex:
    """Disk-backed rows and ID sets avoid retaining a rectangular workbook or API bodies."""

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection
        connection.executescript("""
            CREATE TABLE cases(origin TEXT, key TEXT, case_id TEXT, body TEXT, location TEXT,
              PRIMARY KEY(origin,key));
            CREATE TABLE rows(book INTEGER,sheet TEXT,ordinal INTEGER,key TEXT,case_id TEXT,
              body TEXT,location TEXT,PRIMARY KEY(book,sheet,ordinal),UNIQUE(book,sheet,key));
            CREATE TABLE strings(id INTEGER PRIMARY KEY,value TEXT);
        """)

    def add(self, origin: str, case_id: str, body: dict | None, location: str = ""):
        try:
            self.connection.execute("INSERT INTO cases VALUES(?,?,?,?,?)", (
                origin, case_key(case_id), case_id, encoded(body) if body is not None else None, location,
            ))
        except sqlite3.IntegrityError as error:
            raise VerificationError(f"{origin} 出现重复 CaseID：{case_id}；位置：{location}") from error

    def count(self, origin: str) -> int:
        return self.connection.execute("SELECT COUNT(*) FROM cases WHERE origin=?", (origin,)).fetchone()[0]

    def inventory_hash(self, origin: str) -> str:
        digest = hashlib.sha256()
        for row in self.connection.execute(
            "SELECT key,case_id,body FROM cases WHERE origin=? ORDER BY key", (origin,)
        ):
            digest.update(encoded(row).encode("utf-8") + b"\n")
        return digest.hexdigest()

    def item(self, origin: str, key: str):
        return self.connection.execute(
            "SELECT case_id,body,location FROM cases WHERE origin=? AND key=?", (origin, key)
        ).fetchone()

    def identities(self):
        return self.connection.execute("SELECT key,MIN(case_id) FROM cases GROUP BY key ORDER BY key")


class SafeXmlStream:
    def __init__(self, stream):
        self.stream = stream
        self.tail = b""

    def read(self, size=-1):
        content = self.stream.read(size)
        inspected = (self.tail + content).upper()
        if b"\x00" in inspected:
            raise VerificationError("XLSX XML 包含 NUL 或使用非平台导出的 UTF-16/32 编码。")
        if b"<!DOCTYPE" in inspected or b"<!ENTITY" in inspected:
            raise VerificationError("XLSX 不允许 XML DTD 或实体定义。")
        self.tail = inspected[-16:]
        return content


def xml_elements(archive: zipfile.ZipFile, name: str):
    with archive.open(name) as stream:
        yield from ElementTree.iterparse(SafeXmlStream(stream), events=("start", "end"))


def excel_text(element) -> str:
    # Only actual text runs; phonetic annotations are not cell contents.
    parts = []
    for child in element:
        if child.tag == XML_NAMESPACE + "t":
            parts.append(child.text or "")
        elif child.tag == XML_NAMESPACE + "r":
            parts.extend(run.text or "" for run in child if run.tag == XML_NAMESPACE + "t")
    text = re.sub(r"_x([0-9a-fA-F]{4})_", lambda match: chr(int(match[1], 16)), "".join(parts))
    try:
        return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le")
    except UnicodeError as error:
        raise VerificationError("单元格包含无效的 Unicode 代理字符。") from error


def xml_document(archive, name):
    root = None
    for event, element in xml_elements(archive, name):
        if root is None and event == "start":
            root = element
    return root


def sheet_members(archive) -> list[tuple[str, str]]:
    relationships = {}
    for element in xml_document(archive, "xl/_rels/workbook.xml.rels"):
        if element.get("TargetMode") == "External":
            continue
        target = element.get("Target", "")
        member = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
        if not member.startswith("xl/") or "\\" in member:
            raise VerificationError("XLSX 存在越界工作表引用。")
        relationships[element.get("Id")] = member
    sheets = xml_document(archive, "xl/workbook.xml").find(XML_NAMESPACE + "sheets")
    if sheets is None:
        raise VerificationError("XLSX 缺少工作表目录。")
    result = []
    for sheet in sheets:
        member = relationships.get(sheet.get(REL_NAMESPACE + "id"))
        if not member or member not in archive.namelist():
            raise VerificationError("XLSX 工作表引用缺失。")
        result.append((sheet.get("name", ""), member))
    return result


class SharedStrings:
    def __init__(self, archive, index: CaseIndex):
        self.connection = index.connection
        self.cache = OrderedDict()
        self.connection.execute("DELETE FROM strings")
        if "xl/sharedStrings.xml" not in archive.namelist():
            return
        root = None
        position = 0
        for event, element in xml_elements(archive, "xl/sharedStrings.xml"):
            if root is None and event == "start":
                root = element
            if event == "end" and element.tag == XML_NAMESPACE + "si":
                self.connection.execute("INSERT INTO strings VALUES(?,?)", (position, excel_text(element)))
                position += 1
                element.clear()
                root.clear()

    def get(self, position: str) -> str:
        try:
            index = int(position)
        except ValueError as error:
            raise VerificationError("XLSX 共享字符串索引无效。") from error
        if index in self.cache:
            self.cache.move_to_end(index)
            return self.cache[index]
        row = self.connection.execute("SELECT value FROM strings WHERE id=?", (index,)).fetchone()
        if row is None:
            raise VerificationError("XLSX 共享字符串不存在。")
        if len(row[0]) <= 4096:
            self.cache[index] = row[0]
            if len(self.cache) > 128:
                self.cache.popitem(last=False)
        return row[0]


def column_index(reference: str) -> int:
    match = re.fullmatch(r"([A-Z]+)[1-9][0-9]*", reference)
    if not match:
        raise VerificationError(f"XLSX 单元格坐标无效：{reference}")
    result = 0
    for letter in match[1]:
        result = result * 26 + ord(letter) - ord("A") + 1
    if result > 16384:
        raise VerificationError("XLSX 超出 Excel 列数上限。")
    return result - 1


def read_cell(cell, strings: SharedStrings):
    if cell.find(XML_NAMESPACE + "f") is not None:
        raise VerificationError("表格包含公式；请先转换为固定值，避免缓存结果造成错误的一致结论。")
    kind = cell.get("t", "n")
    if kind == "inlineStr":
        inline = cell.find(XML_NAMESPACE + "is")
        return excel_text(inline) if inline is not None else ""
    value = cell.find(XML_NAMESPACE + "v")
    if value is None or value.text is None:
        return None
    text = value.text
    if kind == "s":
        return strings.get(text)
    if kind == "b":
        if text not in ("0", "1"):
            raise VerificationError("XLSX 布尔值无效。")
        return text == "1"
    if kind in ("str", "d"):
        return text
    if kind != "n":
        raise VerificationError(f"XLSX 包含错误或不支持的单元格类型：{kind}")
    try:
        number = float(text) if any(c in text.lower() for c in ".e") else int(text)
        if not math.isfinite(number):
            raise ValueError("nonfinite")
        return number
    except (ValueError, OverflowError) as error:
        raise VerificationError("XLSX 数字无效。") from error


def xlsx_rows(archive, member, strings):
    sheet_data = None
    for event, element in xml_elements(archive, member):
        if event == "start" and element.tag == XML_NAMESPACE + "sheetData":
            sheet_data = element
        if event != "end" or element.tag != XML_NAMESPACE + "row":
            continue
        cells = {}
        for cell in element:
            if cell.tag != XML_NAMESPACE + "c":
                continue
            position = column_index(cell.get("r", ""))
            if position in cells:
                raise VerificationError("XLSX 行内存在重复单元格坐标。")
            try:
                cells[position] = read_cell(cell, strings)
            except VerificationError as error:
                raise VerificationError(f"{member} 单元格 {cell.get('r')}：{error}") from error
        yield int(element.get("r", "0")), cells
        element.clear()
        if sheet_data is not None:
            sheet_data.clear()


def store_sheet(index: CaseIndex, book: int, sheet: str, rows, path: Path):
    header = None
    count = 0
    for row_number, cells in rows:
        if not any(not is_empty(value) for value in cells.values()):
            continue
        if header is None:
            header = {}
            seen = set()
            for position, value in cells.items():
                if is_empty(value):
                    continue
                name = str(value).strip()
                lower = name.lower()
                if lower in seen:
                    raise VerificationError(f"{path.name}/{sheet} 表头重复：{name}；不能猜测保留哪一列。")
                seen.add(lower)
                header[position] = {"caseid": "CaseID", "srnum": "srNum"}.get(lower, name)
            if not {"CaseID", "srNum"}.issubset(header.values()):
                raise VerificationError(f"{path.name}/{sheet} 缺少 CaseID 或 srNum 表头。")
            continue
        fields = {}
        for position, value in cells.items():
            if value is None or value == "":
                continue
            if position not in header:
                raise VerificationError(f"{path.name}/{sheet} 第 {row_number} 行有值但没有表头。")
            fields[header[position]] = value
        location = f"{path.name}/{sheet}:{row_number}"
        identifier = cell_identity(fields.get("CaseID"))
        try:
            key = case_key(identifier)
        except VerificationError as error:
            raise VerificationError(f"{location}：{error}") from error
        if is_empty(fields.get("srNum")):
            raise VerificationError(f"{path.name}/{sheet} 第 {row_number} 行 srNum 为空。")
        try:
            index.connection.execute("INSERT INTO rows VALUES(?,?,?,?,?,?,?)", (
                book, sheet, count, key, identifier, encoded(fields), location,
            ))
        except sqlite3.IntegrityError as error:
            raise VerificationError(f"{location} CaseID 重复：{identifier}") from error
        count += 1
    if header is None or not count:
        raise VerificationError(f"{path.name}/{sheet} 没有有效用例。")


def assemble_workbook(index: CaseIndex, book: int, standard: str | None, steps: list[tuple[int, str]]):
    if standard:
        for case_id, body, location in index.connection.execute(
            "SELECT case_id,body,location FROM rows WHERE book=? AND sheet=? ORDER BY ordinal", (book, standard)
        ):
            index.add("table", case_id, json.loads(body), location)
    if not steps:
        return
    if [number for number, _ in steps] != list(range(1, len(steps) + 1)):
        raise VerificationError("用户旅程工作表必须从 step1 开始，连续且不重复。")
    counts = [index.connection.execute(
        "SELECT COUNT(*) FROM rows WHERE book=? AND sheet=?", (book, name)
    ).fetchone()[0] for _, name in steps]
    if len(set(counts)) != 1:
        raise VerificationError("用户旅程各 Step 的用例行数不同。")
    for ordinal in range(counts[0]):
        journey = {}
        first = None
        for number, name in steps:
            case_id, body, location = index.connection.execute(
                "SELECT case_id,body,location FROM rows WHERE book=? AND sheet=? AND ordinal=?",
                (book, name, ordinal),
            ).fetchone()
            fields = json.loads(body)
            if first is None:
                first = (case_id, fields, location)
            if case_id != first[0] or fields["srNum"] != first[1]["srNum"]:
                raise VerificationError(f"{location} 用户旅程 CaseID／srNum 与首个 Step 不一致。")
            present = fields.pop(STEP_PRESENT, True)
            if str(present).lower() not in ("false", "0", "no"):
                journey[f"step{number}"] = fields
        index.add("table", first[0], {
            "CaseID": first[1]["CaseID"], "srNum": first[1]["srNum"], JOURNEY: journey,
        }, first[2])


def read_spreadsheet(index: CaseIndex, path: Path, book: int, encoding: str, maximum_bytes: int):
    if path.suffix.lower() == ".csv":
        csv.field_size_limit(1024 * 1024)
        with path.open(encoding=encoding, newline="") as stream:
            rows = ((position, dict(enumerate(row))) for position, row in enumerate(csv.reader(stream), 1))
            store_sheet(index, book, "data", rows, path)
        assemble_workbook(index, book, "data", [])
        return
    if path.suffix.lower() != ".xlsx":
        raise VerificationError("仅支持平台导出的 .xlsx 或 .csv；不自动转换 XLS/XLSB/ODS。")
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 10000 or sum(member.file_size for member in members) > maximum_bytes:
            raise VerificationError("XLSX 解压大小或条目数超限。")
        if len({member.filename for member in members}) != len(members):
            raise VerificationError("XLSX 存在重复 ZIP 条目。")
        if any(member.flag_bits & 1 for member in members):
            raise VerificationError("请使用未加密的平台导出表格。")
        sheets = sheet_members(archive)
        standard = [name for name, _ in sheets if name.strip().lower() == "data"]
        steps = sorted((int(match[1]), name) for name, _ in sheets
                       if (match := re.fullmatch(r"step(\d+)", name.strip(), re.IGNORECASE)) and int(match[1]) > 0)
        if len(standard) > 1 or not standard and not steps:
            raise VerificationError("工作簿需包含唯一的 data Sheet 或用户旅程 step1…；不是执行结果／分析清单。")
        selected = set(standard + [name for _, name in steps])
        strings = SharedStrings(archive, index)
        for name, member in sheets:
            if name in selected:
                store_sheet(index, book, name, xlsx_rows(archive, member, strings), path)
        assemble_workbook(index, book, standard[0] if standard else None, steps)


@dataclass(frozen=True)
class Endpoint:
    prefix: str
    base: str
    scope: dict
    token: str
    ca_file: str | None

    @staticmethod
    def parse(address: str, token: str = "", ca_file: str | None = None):
        url = urlsplit(address)
        match = SCOPE_PATH.fullmatch(url.path)
        if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password or not match:
            raise VerificationError("平台地址必须是 DDT 开放 API 的完整范围／单用例地址，不能包含 URL 用户凭据。")
        if url.fragment or any(character in address for character in "\r\n\t"):
            raise VerificationError("API 地址不能包含片段或控制字符。")
        scope = dict(zip(("projectId", "projectVersionId", "testStageId"),
                         (unquote(part, errors="strict") for part in match.groups()[1:])))
        if any(not value or len(value) > 128 for value in scope.values()):
            raise VerificationError("平台范围 ID 无效。")
        base = urlunsplit((url.scheme, url.netloc, match[1], "", ""))
        prefix = base + "/api/v1/public/ddt/projects/" + quote(scope["projectId"], safe="")
        prefix += "/versions/" + quote(scope["projectVersionId"], safe="") + "/stages/" + quote(scope["testStageId"], safe="")
        return Endpoint(prefix, base, scope, token, ca_file)


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class RequestPacer:
    def __init__(self, requests_per_second: float):
        self.interval = 1 / requests_per_second
        self.previous = 0.0

    def wait(self):
        time.sleep(max(0, self.previous + self.interval - time.monotonic()))
        self.previous = time.monotonic()


class ApiReader:
    def __init__(self, endpoint: Endpoint, pacer: RequestPacer, timeout: float, retries: int):
        self.endpoint = endpoint
        self.pacer = pacer
        self.timeout = timeout
        self.retries = retries
        self.opener = build_opener(ProxyHandler({}), NoRedirects(), HTTPSHandler(
            context=ssl.create_default_context(cafile=endpoint.ca_file)
        ))

    def get(self, url: str, authenticated=False):
        headers = {"Accept": "application/json", "Cache-Control": "no-cache", "User-Agent": "AutoForge-DDT-Verifier/1"}
        if authenticated:
            headers["Authorization"] = "Bearer " + self.endpoint.token
        for attempt in range(self.retries + 1):
            self.pacer.wait()
            try:
                with self.opener.open(Request(url, headers=headers, method="GET"), timeout=self.timeout) as response:
                    content = response.read(MAX_RESPONSE_BYTES + 1)
                if len(content) > MAX_RESPONSE_BYTES:
                    raise VerificationError("API 响应超过 64 MiB，未截断后继续比较。")
                return json.loads(content.decode("utf-8-sig"), object_pairs_hook=json_object, parse_constant=reject_constant)
            except HTTPError as error:
                retry = error.code in (429, 502, 503, 504)
                retry_after = error.headers.get("Retry-After", "")
                payload = error.read(8192)
                error.close()
                try:
                    details = json.loads(payload).get("error", {})
                except (ValueError, AttributeError):
                    details = {}
                if not isinstance(details, dict):
                    details = {}
                message = f"HTTP {error.code}; code={details.get('code', 'UNKNOWN')}; requestId={details.get('requestId', '')}"
                if error.code == 404 and details.get("code") == "DDT_CASE_NOT_FOUND":
                    raise CaseNotFound(message) from error
                if not retry or attempt == self.retries:
                    raise VerificationError(message) from error
                delay = min(30, max(0, float(retry_after))) if retry_after.isdigit() else min(4, 0.5 * 2 ** attempt)
            except (URLError, TimeoutError, OSError) as error:
                if attempt == self.retries:
                    raise VerificationError(f"网络读取失败：{type(error).__name__}") from error
                delay = min(4, 0.5 * 2 ** attempt)
            except (ValueError, UnicodeError) as error:
                raise VerificationError("API 未返回有效 UTF-8 JSON；请检查 API 地址和登录／代理配置。") from error
            time.sleep(delay)

    def inventory(self, index: CaseIndex, origin: str):
        seen = set()
        cursor = None
        while True:
            query = {**self.endpoint.scope, "limit": 100}
            if cursor:
                query["cursor"] = cursor
            page = self.get(self.endpoint.base + "/api/v1/ddt/cases?" + urlencode(query), authenticated=True)
            if not isinstance(page, dict) or not isinstance(page.get("items"), list):
                raise VerificationError("用例目录响应缺少 items，不能证明全量范围。")
            if len(page["items"]) > 100:
                raise VerificationError("API 未遵守每页 100 条的分页限制。")
            for item in page["items"]:
                if not isinstance(item, dict) or not isinstance(item.get("caseId"), str):
                    raise VerificationError("用例目录项格式无效。")
                if any(item.get(key) != value for key, value in self.endpoint.scope.items()):
                    raise VerificationError("API 用例目录返回了不属于指定范围的记录。")
                if (not isinstance(item.get("id"), str) or not item["id"]
                        or type(item.get("revision")) is not int or item["revision"] < 1
                        or not isinstance(item.get("updatedAt"), str) or not item["updatedAt"]):
                    raise VerificationError("用例目录缺少修订元数据，不能检查比较期间的修改。")
                index.add(origin, item["caseId"], {key: item[key] for key in ("id", "revision", "updatedAt")})
            cursor = page.get("nextCursor")
            if cursor is None:
                break
            if not isinstance(cursor, str) or not cursor or cursor in seen or not page["items"]:
                raise VerificationError("API 分页游标无进展或重复，已停止而非忽略剩余用例。")
            seen.add(cursor)
        index.connection.commit()

    def case(self, case_id: str):
        payload = self.get(self.endpoint.prefix + "/case?" + urlencode({"caseId": case_id}))
        if not isinstance(payload, dict) or case_key(payload.get("CaseID")) != case_key(case_id):
            raise VerificationError("公开 API 没有返回所请求用例的原始字段对象。")
        return payload


def value_type(value):
    if value is MISSING:
        return "missing"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    raise VerificationError("不支持的 JSON 值。")


def differences(left, right, pointer=""):
    if isinstance(left, dict) and isinstance(right, dict):
        for key in sorted(left.keys() | right.keys()):
            segment = key.replace("~", "~0").replace("/", "~1")
            yield from differences(left.get(key, MISSING), right.get(key, MISSING), pointer + "/" + segment)
        return
    if isinstance(left, list) and isinstance(right, list):
        for position, (expected, actual) in enumerate(zip_longest(left, right, fillvalue=MISSING)):
            yield from differences(expected, actual, pointer + "/" + str(position))
        return
    if value_type(left) == value_type(right) and left == right:
        return
    yield pointer, left, right


def csv_safe(value):
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n")) else text


def private_file(path: Path, encoding="utf-8-sig"):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding=encoding, newline="")


class Report:
    def __init__(self, directory: Path, include_values: bool, ignore_empty: bool):
        directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.directory = directory
        self.include_values = include_values
        self.ignore_empty = ignore_empty
        self.diff_file = private_file(directory / "differences.csv")
        self.error_file = private_file(directory / "errors.csv")
        self.writer = csv.writer(self.diff_file)
        self.errors = csv.writer(self.error_file)
        columns = ["CaseID", "table_location", "pair", "json_pointer", "ignored", "left_type", "right_type", "left_sha256", "right_sha256"]
        if include_values: columns += ["left_value_json", "right_value_json"]
        self.writer.writerow(columns)
        self.errors.writerow(["origin", "CaseID", "error"])
        self.summary = {"startedAt": utc_now(), "complete": False, "result": "incomplete", "checkedCases": 0,
                        "differentCases": 0, "differences": 0, "ignoredEmptyDifferences": 0, "readErrors": 0,
                        "rawApiDifferences": 0, "inventoryVerified": False, "stabilityVerified": False,
                        "comparisonMode": "ignore_empty" if ignore_empty else "strict"}

    def compare(self, case_id, location, pair, left, right):
        different = False
        for pointer, expected, actual in differences(left, right):
            ignored = self.ignore_empty and is_empty(expected) and is_empty(actual)
            self.summary["ignoredEmptyDifferences" if ignored else "differences"] += 1
            if pair == "source_target": self.summary["rawApiDifferences"] += 1
            different |= not ignored
            record = [case_id, location, pair, pointer or "/", ignored, value_type(expected), value_type(actual),
                      "" if expected is MISSING else fingerprint(expected), "" if actual is MISSING else fingerprint(actual)]
            if self.include_values:
                record += ["<missing>" if value is MISSING else encoded(value) for value in (expected, actual)]
            self.writer.writerow([csv_safe(value) for value in record])
        return different

    def error(self, origin, case_id, error):
        self.summary["readErrors"] += 1
        self.errors.writerow([csv_safe(value) for value in (origin, case_id, str(error))])
        self.error_file.flush()

    def close(self):
        self.summary["finishedAt"] = utc_now()
        self.diff_file.close()
        self.error_file.close()
        with private_file(self.directory / "summary.json", encoding="utf-8") as stream:
            stream.write(json.dumps(self.summary, ensure_ascii=False, allow_nan=False, indent=2) + "\n")


def reconcile(index: CaseIndex, readers: dict, report: Report, file_scope_only: bool):
    if not file_scope_only:
        for origin, reader in readers.items():
            reader.inventory(index, origin)
        report.summary["inventoryVerified"] = True
    report.summary["scope"] = "spreadsheet_cases_only" if file_scope_only else "whole_stage"
    report.summary["caseCounts"] = {
        origin: None if file_scope_only and origin != "table" else index.count(origin)
        for origin in ("table", "source", "target")
    }
    for key, identifier in index.identities():
        table = index.item("table", key)
        payloads = {"table": json.loads(table[1]) if table else MISSING}
        for origin, reader in readers.items():
            present = index.item(origin, key)
            if not file_scope_only and present is None:
                payloads[origin] = MISSING
                continue
            try:
                payloads[origin] = reader.case(present[0] if present else identifier)
            except CaseNotFound as error:
                if file_scope_only:
                    payloads[origin] = MISSING
                else:
                    report.error(origin, identifier, error)
            except VerificationError as error:
                report.error(origin, identifier, error)
        differs = False
        for left, right in (("table", "source"), ("table", "target"), ("source", "target")):
            if left in payloads and right in payloads:
                differs |= report.compare(identifier, table[2] if table else "", f"{left}_{right}", payloads[left], payloads[right])
        report.summary["checkedCases"] += 1
        report.summary["differentCases"] += int(differs)
        if report.summary["checkedCases"] % 25 == 0:
            print(f"已验证 {report.summary['checkedCases']} 条，差异 {report.summary['differentCases']} 条，读取错误 {report.summary['readErrors']} 次", flush=True)
    if not file_scope_only:
        for origin, reader in readers.items():
            reader.inventory(index, origin + "_after")
            if index.inventory_hash(origin) != index.inventory_hash(origin + "_after"):
                raise VerificationError(f"{origin} 在验证期间有用例新增、删除或修订，请暂停修改后重试。")
        report.summary["stabilityVerified"] = True
    report.summary["complete"] = report.summary["readErrors"] == 0
    if report.summary["complete"]:
        report.summary["result"] = "different" if report.summary["differences"] else (
            "effective_data_match" if report.ignore_empty else "exact_match"
        )


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", action="append", required=True, type=Path, help="平台导出的 XLSX/CSV，可重复指定；拒绝重复 CaseID")
    parser.add_argument("--source-url", required=True, help="导出平台 DDT 开放 API 的完整范围或单用例 URL")
    parser.add_argument("--target-url", required=True, help="导入平台 DDT 开放 API 的完整范围或单用例 URL")
    parser.add_argument("--source-token-env", default="AUTOFORGE_SOURCE_API_KEY")
    parser.add_argument("--target-token-env", default="AUTOFORGE_TARGET_API_KEY")
    parser.add_argument("--source-ca-file")
    parser.add_argument("--target-ca-file")
    parser.add_argument("--file-scope-only", action="store_true", help="不用 API Key，仅检查表格中的用例；不认证平台全量一致")
    parser.add_argument("--ignore-empty", action="store_true", help="显式允许缺失/null/空串/仅空白字符互等；仍输出被忽略差异")
    parser.add_argument("--include-values", action="store_true", help="在私有差异报告中写入完整值；报告可能含用例敏感信息")
    parser.add_argument("--output-dir", type=Path, default=Path("ddt-verification-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:6]))
    parser.add_argument("--requests-per-second", type=float, default=5, help="两平台合计请求上限，默认 5；始终串行")
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--retries", type=int, default=2, help="只读请求有限重试次数（0–5）")
    parser.add_argument("--csv-encoding", default="utf-8-sig")
    parser.add_argument("--max-uncompressed-mib", type=int, default=2048)
    options = parser.parse_args(argv)
    if not math.isfinite(options.requests_per_second) or not 0 < options.requests_per_second <= 100:
        parser.error("请求频率应为 0–100 之间的有限正数。")
    if not math.isfinite(options.timeout) or not 0 < options.timeout <= 300 or not 0 <= options.retries <= 5:
        parser.error("超时应在 0–300 秒之间，重试应在 0–5 之间。")
    if not 1 <= options.max_uncompressed_mib <= 16384:
        parser.error("解压预算应在 1–16384 MiB 之间。")
    try:
        codecs.lookup(options.csv_encoding)
    except LookupError:
        parser.error("CSV 字符编码名称无效。")
    return options


def main(argv=None):
    options = arguments(argv)
    report = None
    exit_code = 3
    try:
        endpoints = {origin: Endpoint.parse(getattr(options, origin + "_url"),
                     os.environ.get(getattr(options, origin + "_token_env"), ""),
                     getattr(options, origin + "_ca_file")) for origin in ("source", "target")}
        if not options.file_scope_only and not all(endpoint.token for endpoint in endpoints.values()):
            raise VerificationError("全量验证需要两端 case.read API Key 环境变量；仅验证表格范围请显式使用 --file-scope-only。")
        report = Report(options.output_dir, options.include_values, options.ignore_empty)
        report.summary["endpoints"] = {origin: endpoint.prefix for origin, endpoint in endpoints.items()}
        report.summary["files"] = []
        pacer = RequestPacer(options.requests_per_second)
        readers = {origin: ApiReader(endpoint, pacer, options.timeout, options.retries) for origin, endpoint in endpoints.items()}
        with tempfile.TemporaryDirectory(prefix="autoforge-ddt-verification-") as directory:
            with closing(sqlite3.connect(Path(directory) / "index.sqlite")) as connection:
                index = CaseIndex(connection)
                for book, path in enumerate(options.file):
                    digest = file_fingerprint(path)
                    report.summary["files"].append({"name": path.name, "sha256": digest})
                    read_spreadsheet(index, path, book, options.csv_encoding, options.max_uncompressed_mib * 1024 * 1024)
                    if file_fingerprint(path) != digest:
                        raise VerificationError(f"表格在读取期间被修改：{path.name}")
                connection.commit()
                print(f"表格包含 {index.count('table')} 条用例；串行读取，合计上限 {options.requests_per_second:g} 请求/秒。", flush=True)
                reconcile(index, readers, report, options.file_scope_only)
                for path, record in zip(options.file, report.summary["files"]):
                    if file_fingerprint(path) != record["sha256"]:
                        report.summary["complete"] = False
                        report.summary["result"] = "incomplete"
                        raise VerificationError(f"表格在验证期间被修改：{path.name}")
        exit_code = 3 if not report.summary["complete"] else 1 if report.summary["differences"] else 0
    except KeyboardInterrupt:
        if report:
            report.summary["complete"] = False
            report.summary["result"] = "incomplete"
            report.error("verification", "", "用户中断，未完成验证。")
        exit_code = 130
    except (VerificationError, OSError, ValueError, KeyError, RecursionError, csv.Error,
            ElementTree.ParseError, zipfile.BadZipFile, sqlite3.Error) as error:
        if report:
            report.summary["complete"] = False
            report.summary["result"] = "incomplete"
            report.error("verification", "", error)
        else:
            print(str(error), file=sys.stderr)
    finally:
        if report:
            try:
                report.close()
                print(f"结果：{report.summary['result']}；报告：{report.directory}", flush=True)
                if options.file_scope_only:
                    print("仅验证表格范围，未证明两平台没有额外用例或验证期间没有修改。", flush=True)
            except OSError as error:
                print(f"无法完整写入报告：{error}", file=sys.stderr)
                exit_code = 3
    return exit_code


def file_fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    sys.exit(main())
