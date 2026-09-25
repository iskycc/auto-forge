"use client";
import { Segmented } from "./ui/segmented";
import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useRef, useState } from "react";
import type { DdtScope } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button, FileInput, OperationProgress, Textarea } from "./ui";
import { readApiError } from "@/lib/client-api";
import { readCaseListFileColumn } from "@/lib/case-list-file";
import {
  matchDdtCaseIds,
  parseDdtCaseIdCells,
  parseDdtCaseIdColumn,
  type DdtCaseSelectionResult,
} from "@/lib/ddt-case-selection";

const PREVIEW_COUNT = 10;

export function DdtCaseSelectionDialog({
  scope,
  onClose,
  onSelect,
}: {
  scope: DdtScope;
  onClose(): void;
  onSelect(caseIds: string[]): Promise<boolean>;
}) {
  const [source, setSource] = useState<"text" | "file">("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<DdtCaseSelectionResult>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<{ label: string; percent: number }>();
  const request = useRef<AbortController | null>(null);
  const scopeQuery = new URLSearchParams(scope).toString();
  useEffect(() => () => request.current?.abort(), [scopeQuery]);

  function invalidatePreview() {
    setResult(undefined);
    setError("");
  }

  async function preview() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setWorking(true);
    invalidatePreview();
    setProgress({ label: "正在解析 CaseID 清单", percent: 0 });
    try {
      const caseIds =
        source === "file" && file
          ? parseDdtCaseIdCells(await readCaseListFileColumn(file))
          : parseDdtCaseIdColumn(text);
      controller.signal.throwIfAborted();
      if (!caseIds.length) throw new Error("清单中没有 CaseID，请检查首列或粘贴内容。");
      setProgress({ label: `正在匹配 0 / ${caseIds.length} 条 CaseID`, percent: 0 });
      const selection = await matchDdtCaseIds(
        caseIds,
        async (ids, signal) => {
          const response = await fetch(`/api/v1/ddt/cases/search?${scopeQuery}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ caseIds: ids, limit: 200 }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          });
          const failure = await readApiError(response, "匹配用例失败，请重试。");
          if (failure) throw failure;
          const page = (await response.json()) as { items: Array<{ caseId: string }> };
          return page.items.map((item) => item.caseId);
        },
        controller.signal,
        (completed, total) => {
          setProgress({
            label: `正在匹配 ${completed} / ${total} 条 CaseID`,
            percent: (completed / total) * 100,
          });
        },
      );
      if (!controller.signal.aborted) setResult(selection);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error && failure.name !== "TimeoutError"
            ? failure.message
            : "匹配用例超时，请重试。",
        );
    } finally {
      if (!controller.signal.aborted) {
        setWorking(false);
        setProgress(undefined);
      }
    }
  }

  async function applySelection() {
    if (!result) return;
    try {
      if (await onSelect(result.matched)) onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法应用选择，请重试。");
    }
  }

  return (
    <ActionDialog
      open
      title="按清单选择 DDT 用例"
      description="按 CaseID 精确匹配当前项目、版本、阶段的全部已有用例，不限于左侧已加载或筛选的列表。"
      className={cn(
        "ddt-case-selection-dialog",
        ddtCaseSelectionDialogStyles["ddt-case-selection-dialog"],
      )}
      onClose={() => {
        request.current?.abort();
        onClose();
      }}
    >
      <Segmented
        label="清单输入方式"
        value={source}
        options={[
          { value: "text", label: "粘贴文本", disabled: working },
          { value: "file", label: "上传表格", disabled: working },
        ]}
        onChange={(value) => {
          setSource(value);
          invalidatePreview();
        }}
      />
      <label
        className={cn("case-import-source", ddtCaseSelectionDialogStyles["case-import-source"])}
        hidden={source !== "text"}
      >
        <span>CaseID 清单</span>
        <Textarea
          aria-label="粘贴 DDT CaseID"
          rows={5}
          value={text}
          disabled={working}
          placeholder={"每行一个 CaseID，也可直接粘贴 Excel 首列\nCaseID\nPAY-001\nPAY-002"}
          onChange={(event) => {
            setText(event.target.value);
            invalidatePreview();
          }}
        />
      </label>
      <label
        className={cn("case-import-source", ddtCaseSelectionDialogStyles["case-import-source"])}
        hidden={source !== "file"}
      >
        <span>用例清单文件</span>
        <FileInput
          aria-label="选择 DDT 用例清单文件"
          accept=".xlsx,.csv,.tsv,.txt"
          disabled={working}
          onChange={(event) => {
            const chosen = event.target.files?.item(0);
            if (chosen) {
              setFile(chosen);
              invalidatePreview();
            }
          }}
        />
      </label>
      <p className={cn("muted", uiPatterns["muted"])}>
        支持 XLSX、CSV、TSV、TXT，读取首个工作表的第一列，表头可为 CaseID、用例ID
        或用例编号。忽略大小写与首尾空格，重复项自动合并；不会新建或覆盖用例数据。
      </p>
      <div
        className={cn(
          "ddt-case-selection-actions",
          ddtCaseSelectionDialogStyles["ddt-case-selection-actions"],
        )}
      >
        <Button
          variant="primary"
          disabled={working || (source === "file" ? !file : !text.trim())}
          onClick={() => void preview()}
        >
          解析并预览
        </Button>
      </div>
      {progress ? (
        <OperationProgress
          label={progress.label}
          value={progress.percent}
          detail="完成后可确认勾选，取消不会改变原有选择。"
        />
      ) : null}
      {error ? (
        <Notice
          tone="error"
          className={cn("inline-notice error", uiPatterns["inline-notice"], uiPatterns["error"])}
          role="alert"
        >
          {error}
        </Notice>
      ) : null}
      {result ? (
        <section
          className={cn("case-import-result", ddtCaseSelectionDialogStyles["case-import-result"])}
          aria-label="清单匹配结果"
        >
          <strong role="status">
            匹配 {result.matched.length} 个 · 未匹配 {result.unmatched.length} 个
          </strong>
          <div
            className={cn(
              "ddt-case-selection-preview",
              ddtCaseSelectionDialogStyles["ddt-case-selection-preview"],
            )}
          >
            <CaseIdPreview title="已匹配" caseIds={result.matched} />
            <CaseIdPreview title="未匹配" caseIds={result.unmatched} />
          </div>
          <small className={cn("muted", uiPatterns["muted"])}>
            确认后将合并到当前勾选，可通过“加入用例任务”加入已有任务或创建新任务。未匹配项不会加入。
          </small>
        </section>
      ) : null}
      <footer
        className={cn(
          "ddt-case-selection-actions",
          ddtCaseSelectionDialogStyles["ddt-case-selection-actions"],
        )}
      >
        <Button
          onClick={() => {
            request.current?.abort();
            onClose();
          }}
        >
          {working ? "取消匹配" : "取消"}
        </Button>
        <Button
          variant="primary"
          disabled={working || !result?.matched.length}
          onClick={() => void applySelection()}
        >
          勾选匹配用例
        </Button>
      </footer>
    </ActionDialog>
  );
}

function CaseIdPreview({ title, caseIds }: { title: string; caseIds: string[] }) {
  return (
    <div>
      <strong>{title}</strong>
      {caseIds.length ? (
        <ul
          className={cn(
            "case-import-unmatched",
            ddtCaseSelectionDialogStyles["case-import-unmatched"],
          )}
        >
          {caseIds.slice(0, PREVIEW_COUNT).map((caseId) => (
            <li key={caseId}>
              <code title={caseId}>{caseId}</code>
            </li>
          ))}
        </ul>
      ) : (
        <small className={cn("muted", uiPatterns["muted"])}>无</small>
      )}
      {caseIds.length > PREVIEW_COUNT ? (
        <small className={cn("muted", uiPatterns["muted"])}>
          另有 {caseIds.length - PREVIEW_COUNT} 个，仅预览前 {PREVIEW_COUNT} 个
        </small>
      ) : null}
    </div>
  );
}

const ddtCaseSelectionDialogStyles = {
  "case-import-result":
    "grid min-w-0 gap-3 border border-solid border-border rounded-lg p-3.5 bg-muted",
  "case-import-source": "min-w-0",
  "case-import-unmatched":
    "grid min-w-0 gap-1 m-0 pl-4.5 text-muted-foreground text-xs [&_code]:block [&_code]:min-w-0 [&_code]:max-w-full [&_code]:overflow-hidden [&_code]:text-ellipsis [&_code]:whitespace-nowrap [&_code]:font-mono [&_>_li]:min-w-0",
  "ddt-case-selection-actions": "flex flex-wrap gap-2 justify-end",
  "ddt-case-selection-dialog":
    "[&_.action-dialog-body]:grid [&_.action-dialog-body]:gap-3 [&_.action-dialog-body]:min-w-0 [&_.case-import-source]:grid [&_.case-import-source]:min-w-0 [&_.case-import-source]:gap-2 [&_.case-import-source[hidden]]:hidden [&_p]:[overflow-wrap:anywhere] [&_small]:[overflow-wrap:anywhere]",
  "ddt-case-selection-preview":
    "[&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:gap-2 grid grid-cols-2 items-start gap-4",
} as const;
