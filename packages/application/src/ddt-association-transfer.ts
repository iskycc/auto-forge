import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  DomainError,
  isDomainError,
  type DdtExecutionClass,
  type DdtRequirementCategory,
  type DdtScope,
  type DdtSrExecutionMapping,
} from "@autoforge/domain";
import {
  DDT_ASSOCIATION_IMPORT_ISSUE_LIMIT,
  type DdtAssociationImportIssue,
  type DdtAssociationImportPreview,
  type DdtAssociationImportProgress,
  type DdtAssociationImportRow,
  type DdtAssociationSection,
  type ParsedDdtAssociationImport,
} from "@autoforge/contracts";
import type { Clock, DdtRepository, IdGenerator } from "./ports";
import { DdtCaseService } from "./manage-ddt-cases";

const PAGE_SIZE = 100;
const keyOf = (value: string) => value.trim().toLocaleLowerCase("en-US");
type AssociationTarget = {
  categories: Map<string, DdtRequirementCategory>;
  mappings: Map<string, DdtSrExecutionMapping>;
  classes: Map<string, DdtExecutionClass>;
  included: Set<string>;
  rangeRevision: number;
};
export type DdtAssociationImportPlan = {
  parsed: ParsedDdtAssociationImport;
  preview: DdtAssociationImportPreview;
  target: AssociationTarget;
};
export type DdtAssociationExportPage = {
  section: DdtAssociationSection;
  rows: Array<{ values: string[]; revisionIdentity: string }>;
};

export interface DdtAssociationSpreadsheetPort {
  parse(content: Uint8Array, fileName: string): Promise<ParsedDdtAssociationImport>;
}

/** Portable configuration uses full class paths and category/SR names, never source database IDs. */
export class DdtAssociationTransferService {
  private readonly cases: DdtCaseService;
  constructor(
    private readonly repository: DdtRepository,
    private readonly spreadsheet: DdtAssociationSpreadsheetPort,
    clock: Clock,
    ids: IdGenerator,
  ) {
    this.cases = new DdtCaseService(repository, clock, ids);
  }

  async read(
    scope: DdtScope,
    upload: { content: Uint8Array; fileName: string },
    signal: AbortSignal,
  ): Promise<DdtAssociationImportPlan> {
    signal.throwIfAborted();
    const parsed = await this.spreadsheet.parse(upload.content, upload.fileName);
    const target: AssociationTarget = {
      categories: new Map(),
      mappings: new Map(),
      classes: new Map(),
      included: new Set(),
      rangeRevision: 0,
    };
    const wantedCategories = new Set(
      parsed.rows.flatMap((row) =>
        "categoryName" in row && row.categoryName ? [keyOf(row.categoryName)] : [],
      ),
    );
    if (wantedCategories.size) {
      for await (const page of pages(
        (cursor) =>
          this.repository.listRequirementCategories(scope, {
            query: "",
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          }),
        signal,
      )) {
        for (const category of page.items)
          if (wantedCategories.has(keyOf(category.name)))
            target.categories.set(keyOf(category.name), category);
      }
    }
    const fileCategories = new Map(
      parsed.rows
        .filter((row) => row.section === "categories")
        .map((row) => [keyOf(row.categoryName), row]),
    );
    const wantedClasses = new Set(
      parsed.rows.flatMap((row) => ("className" in row && row.className ? [row.className] : [])),
    );
    for (const row of parsed.rows) {
      if (
        row.section !== "srCategories" ||
        !row.categoryName ||
        fileCategories.has(keyOf(row.categoryName))
      )
        continue;
      const existing = target.categories.get(keyOf(row.categoryName));
      if (existing?.executionClass) wantedClasses.add(existing.executionClass.className);
    }
    let checked = 0;
    for (const className of wantedClasses) {
      signal.throwIfAborted();
      const candidate = await this.repository.findExecutionClass(scope, className);
      if (candidate?.enabled && !candidate.archived) target.classes.set(className, candidate);
      if (++checked % 20 === 0) await yieldTurn();
    }
    let observedRangeRevision: number | undefined;
    for await (const page of pages(
      (cursor) =>
        this.repository.listExecutionClassRange(scope, {
          query: "",
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
      signal,
    )) {
      if (observedRangeRevision !== undefined && observedRangeRevision !== page.revision)
        throw new DomainError(
          "DDT_ASSOCIATION_IMPORT_CONFLICT",
          "预览期间候选测试类范围已变化，请重新预览。",
        );
      observedRangeRevision = page.revision;
      target.rangeRevision = page.revision;
      for (const candidate of page.items)
        if (wantedClasses.has(candidate.className)) target.included.add(candidate.className);
    }
    const wantedSrs = new Set(
      parsed.rows.flatMap((row) => ("srNum" in row ? [keyOf(row.srNum)] : [])),
    );
    if (wantedSrs.size) {
      for await (const page of pages(
        (cursor) =>
          this.repository.listSrExecutionMappings(scope, {
            query: "",
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          }),
        signal,
      )) {
        for (const mapping of page.items)
          if (wantedSrs.has(keyOf(mapping.srNum)))
            target.mappings.set(keyOf(mapping.srNum), mapping);
        if (target.mappings.size === wantedSrs.size) break;
      }
    }
    const issues: DdtAssociationImportIssue[] = [...parsed.issues];
    let issueCount = parsed.issueCount;
    const issue = (row: DdtAssociationImportRow, reason: string) => {
      issueCount++;
      if (issues.length < DDT_ASSOCIATION_IMPORT_ISSUE_LIMIT)
        issues.push({
          sheetName: row.sheetName,
          rowNumber: row.rowNumber,
          identifier:
            "srNum" in row ? row.srNum : "categoryName" in row ? row.categoryName : row.className,
          reason,
        });
    };
    for (const row of parsed.rows) {
      if ("className" in row && row.className && !target.classes.has(row.className))
        issue(
          row,
          `目标阶段没有可执行的测试类 ${row.className}，请先导入对应 TestNG JAR／用例并启用测试类。`,
        );
      if ("srNum" in row && !target.mappings.has(keyOf(row.srNum)))
        issue(row, "目标项目版本、测试阶段没有此 SR，请先导入对应 DDT 用例。");
      if (
        row.section === "srCategories" &&
        row.categoryName &&
        !fileCategories.has(keyOf(row.categoryName))
      ) {
        const category = target.categories.get(keyOf(row.categoryName));
        if (!category)
          issue(row, `需求分类 ${row.categoryName} 未在目标或“分类执行类”工作表中定义。`);
        else if (!category.executionClass || !target.classes.has(category.executionClass.className))
          issue(row, "目标分类没有可执行的测试类，请在“分类执行类”工作表中修正绑定。");
      }
    }
    const fingerprint = createHash("sha256")
      .update(upload.content)
      .update(
        JSON.stringify({
          scope,
          rangeRevision: target.rangeRevision,
          categories: [...target.categories.entries()].sort(),
          mappings: [...target.mappings.entries()].sort(),
          classes: [...target.classes.entries()].sort(),
          included: [...target.included].sort(),
        }),
      )
      .digest("hex");
    const counts = { range: 0, categories: 0, srCategories: 0, srClasses: 0 };
    for (const row of parsed.rows) counts[row.section]++;
    return {
      parsed,
      target,
      preview: {
        fingerprint,
        rowCount: parsed.rowCount,
        issueCount,
        issues,
        counts,
        samples: parsed.rows.slice(0, 20),
      },
    };
  }

  async apply(
    scope: DdtScope,
    plan: DdtAssociationImportPlan,
    fingerprint: string,
    signal: AbortSignal,
    onProgress: (progress: DdtAssociationImportProgress) => void,
  ): Promise<DdtAssociationImportProgress> {
    if (plan.preview.issueCount)
      throw new DomainError(
        "DDT_ASSOCIATION_IMPORT_INVALID",
        "关联表格存在问题，请修正后重新预览。",
        { details: plan.preview },
      );
    if (fingerprint !== plan.preview.fingerprint)
      throw new DomainError(
        "DDT_ASSOCIATION_IMPORT_CONFLICT",
        "文件或目标关联配置已变化，请检查更新后的预览再确认导入。",
        { details: plan.preview },
      );
    const { target } = plan;
    const categories = plan.parsed.rows.filter((row) => row.section === "categories");
    const mappings = plan.parsed.rows.filter(
      (row) => row.section === "srCategories" || row.section === "srClasses",
    );
    const progress: DdtAssociationImportProgress = {
      total: target.classes.size + categories.length + mappings.length,
      processed: 0,
      changed: 0,
      unchanged: 0,
      phase: "range",
    };
    let current: { sheetName: string; rowNumber: number } | undefined;
    const completed = async (changed: boolean) => {
      progress.processed++;
      progress[changed ? "changed" : "unchanged"]++;
      if (progress.processed % 20 === 0 || progress.processed === progress.total) {
        onProgress({ ...progress });
        await yieldTurn();
      }
    };
    onProgress({ ...progress });
    try {
      for (const candidate of target.classes.values()) {
        signal.throwIfAborted();
        const existing = target.included.has(candidate.className);
        if (!existing) {
          await this.cases.changeExecutionClassRange(scope, {
            caseDefinitionId: candidate.caseDefinitionId,
            className: candidate.className,
            included: true,
            expectedRevision: target.rangeRevision,
          });
          target.rangeRevision++;
          target.included.add(candidate.className);
        }
        await completed(!existing);
      }
      progress.phase = "categories";
      for (const row of categories) {
        signal.throwIfAborted();
        current = row;
        const existing = target.categories.get(keyOf(row.categoryName));
        const unchanged =
          existing?.name === row.categoryName &&
          existing.executionClass?.className === row.className;
        if (!unchanged) {
          const saved = await this.cases.saveRequirementCategory(scope, {
            ...(existing ? { id: existing.id } : {}),
            name: row.categoryName,
            className: row.className,
            expectedRevision: existing?.revision ?? 0,
          });
          target.categories.set(keyOf(row.categoryName), {
            id: saved.id,
            name: row.categoryName,
            revision: (existing?.revision ?? 0) + 1,
            executionClass: target.classes.get(row.className)!,
          });
        }
        await completed(!unchanged);
      }
      for (const row of mappings) {
        signal.throwIfAborted();
        current = row;
        progress.phase = row.section;
        const existing = target.mappings.get(keyOf(row.srNum))!;
        let unchanged: boolean;
        if (row.section === "srCategories") {
          const category = row.categoryName
            ? target.categories.get(keyOf(row.categoryName))!
            : null;
          unchanged =
            !existing.legacyConflict &&
            (category
              ? existing.category?.id === category.id
              : !existing.category && !existing.executionClass);
          if (!unchanged)
            await this.cases.setSrCategory(scope, {
              srNum: existing.srNum,
              categoryId: category?.id ?? null,
              expectedRevision: existing.revision,
            });
        } else {
          unchanged =
            !existing.legacyConflict &&
            !existing.category &&
            (existing.executionClass?.className ?? "") === row.className;
          if (!unchanged)
            await this.cases.setSrExecutionClass(scope, {
              srNum: existing.srNum,
              className: row.className || null,
              expectedRevision: existing.revision,
            });
        }
        await completed(!unchanged);
      }
      return { ...progress };
    } catch (cause) {
      throw new DomainError(
        "DDT_ASSOCIATION_IMPORT_INTERRUPTED",
        `${current ? `${current.sheetName} 第 ${current.rowNumber} 行：` : ""}导入中断，已处理 ${progress.processed}/${progress.total} 项，其中变更 ${progress.changed} 项；已保存内容保留，可重新预览后幂等导入。${isDomainError(cause) ? cause.message : "请检查目标配置与数据库状态。"}`,
        { cause, details: progress },
      );
    }
  }

  async *exportPages(
    scope: DdtScope,
    section: DdtAssociationSection,
    signal: AbortSignal,
  ): AsyncGenerator<DdtAssociationExportPage> {
    if (section === "range") {
      for await (const page of pages(
        (cursor) =>
          this.repository.listExecutionClassRange(scope, {
            query: "",
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          }),
        signal,
      )) {
        yield {
          section,
          rows: page.items.map((item) => ({
            values: [
              item.className,
              !item.enabled || item.archived
                ? "来源测试类已停用或归档，请修复后清空本说明再导入。"
                : "",
            ],
            revisionIdentity: JSON.stringify([page.revision, item]),
          })),
        };
      }
      return;
    }
    if (section === "categories") {
      for await (const page of pages(
        (cursor) =>
          this.repository.listRequirementCategories(scope, {
            query: "",
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          }),
        signal,
      )) {
        yield {
          section,
          rows: page.items.map((item) => ({
            values: [
              item.name,
              item.executionClass?.className ?? "",
              item.executionClass && item.executionClass.enabled && !item.executionClass.archived
                ? ""
                : "来源分类没有可用测试类，请修复后清空本说明再导入。",
            ],
            revisionIdentity: JSON.stringify(item),
          })),
        };
      }
      return;
    }
    for await (const page of pages(
      (cursor) =>
        this.repository.listSrExecutionMappings(scope, {
          query: "",
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        }),
      signal,
    )) {
      const selected = page.items.filter((item) =>
        section === "srClasses"
          ? !item.category && Boolean(item.executionClass)
          : Boolean(item.category) || !item.executionClass,
      );
      yield {
        section,
        rows: selected.map((item) => ({
          values: [
            item.srNum,
            section === "srClasses"
              ? (item.executionClass?.className ?? "")
              : (item.category?.name ?? ""),
            item.legacyConflict ? "来源存在历史关联冲突，请明确修复关联后清空本说明再导入。" : "",
          ],
          revisionIdentity: JSON.stringify(item),
        })),
      };
    }
  }
}

async function* pages<Page extends { items: readonly unknown[]; nextCursor?: string | undefined }>(
  read: (cursor?: string) => Promise<Page>,
  signal: AbortSignal,
): AsyncGenerator<Page> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    signal.throwIfAborted();
    const page = await read(cursor);
    yield page;
    cursor = page.nextCursor;
    if (cursor && (!page.items.length || seen.has(cursor)))
      throw new DomainError(
        "DDT_ASSOCIATION_PAGINATION_INVALID",
        "关联配置分页没有进展，请刷新后重试。",
      );
    if (cursor) seen.add(cursor);
    await yieldTurn();
  } while (cursor);
}
