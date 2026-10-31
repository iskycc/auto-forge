import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildExportWorkbook } from "@autoforge/ddt-import";
import type { DdtCaseData } from "@autoforge/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { prepareDdtExportFile } from "./ddt-export-file";

const execute = promisify(execFile);
const cases: DdtCaseData[] = [
  {
    CaseID: "中文/钱包?0001#%",
    srNum: "Wallet",
    CaseName: "中文用例😀",
    SRID: "0000123",
    zero: 0,
    enabled: false,
    data: "字段名可以叫 data",
    body: "<请求>&\n下一行",
  },
  { CaseID: "PAY-02", srNum: "Pay", 支付参数: "00100" },
  {
    CaseID: "J-01",
    srNum: "旅程",
    用户旅程: { step1: { CaseID: "J-01", srNum: "旅程", amount: 0 } },
  },
  {
    CaseID: "J-02",
    srNum: "旅程",
    用户旅程: {
      step1: { CaseID: "J-02", srNum: "旅程", amount: 100 },
      step2: { CaseID: "J-02", srNum: "旅程", accepted: false },
    },
  },
];

describe("standalone Python verifier compatibility with production DDT exports", () => {
  it.each(["streaming", "legacy"] as const)(
    "reconciles all fields and sparse journey steps in a %s workbook against both HTTP APIs",
    async (writer) => {
      const directory = await mkdtemp(join(tmpdir(), "ddt-transfer-verifier-"));
      const requests: { path: string; authorization: string | undefined }[] = [];
      const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://localhost");
        requests.push({ path: url.pathname, authorization: request.headers.authorization });
        response.setHeader("Content-Type", "application/json");
        if (url.pathname === "/api/v1/ddt/cases") {
          if (request.headers.authorization !== "Bearer read-only-fixture") {
            response.writeHead(401).end(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }));
            return;
          }
          response.end(
            JSON.stringify({
              items: cases.map((row, index) => ({
                id: `${url.searchParams.get("projectId")}-${index}`,
                projectId: url.searchParams.get("projectId"),
                projectVersionId: "version",
                testStageId: "stage",
                caseId: row.CaseID,
                srNum: row.srNum,
                revision: 1,
                updatedAt: "2026-10-31T00:00:00Z",
              })),
            }),
          );
          return;
        }
        const row = cases.find((item) => item.CaseID === url.searchParams.get("caseId"));
        if (!row) {
          response.writeHead(404).end(JSON.stringify({ error: { code: "DDT_CASE_NOT_FOUND" } }));
          return;
        }
        response.end(JSON.stringify(row));
      });
      try {
        const spreadsheet = join(directory, "platform-export.xlsx");
        if (writer === "legacy") {
          await writeFile(spreadsheet, buildExportWorkbook(cases));
        } else {
          async function* pages() {
            yield cases.slice(0, 2);
            yield cases.slice(2);
          }
          const prepared = await prepareDdtExportFile(
            pages(),
            new AbortController().signal,
            directory,
          );
          try {
            const bytes = Buffer.alloc(prepared.sizeBytes);
            await prepared.file.read(bytes, 0, bytes.length, 0);
            await writeFile(spreadsheet, bytes);
          } finally {
            await prepared.file.close();
          }
        }
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture port");
        const prefix = `http://127.0.0.1:${address.port}/api/v1/public/ddt/projects`;
        await execute(
          "python3",
          [
            "-B",
            resolve("scripts/operations/verify_ddt_transfer.py"),
            "--file",
            spreadsheet,
            "--source-url",
            `${prefix}/source/versions/version/stages/stage`,
            "--target-url",
            `${prefix}/target/versions/version/stages/stage`,
            "--source-token-env",
            "AUTOFORGE_VERIFIER_TEST_TOKEN",
            "--target-token-env",
            "AUTOFORGE_VERIFIER_TEST_TOKEN",
            "--requests-per-second",
            "100",
            "--output-dir",
            join(directory, "report"),
          ],
          {
            env: { ...process.env, AUTOFORGE_VERIFIER_TEST_TOKEN: "read-only-fixture" },
            timeout: 15_000,
          },
        );
        expect(
          JSON.parse(await readFile(join(directory, "report/summary.json"), "utf8")),
        ).toMatchObject({
          complete: true,
          result: "exact_match",
          checkedCases: 4,
          differentCases: 0,
          differences: 0,
          readErrors: 0,
          inventoryVerified: true,
          stabilityVerified: true,
        });
        expect(requests).toHaveLength(12);
        expect(requests.filter((request) => request.path.endsWith("/case"))).toHaveLength(8);
        expect(
          requests
            .filter((request) => request.path.endsWith("/case"))
            .every((request) => !request.authorization),
        ).toBe(true);
      } finally {
        if (server.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolveClose, rejectClose) =>
            server.close((error) => (error ? rejectClose(error) : resolveClose())),
          );
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
