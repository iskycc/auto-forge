import { setImmediate as yieldTurn } from "node:timers/promises";
import { DomainError, normalizeDdtSrTagKey } from "@autoforge/domain";
import {
  SR_TAG_IMPORT_BATCH_SIZE,
  SR_TAG_IMPORT_ISSUE_LIMIT,
  SR_TAG_IMPORT_SAMPLE_LIMIT,
  type DdtSrTagScope,
  type ParsedSrTagImport,
  type SrTagImportPreview,
  type SrTagImportResult,
} from "@autoforge/contracts";
import type { DdtSrTagRepository } from "./ddt-sr-tags";
import type { Clock, IdGenerator } from "./ports";

export interface SrTagSpreadsheetPort {
  parse(content: Uint8Array, fileName: string): Promise<ParsedSrTagImport>;
}
export class DdtSrTagImportService {
  constructor(
    private readonly repository: Pick<
      DdtSrTagRepository,
      "findSrKeys" | "importPage" | "classifications"
    >,
    private readonly spreadsheet: SrTagSpreadsheetPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}
  async read(
    scope: DdtSrTagScope,
    upload: { content: Uint8Array; fileName: string },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const parsed = await this.spreadsheet.parse(upload.content, upload.fileName);
    const issues = [...parsed.issues];
    let issueCount = parsed.issueCount;
    const keys = [...new Set(parsed.rows.map((row) => normalizeDdtSrTagKey(row.srNum)))];
    const missing = new Set<string>();
    for (let offset = 0; offset < keys.length; offset += SR_TAG_IMPORT_BATCH_SIZE) {
      signal.throwIfAborted();
      const slice = keys.slice(offset, offset + SR_TAG_IMPORT_BATCH_SIZE);
      const existing = new Set(await this.repository.findSrKeys(scope, slice));
      for (const key of slice) if (!existing.has(key)) missing.add(key);
      await yieldTurn();
    }
    for (const row of parsed.rows)
      if (missing.has(normalizeDdtSrTagKey(row.srNum))) {
        issueCount++;
        if (issues.length < SR_TAG_IMPORT_ISSUE_LIMIT)
          issues.push({
            ...row,
            reason: "当前项目版本不存在此 SR，请先导入对应 DDT 用例或检查 SR 拼写。",
          });
      }
    const preview: SrTagImportPreview = {
      rowCount: parsed.rowCount,
      issueCount,
      issues,
      samples: parsed.rows.slice(0, SR_TAG_IMPORT_SAMPLE_LIMIT),
    };
    return { parsed, preview };
  }
  async apply(
    scope: DdtSrTagScope,
    parsed: ParsedSrTagImport,
    preview: SrTagImportPreview,
    signal: AbortSignal,
  ): Promise<SrTagImportResult> {
    if (preview.issueCount)
      throw new DomainError("SR_TAG_IMPORT_INVALID", "表格存在问题，请修正后重新预览。", {
        details: preview,
      });
    let createdCount = 0,
      completedCount = 0;
    try {
      for (let offset = 0; offset < parsed.rows.length; offset += SR_TAG_IMPORT_BATCH_SIZE) {
        signal.throwIfAborted();
        const rows = parsed.rows
          .slice(offset, offset + SR_TAG_IMPORT_BATCH_SIZE)
          .map((row) => ({ ...row, tagId: this.ids.next() }));
        createdCount += await this.repository.importPage(
          scope,
          rows,
          this.clock.now().toISOString(),
        );
        completedCount += rows.length;
        await yieldTurn();
      }
    } catch (cause) {
      throw new DomainError(
        "SR_TAG_IMPORT_INTERRUPTED",
        `导入中断，已处理 ${completedCount} 行，其中新增 ${createdCount} 条关联；可重新导入，已有的关联会复用。`,
        { cause, details: { completedCount, createdCount } },
      );
    }
    return {
      rowCount: parsed.rowCount,
      createdCount,
      existingCount: completedCount - createdCount,
    };
  }
  async *exportPages(scope: DdtSrTagScope, signal: AbortSignal) {
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await this.repository.classifications(scope, cursor);
      yield page.items;
      if (page.nextCursor === cursor && page.nextCursor)
        throw new DomainError("SR_TAG_EXPORT_CURSOR_INVALID", "标签导出分页未能继续，请重试。");
      cursor = page.nextCursor;
      await yieldTurn();
    } while (cursor);
  }
}
