import "server-only";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import ExcelJS from "exceljs";
import { DomainError } from "@autoforge/domain";
import type { DdtAssociationExportPage } from "@autoforge/application";
import { DDT_ASSOCIATION_SHEETS, type DdtAssociationSection } from "@autoforge/contracts";
import { openTemporaryExportFile } from "./export-temporary-file";
import { exportWorksheetOptions, styleExportHeader, styleExportRow } from "./export-workbook-style";
import { exportCellTextIssues } from "./export-cell-validation";

export async function prepareDdtAssociationExport(
  pages: (section: DdtAssociationSection) => AsyncIterable<DdtAssociationExportPage>,
  directory: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const file = await openTemporaryExportFile(directory);
  const stream = new PassThrough({ highWaterMark: 256 * 1024 });
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      void file.writeFile(chunk).then(() => done(), done);
    },
  });
  const transferred = pipeline(stream, destination, { signal });
  const observed = transferred.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  const sections = Object.keys(DDT_ASSOCIATION_SHEETS) as DdtAssociationSection[];
  const digest = createHash("sha256");
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream,
      useSharedStrings: false,
      useStyles: true,
    });
    workbook.creator = "AutoForge";
    for (const section of sections) {
      const definition = DDT_ASSOCIATION_SHEETS[section];
      const sheet = workbook.addWorksheet(definition.name, exportWorksheetOptions());
      sheet.columns = definition.headers.map((name) => ({
        header: name,
        width: name === "测试类路径" ? 80 : name === "异常说明" ? 60 : 28,
      }));
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: definition.headers.length },
      };
      styleExportHeader(sheet.getRow(1));
      sheet.getRow(1).commit();
      let count = 0;
      for await (const page of pages(section)) {
        signal.throwIfAborted();
        for (const record of page.rows) {
          if (record.values.some((value) => exportCellTextIssues(value).length))
            throw new DomainError(
              "EXPORT_DATA_INVALID",
              `${definition.name} 中 ${record.values[0]?.slice(0, 120)} 含 Excel 不支持的文本，请修正后导出。`,
            );
          digest.update(JSON.stringify([section, record.values, record.revisionIdentity]) + "\n");
          if (++count >= 1_048_576)
            throw new DomainError("EXPORT_DATA_INVALID", "关联配置超过 Excel 工作表行数限制。");
          const row = sheet.addRow(record.values);
          styleExportRow(row, definition.headers.length);
          row.commit();
        }
        await yieldTurn();
      }
      sheet.commit();
    }
    const guide = workbook.addWorksheet("说明", exportWorksheetOptions());
    guide.columns = [{ header: "SR 测试类关联配置", width: 100 }];
    styleExportHeader(guide.getRow(1));
    guide.getRow(1).commit();
    for (const instruction of [
      "保留工作表名称与首行表头。四个工作表分别维护候选测试类、分类执行类、SR需求分类、历史直接关联。",
      "导入使用当前项目、版本、测试阶段，按完整测试类路径与分类／SR名称匹配，不使用来源数据库ID。",
      "导入合并覆盖表中列出的同名配置，未列出的配置保留。SR的分类或直接测试类留空表示解除关联。",
      "SR不能同时出现在两个关联工作表中。请先在目标导入对应 TestNG JAR 和 DDT 用例，再导入关联配置。",
      "如有异常说明，请修正关联后清空该说明再预览；不把问题行静默忽略。此文件不包含独立的SR标签。",
    ]) {
      const row = guide.addRow([instruction]);
      styleExportRow(row, 1);
      row.commit();
    }
    guide.commit();
    await workbook.commit();
    const failure = await observed;
    if (failure) throw failure;
    const verified = createHash("sha256");
    for (const section of sections)
      for await (const page of pages(section)) {
        signal.throwIfAborted();
        for (const record of page.rows)
          verified.update(JSON.stringify([section, record.values, record.revisionIdentity]) + "\n");
        await yieldTurn();
      }
    if (digest.digest("hex") !== verified.digest("hex"))
      throw new DomainError(
        "DDT_ASSOCIATION_EXPORT_CONFLICT",
        "导出期间关联配置发生变化，请待修改完成后重新导出。",
      );
    return { file, sizeBytes: (await file.stat()).size };
  } catch (cause) {
    stream.destroy(cause instanceof Error ? cause : new Error("导出关联配置失败。", { cause }));
    await observed;
    await file.close();
    throw cause;
  }
}
