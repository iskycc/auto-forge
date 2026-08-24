"use client";

import type { CaseDefinitionWithMethods } from "@autoforge/domain";
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
  cases: CaseDefinitionWithMethods[];
  onImport(matched: CaseDefinitionWithMethods[], unmatchedCount: number): void;
};

export function CaseImportDialog({ cases, onImport }: CaseImportDialogProps) {
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
  const [result, setResult] = useState<CasePathMatchResult | null>(null);
  const fileReadGeneration = useRef(0);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  function closeDialog() {
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

  function parseAndPreview(): void {
    // 两种输入都存在时以文件为准，避免过期粘贴内容覆盖用户刚选的文件。
    const paths = filePaths?.length ? filePaths : parseCasePathColumn(pastedText);
    setResult(matchCasePaths(cases, paths));
  }

  function applySelection(): void {
    if (!result || result.matched.length === 0) return;
    onImport(result.matched, result.unmatched.length);
    closeDialog();
  }

  const canParse = !readingFile && Boolean(filePaths?.length || pastedText.trim());
  const visibleUnmatched = result ? result.unmatched.slice(0, MAX_UNMATCHED_PREVIEW) : [];
  const hiddenUnmatched = result ? result.unmatched.length - visibleUnmatched.length : 0;

  return (
    <>
      <Button className="button button-secondary" onClick={() => setOpen(true)} type="button">
        <Table2 size={15} /> 导入用例
      </Button>
      {open ? (
        <div className="runner-update-overlay" role="presentation" onMouseDown={closeDialog}>
          <section
            aria-label="导入用例"
            aria-modal="true"
            className="runner-update-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="runner-update-titlebar">
              <span>
                <Table2 size={16} aria-hidden="true" />
                <strong>导入用例</strong>
                <small>按“用例路径”列批量勾选</small>
              </span>
              <Button aria-label="关闭" onClick={closeDialog} type="button">
                <X size={16} />
              </Button>
            </header>
            <div className="runner-update-body">
              <p className="runner-update-hint">
                上传表格文件（.xlsx / .csv / .tsv / .txt），XLSX 读取首个工作表的第一列；也可从
                Excel 复制“用例路径”列直接粘贴。第一行可以是表头。路径支持目录写法
                com/example/CheckoutTest 和类名写法
                com.example.CheckoutTest，与用例库精确匹配后批量勾选。
              </p>
              <div className="runner-update-grid">
                <label>
                  表格文件
                  <FileInput
                    accept=".xlsx,.csv,.tsv,.txt"
                    aria-label="选择用例表格文件"
                    onChange={(event) => void readFile(event.currentTarget)}
                  />
                  {readingFile ? <small role="status">正在读取 {fileName}…</small> : null}
                  {!readingFile && filePaths?.length ? (
                    <small role="status">
                      已读取 {fileName}，共 {filePaths.length} 条路径
                    </small>
                  ) : null}
                  {fileError ? (
                    <small className="auth-error" role="alert">
                      {fileError}
                    </small>
                  ) : null}
                </label>
                <label>
                  或直接粘贴
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
              <div className="runner-installer-actions">
                <Button
                  className="button-primary"
                  disabled={!canParse}
                  onClick={parseAndPreview}
                  type="button"
                >
                  解析并预览
                </Button>
              </div>

              {result ? (
                <div className="case-import-result" role="status">
                  <strong>
                    匹配 {result.matched.length} 个 · 未匹配 {result.unmatched.length} 个
                  </strong>
                  {visibleUnmatched.length > 0 ? (
                    <ul className="case-import-unmatched">
                      {visibleUnmatched.map((path) => (
                        <li key={path}>
                          <code>{path}</code>
                        </li>
                      ))}
                      {hiddenUnmatched > 0 ? <li>等 {result.unmatched.length} 条</li> : null}
                    </ul>
                  ) : null}
                  <div className="runner-installer-actions">
                    <Button
                      className="button-primary"
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
          </section>
        </div>
      ) : null}
    </>
  );
}
