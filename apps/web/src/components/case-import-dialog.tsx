"use client";

import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { Table2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, FileInput, Textarea } from "@/components/ui";
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
  const [fileContent, setFileContent] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [result, setResult] = useState<CasePathMatchResult | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  function closeDialog() {
    setOpen(false);
    setFileContent("");
    setPastedText("");
    setResult(null);
  }

  async function readFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.item(0);
    setResult(null);
    // 用户取消系统文件选择框时 files 为空，保留已读内容避免误清空。
    if (!file) return;
    setFileContent(await file.text());
  }

  function parseAndPreview(): void {
    // 两种输入都存在时以文件为准，避免过期粘贴内容覆盖用户刚选的文件。
    const source = fileContent.trim() ? fileContent : pastedText;
    setResult(matchCasePaths(cases, parseCasePathColumn(source)));
  }

  function applySelection(): void {
    if (!result || result.matched.length === 0) return;
    onImport(result.matched, result.unmatched.length);
    closeDialog();
  }

  const canParse = Boolean(fileContent.trim() || pastedText.trim());
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
                上传只含一列“用例路径”的表格文件（.csv / .tsv / .txt），或从 Excel
                复制该列直接粘贴；每行一个用例路径，可含表头。路径支持目录写法
                com/example/CheckoutTest 和类名写法 com.example.CheckoutTest，
                与用例库精确匹配后批量勾选。
              </p>
              <div className="runner-update-grid">
                <label>
                  表格文件
                  <FileInput
                    accept=".csv,.tsv,.txt"
                    aria-label="选择用例表格文件"
                    onChange={(event) => void readFile(event.currentTarget)}
                  />
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
