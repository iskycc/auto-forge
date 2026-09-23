"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useState } from "react";
import { ddtCaseDataSchema } from "@autoforge/contracts";
import { ddtJourneySteps, ddtStepNames, type DdtCaseData, type DdtScope } from "@autoforge/domain";
import { ActionDialog } from "./action-dialog";
import { Button, Select } from "./ui";
import { readApiErrorMessage } from "@/lib/client-api";

const FIELDS_PER_WINDOW = 50;
const VALUE_PREVIEW_CHARACTERS = 8_192;

export function DdtCaseDataDialog({
  caseId,
  scope,
  onClose,
}: {
  caseId: string;
  scope: DdtScope;
  onClose(): void;
}) {
  const [data, setData] = useState<DdtCaseData>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [activeStep, setActiveStep] = useState("");
  const scopeQuery = new URLSearchParams(scope).toString();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `/api/v1/ddt/cases/${encodeURIComponent(caseId)}?${scopeQuery}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          },
        );
        const message = await readApiErrorMessage(response, "无法读取用例数据，请重试。");
        if (message) throw new Error(message);
        const item = (await response.json()) as { data: unknown };
        const parsed = ddtCaseDataSchema.safeParse(item.data);
        if (!parsed.success) throw new Error("用例数据格式异常，请重新加载。");
        if (!controller.signal.aborted) setData(parsed.data);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error && failure.name !== "TimeoutError"
              ? failure.message
              : "读取用例数据超时，请重新加载。",
          );
      }
    }
    void load();
    return () => controller.abort();
  }, [caseId, scopeQuery, reload]);

  const steps = data ? ddtJourneySteps(data) : null;
  const stepNames = data ? ddtStepNames(data) : [];
  const selectedStep = steps?.[activeStep] ? activeStep : (stepNames[0] ?? "");

  return (
    <ActionDialog
      open
      title="DDT 用例数据"
      description="只读查看；关闭后保留搜索结果和查看位置。"
      className={cn("ddt-case-data-dialog", ddtCaseDataDialogStyles["ddt-case-data-dialog"])}
      onClose={onClose}
    >
      {error ? (
        <Notice
          tone="info"
          className={cn("inline-notice error", uiPatterns["inline-notice"], uiPatterns["error"])}
          role="alert"
        >
          <span>{error}</span>
          <Button
            onClick={() => {
              setError("");
              setReload((value) => value + 1);
            }}
          >
            重新加载
          </Button>
        </Notice>
      ) : !data ? (
        <p role="status">正在读取用例数据…</p>
      ) : (
        <>
          {steps ? (
            <label
              className={cn("ddt-case-data-step", ddtCaseDataDialogStyles["ddt-case-data-step"])}
            >
              <span>用户旅程步骤</span>
              <Select
                aria-label="用户旅程步骤"
                value={selectedStep}
                onChange={(event) => setActiveStep(event.target.value)}
              >
                {stepNames.map((step) => (
                  <option key={step} value={step}>
                    {step}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <CaseDataFields key={selectedStep} fields={steps?.[selectedStep] ?? data} />
        </>
      )}
    </ActionDialog>
  );
}

function CaseDataFields({ fields }: { fields: DdtCaseData }) {
  const [visibleCount, setVisibleCount] = useState(FIELDS_PER_WINDOW);
  const entries = Object.entries(fields);
  if (!entries.length)
    return (
      <EmptyState className={cn("empty-state", uiPatterns["empty-state"])}>
        此用例暂无字段数据。
      </EmptyState>
    );
  return (
    <>
      <dl className={cn("ddt-case-data-fields", ddtCaseDataDialogStyles["ddt-case-data-fields"])}>
        {entries.slice(0, visibleCount).map(([field, value]) => (
          <div key={field}>
            <dt>{field}</dt>
            <dd>
              <CaseDataValue value={value} />
            </dd>
          </div>
        ))}
      </dl>
      {entries.length > visibleCount ? (
        <Button onClick={() => setVisibleCount((count) => count + FIELDS_PER_WINDOW)}>
          显示更多字段（已显示 {visibleCount} / {entries.length}）
        </Button>
      ) : null}
    </>
  );
}

function CaseDataValue({ value }: { value: DdtCaseData[string] }) {
  const [visibleLength, setVisibleLength] = useState(VALUE_PREVIEW_CHARACTERS);
  const text =
    value === null
      ? "空值"
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
  return (
    <>
      <pre tabIndex={0}>{text === "" ? "空字符串" : text.slice(0, visibleLength)}</pre>
      {text.length > visibleLength ? (
        <Button
          size="compact"
          onClick={() => setVisibleLength((length) => length + VALUE_PREVIEW_CHARACTERS)}
        >
          显示更多内容（已显示 {visibleLength} / {text.length} 字符）
        </Button>
      ) : null}
    </>
  );
}

const ddtCaseDataDialogStyles = {
  "ddt-case-data-dialog":
    "[&_.action-dialog-body]:grid [&_.action-dialog-body]:min-w-0 [&_.action-dialog-body]:gap-3 [&_.action-dialog-body]:[overscroll-behavior:contain]",
  "ddt-case-data-fields":
    "min-w-0 m-0 [&_>_div]:grid [&_>_div]:grid-cols-[minmax(0,_1fr)_minmax(0,_3fr)] [&_>_div]:gap-3 [&_>_div]:py-2 [&_>_div]:border-b [&_>_div]:border-solid [&_>_div]:border-border [&_:is(dt,_dd,_pre)]:min-w-0 [&_:is(dt,_dd,_pre)]:m-0 [&_:is(dt,_dd,_pre)]:[overflow-wrap:anywhere] [&_:is(dt,_dd,_pre)]:whitespace-pre-wrap [&_dt]:text-muted-foreground [&_pre]:max-h-[360px] [&_pre]:overflow-auto [&_pre]:[font:inherit] [&_pre]:[overscroll-behavior:contain]",
  "ddt-case-data-step": "flex items-center gap-3 [&_>_span:first-child]:shrink-0",
} as const;
