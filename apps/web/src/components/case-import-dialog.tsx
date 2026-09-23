"use client";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type { CaseDirectorySelection } from "@autoforge/contracts";
import { Table2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, FileInput, OperationProgress, Textarea } from "@/components/ui";
import { parseCasePathFile } from "@/lib/case-path-file";
import { readFileWithProgress } from "@/lib/read-file-with-progress";
import {
  matchCasePaths,
  parseCasePathColumn,
  type CasePathMatchResult,
} from "@/lib/case-path-import";

const MAX_UNMATCHED_PREVIEW = 10;

type CaseImportDialogProps = {
  cases: CaseDirectorySelection[];
  resolvePaths?(paths: string[], signal: AbortSignal): Promise<CaseDirectorySelection[]>;
  onImport(matched: CaseDirectorySelection[], unmatchedCount: number): void;
};

export function CaseImportDialog({ cases, onImport, resolvePaths }: CaseImportDialogProps) {
  const [open, setOpen] = useState(false);
  const [filePaths, setFilePaths] = useState<string[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [readingFile, setReadingFile] = useState(false);
  const [fileProgress, setFileProgress] = useState<{
    label: string;
    percent: number;
  }>();
  const [pastedText, setPastedText] = useState("");
  const [result, setResult] = useState<CasePathMatchResult<CaseDirectorySelection> | null>(null);
  const fileReadGeneration = useRef(0);
  const pathMatchController = useRef<AbortController | null>(null);
  useEffect(() => () => pathMatchController.current?.abort(), []);

  function closeDialog() {
    pathMatchController.current?.abort();
    fileReadGeneration.current += 1;
    setOpen(false);
    setFilePaths(null);
    setFileName("");
    setFileError("");
    setReadingFile(false);
    setFileProgress(undefined);
    setPastedText("");
    setResult(null);
  }

  async function readFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.item(0);
    setResult(null);
    // 用户取消系统文件选择框时 files 为空，保留已读内容避免误清空。
    if (!file) return;
    const generation = fileReadGeneration.current + 1;
    fileReadGeneration.current = generation;
    setFilePaths(null);
    setFileName(file.name);
    setFileError("");
    setReadingFile(true);
    setFileProgress({ label: "正在读取用例表格", percent: 0 });
    try {
      const buffer = await readFileWithProgress(file, (percent) => {
        if (generation === fileReadGeneration.current) {
          setFileProgress({ label: "正在读取用例表格", percent });
        }
      });
      if (generation !== fileReadGeneration.current) return;
      setFileProgress({ label: "读取完成，正在解析用例路径", percent: 100 });
      const paths = await parseCasePathFile({
        name: file.name,
        size: file.size,
        type: file.type,
        arrayBuffer: async () => buffer,
      });
      if (generation !== fileReadGeneration.current) return;
      setFilePaths(paths);
      if (paths.length === 0) setFileError("首列没有可导入的用例路径。");
    } catch (error) {
      if (generation !== fileReadGeneration.current) return;
      setFileError(error instanceof Error ? error.message : "用例列表读取失败。");
    } finally {
      if (generation === fileReadGeneration.current) {
        setReadingFile(false);
        setFileProgress(undefined);
      }
    }
  }

  async function parseAndPreview(): Promise<void> {
    // 两种输入都存在时以文件为准，避免过期粘贴内容覆盖用户刚选的文件。
    const paths = filePaths?.length ? filePaths : parseCasePathColumn(pastedText);
    const generation = fileReadGeneration.current;
    pathMatchController.current?.abort();
    const controller = new AbortController();
    pathMatchController.current = controller;
    setReadingFile(true);
    setFileError("");
    try {
      const candidates = resolvePaths ? await resolvePaths(paths, controller.signal) : cases;
      if (generation === fileReadGeneration.current) setResult(matchCasePaths(candidates, paths));
    } catch (error) {
      if (generation === fileReadGeneration.current)
        setFileError(error instanceof Error ? error.message : "匹配用例失败。");
    } finally {
      if (generation === fileReadGeneration.current) setReadingFile(false);
    }
  }

  function applySelection(): void {
    if (!result || result.matched.length === 0) return;
    onImport(result.matched, result.unmatched.length);
    closeDialog();
  }

  const canParse = !readingFile && Boolean(filePaths?.length || pastedText.trim());
  const visibleUnmatched = result ? result.unmatched.slice(0, MAX_UNMATCHED_PREVIEW) : [];
  const hiddenUnmatched = result ? result.unmatched.length - visibleUnmatched.length : 0;
  const fileStatus = readingFile
    ? { prefix: "正在读取", suffix: "…" }
    : filePaths?.length
      ? { prefix: "已读取", suffix: `，共 ${filePaths.length} 条路径` }
      : null;

  return (
    <>
      <Button
        className={cn(
          "button button-secondary",
          uiPatterns["button"],
          uiPatterns["button-secondary"],
        )}
        onClick={() => setOpen(true)}
        type="button"
      >
        <Table2 size={15} /> 导入用例
      </Button>
      {open ? (
        <Dialog
          open
          title={"导入用例"}
          onClose={closeDialog}
          className={cn(
            "runner-update-dialog case-import-dialog",
            caseImportDialogStyles["runner-update-dialog"],
            caseImportDialogStyles["case-import-dialog"],
          )}
          backdropClassName="runner-update-overlay"
        >
          <header
            className={cn(
              "runner-update-titlebar",
              caseImportDialogStyles["runner-update-titlebar"],
            )}
          >
            <span>
              <Table2 size={16} aria-hidden="true" />
              <strong>导入用例</strong>
              <small>按“用例路径”列批量勾选</small>
            </span>
            <Button aria-label="关闭" onClick={closeDialog} type="button">
              <X size={16} />
            </Button>
          </header>
          <div
            className={cn(
              "runner-update-body case-import-body",
              caseImportDialogStyles["runner-update-body"],
              caseImportDialogStyles["case-import-body"],
            )}
          >
            <p className={cn("runner-update-hint", caseImportDialogStyles["runner-update-hint"])}>
              上传表格文件（.xlsx / .csv / .tsv / .txt），XLSX 读取首个工作表的第一列；也可从 Excel
              复制“用例路径”列直接粘贴。第一行可以是表头。路径支持目录写法 com/example/CheckoutTest
              和类名写法 com.example.CheckoutTest，与用例库精确匹配后批量勾选。
            </p>
            <div className={cn("runner-update-grid", caseImportDialogStyles["runner-update-grid"])}>
              <label
                className={cn("case-import-source", caseImportDialogStyles["case-import-source"])}
              >
                <span
                  className={cn(
                    "case-import-field-label",
                    caseImportDialogStyles["case-import-field-label"],
                  )}
                >
                  表格文件
                </span>
                <FileInput
                  accept=".xlsx,.csv,.tsv,.txt"
                  aria-label="选择用例表格文件"
                  onChange={(event) => void readFile(event.currentTarget)}
                />
                {fileStatus ? (
                  <small
                    aria-label={`${fileStatus.prefix} ${fileName}${fileStatus.suffix}`}
                    className={cn(
                      "case-import-file-status",
                      caseImportDialogStyles["case-import-file-status"],
                    )}
                    role="status"
                    title={`${fileStatus.prefix} ${fileName}${fileStatus.suffix}`}
                  >
                    <span>{fileStatus.prefix}</span>
                    <span
                      className={cn(
                        "case-import-file-name",
                        caseImportDialogStyles["case-import-file-name"],
                      )}
                    >
                      {fileName}
                    </span>
                    <span>{fileStatus.suffix}</span>
                  </small>
                ) : null}
                {fileError ? (
                  <small className={cn("auth-error", uiPatterns["auth-error"])} role="alert">
                    {fileError}
                  </small>
                ) : null}
              </label>
              <label
                className={cn("case-import-source", caseImportDialogStyles["case-import-source"])}
              >
                <span
                  className={cn(
                    "case-import-field-label",
                    caseImportDialogStyles["case-import-field-label"],
                  )}
                >
                  或直接粘贴
                </span>
                <Textarea
                  aria-label="粘贴用例路径"
                  onChange={(event) => {
                    setPastedText(event.currentTarget.value);
                    setResult(null);
                  }}
                  placeholder={
                    "每行一个用例路径，可含表头，例如：\n用例路径\ncom/example/CheckoutTest"
                  }
                  rows={4}
                  value={pastedText}
                />
              </label>
            </div>
            {fileProgress ? (
              <OperationProgress
                detail={fileName}
                label={fileProgress.label}
                value={fileProgress.percent}
              />
            ) : null}
            <div
              className={cn(
                "runner-installer-actions case-import-actions",
                caseImportDialogStyles["runner-installer-actions"],
                caseImportDialogStyles["case-import-actions"],
              )}
            >
              <Button
                className={cn("button-primary", uiPatterns["button-primary"])}
                disabled={!canParse}
                onClick={() => void parseAndPreview()}
                type="button"
              >
                解析并预览
              </Button>
            </div>

            {result ? (
              <div
                className={cn("case-import-result", caseImportDialogStyles["case-import-result"])}
                role="status"
              >
                <strong>
                  匹配 {result.matched.length} 个 · 未匹配 {result.unmatched.length} 个
                </strong>
                {visibleUnmatched.length > 0 ? (
                  <ul
                    className={cn(
                      "case-import-unmatched",
                      caseImportDialogStyles["case-import-unmatched"],
                    )}
                  >
                    {visibleUnmatched.map((path) => (
                      <li key={path}>
                        <code title={path}>{path}</code>
                      </li>
                    ))}
                    {hiddenUnmatched > 0 ? <li>等 {result.unmatched.length} 条</li> : null}
                  </ul>
                ) : null}
                <div
                  className={cn(
                    "runner-installer-actions case-import-actions",
                    caseImportDialogStyles["runner-installer-actions"],
                    caseImportDialogStyles["case-import-actions"],
                  )}
                >
                  <Button
                    className={cn("button-primary", uiPatterns["button-primary"])}
                    disabled={result.matched.length === 0}
                    onClick={applySelection}
                    type="button"
                  >
                    勾选匹配用例
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

const caseImportDialogStyles = {
  "case-import-actions": "justify-end",
  "case-import-body": "min-w-0 overflow-x-hidden [&_>_*]:min-w-0",
  "case-import-dialog":
    "w-[min(760px,_calc(100dvw_-_48px))] max-h-[calc(100dvh_-_48px)] [&_.runner-update-titlebar_>_span]:min-w-0 [&_.runner-update-titlebar_small]:min-w-0 [&_.runner-update-titlebar_small]:overflow-hidden [&_.runner-update-titlebar_small]:text-ellipsis [&_.runner-update-titlebar_small]:whitespace-nowrap",
  "case-import-field-label": "text-muted-foreground",
  "case-import-file-name":
    "min-w-0 [flex:1_1_auto] overflow-hidden text-foreground text-ellipsis whitespace-nowrap",
  "case-import-file-status":
    "flex min-w-0 items-center gap-1 [&_>_span:not(.case-import-file-name)]:[flex:0_0_auto] [&_>_span:not(.case-import-file-name)]:whitespace-nowrap",
  "case-import-result":
    "grid min-w-0 gap-3 border border-solid border-border rounded-lg p-3.5 bg-muted",
  "case-import-source": "min-w-0",
  "case-import-unmatched":
    "grid min-w-0 gap-1 m-0 pl-4.5 text-muted-foreground text-xs [&_code]:block [&_code]:min-w-0 [&_code]:max-w-full [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:font-mono [&_>_li]:min-w-0",
  "runner-installer-actions":
    "flex items-center gap-3.5 [&_button]:inline-flex [&_button]:items-center [&_button]:gap-[7px] [&_small]:text-muted-foreground",
  "runner-update-body": "grid gap-4 p-4.5 overflow-y-auto",
  "runner-update-dialog":
    "grid w-[min(640px,_92vw)] max-h-[86vh] [grid-template-rows:auto_minmax(0,_1fr)] overflow-hidden border border-solid border-border rounded-xl bg-card shadow-lg",
  "runner-update-grid":
    "grid grid-cols-2 gap-3.5 [&_.checkbox-row]:flex [&_.checkbox-row]:flex-row [&_.checkbox-row]:items-center [&_.checkbox-row]:self-end [&_.checkbox-row_input]:w-auto [&_label]:grid [&_label]:gap-[7px] [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold",
  "runner-update-hint": "m-0 text-muted-foreground leading-[1.65]",

  "runner-update-titlebar":
    "flex items-center justify-between gap-3 py-3.5 px-4.5 border-b border-solid border-border [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-2.5 [&_small]:text-muted-foreground",
} as const;
