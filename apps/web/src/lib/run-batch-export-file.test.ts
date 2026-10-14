import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { RunBatchExportRow } from "@autoforge/application";
import ExcelJS from "exceljs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
import { prepareRunBatchExportFile, readRunBatchExportFile } from "./run-batch-export-file";
import type { RunBatchExportWorkbookInput } from "./run-batch-export-xlsx";

const row: RunBatchExportRow = {
  attemptId: "attempt",
  executionRunId: "run",
  casePath: "中文😀",
  displayName: "用例",
  outcome: "failed",
  resultCode: null,
  summary: "stack",
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  round: 1,
};
let controller: AbortController;
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "autoforge-export-file-test-"));
  controller = new AbortController();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function pages(rows: RunBatchExportRow[]) {
  return (async function* (): AsyncGenerator<RunBatchExportWorkbookInput> {
    yield {
      batchId: "batch",
      scope: "final",
      template: "failure-analysis",
      rows,
      shareLinks: new Map(),
    };
  })();
}

describe("complete private export files", () => {
  it("finishes cancellation even when it arrives as the ZIP writer begins committing", async () => {
    const commit = ExcelJS.stream.xlsx.WorkbookWriter.prototype.commit;
    const interruptedCommit = vi
      .spyOn(ExcelJS.stream.xlsx.WorkbookWriter.prototype, "commit")
      .mockImplementation(function (this: ExcelJS.stream.xlsx.WorkbookWriter) {
        controller.abort(new Error("cancel ZIP commit"));
        return commit.call(this);
      });
    try {
      await expect(
        prepareRunBatchExportFile(pages([row]), controller.signal, { directory }),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      interruptedCommit.mockRestore();
    }
  });

  it("does not deliver a complete ZIP when page iterator finalization fails", async () => {
    let next = 0;
    const source: AsyncIterable<RunBatchExportWorkbookInput> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return next++ === 0
              ? {
                  done: false as const,
                  value: {
                    batchId: "batch",
                    scope: "final" as const,
                    rows: [row],
                    shareLinks: new Map<string, string>(),
                  },
                }
              : { done: true as const, value: undefined };
          },
          async return() {
            throw new Error("page cleanup failed");
          },
        };
      },
    };
    await expect(
      prepareRunBatchExportFile(source, controller.signal, { directory }),
    ).rejects.toThrow("page cleanup failed");
    expect(await readdir(directory)).toEqual([]);
  });
  it("streams a complete ZIP and closes its only file owner after download", async () => {
    const prepared = await prepareRunBatchExportFile(pages([row]), controller.signal, {
      directory,
    });
    expect(await readdir(directory)).toEqual([]);
    const stream = readRunBatchExportFile(prepared, controller.signal);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    if (!stream.closed) await once(stream, "close");
    expect(prepared.file.fd).toBe(-1);
    const buffer = Buffer.concat(chunks);
    expect(buffer.length).toBe(prepared.sizeBytes);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(buffer).buffer);
    expect(workbook.worksheets[0]!.getCell("A2").value).toBe(row.casePath);
  });
  it("bounds the popup preview while retaining every excluded record in the workbook", async () => {
    const prepared = await prepareRunBatchExportFile(
      pages(
        Array.from({ length: 103 }, (_, index) => ({
          ...row,
          executionRunId: `bad-${index}`,
          summary: "bad\uffff",
        })),
      ),
      controller.signal,
      { directory, invalidRows: "exclude" },
    );
    expect(prepared.validation).toMatchObject({
      totalRows: 103,
      validRows: 0,
      excludedRows: 103,
      truncated: true,
    });
    expect(prepared.validation.issues).toHaveLength(100);
    const stream = readRunBatchExportFile(prepared, controller.signal);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(Buffer.concat(chunks)).buffer);
    expect(workbook.getWorksheet("失败用例分析清单")!.rowCount).toBe(1);
    expect(workbook.getWorksheet("排除明细")!.rowCount).toBe(104);
    expect(workbook.getWorksheet("排除明细")!.getCell("B104").value).toBe("bad-102");
  });
  it("does not finish file preparation when the client has already cancelled", async () => {
    controller.abort(new Error("user cancelled"));
    await expect(
      prepareRunBatchExportFile(pages([row]), controller.signal, { directory }),
    ).rejects.toThrow("user cancelled");
  });
  it("cancels a prepared download and closes its file descriptor", async () => {
    const prepared = await prepareRunBatchExportFile(pages([row]), controller.signal, {
      directory,
    });
    const stream = readRunBatchExportFile(prepared, controller.signal);
    const consumed = (async () => {
      for await (const chunk of stream) void chunk;
    })();
    controller.abort(new Error("cancel download"));
    await expect(consumed).rejects.toThrow("cancel download");
    if (!stream.closed) await once(stream, "close");
    expect(prepared.file.fd).toBe(-1);
  });
  it("closes the page iterator when cancellation occurs during generation", async () => {
    let closed = false;
    const source = (async function* (): AsyncGenerator<RunBatchExportWorkbookInput> {
      try {
        yield { batchId: "batch", scope: "final", rows: [row], shareLinks: new Map() };
        controller.abort(new Error("cancel preparation"));
        controller.signal.throwIfAborted();
      } finally {
        closed = true;
      }
    })();
    await expect(
      prepareRunBatchExportFile(source, controller.signal, { directory }),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  });
});
