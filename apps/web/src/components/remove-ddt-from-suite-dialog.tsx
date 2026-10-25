"use client";

import { Select, Space, Table, Tag } from "antd";
import { ListMinus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { caseSuiteDdtSelectionSchema, type CaseSuiteDdtSelection } from "@autoforge/contracts";
import type { DdtScope } from "@autoforge/domain";
import { clearBrowserSnapshots } from "@/lib/browser-read-cache";
import { readApiError } from "@/lib/client-api";
import { collectSuiteDdtRemovalSelection } from "@/lib/suite-ddt-removal-selection";
import { ActionDialog } from "./action-dialog";
import { OperationProgress } from "./ui";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";

type SuiteChoice = { id: string; name: string };

export function RemoveDdtFromSuiteDialog({
  caseIds,
  scope,
  suites,
  initialSuiteId,
  onClose,
  onComplete,
}: {
  caseIds: string[];
  scope: DdtScope;
  suites: SuiteChoice[];
  initialSuiteId?: string | undefined;
  onClose(): void;
  onComplete(suiteName: string, matchedCount: number, skippedCount: number): void;
}) {
  const [suiteId, setSuiteId] = useState(
    suites.some((suite) => suite.id === initialSuiteId) ? initialSuiteId! : suites[0]?.id,
  );
  const [preview, setPreview] = useState<CaseSuiteDdtSelection>();
  const [working, setWorking] = useState<"preview" | "remove">();
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const target = suites.find((suite) => suite.id === (suiteId ?? suites[0]?.id));

  async function matchMembers() {
    if (!target || working) return;
    const controller = new AbortController();
    setSuiteId(target.id);
    request.current = controller;
    setWorking("preview");
    setPreview(undefined);
    setCompleted(0);
    setError("");
    try {
      const result = await collectSuiteDdtRemovalSelection(
        caseIds,
        async (ids, signal) => {
          const response = await fetch(
            `/api/v1/case-suites/${encodeURIComponent(target.id)}/ddt-cases/matching`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                projectVersionId: scope.projectVersionId,
                testStageId: scope.testStageId,
                caseIds: ids,
              }),
              signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            },
          );
          const failure = await readApiError(response, "匹配任务成员失败，请重试。");
          if (failure) throw failure;
          return caseSuiteDdtSelectionSchema.parse(await response.json());
        },
        controller.signal,
        (completed) => setCompleted(completed),
      );
      if (!controller.signal.aborted) setPreview(result);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : "匹配任务成员失败，请重试。");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setWorking(undefined);
      }
    }
  }

  async function removeMembers() {
    if (!target || !preview?.items.length || working) return;
    setWorking("remove");
    setError("");
    try {
      // One existing transaction creates one task snapshot, with bounded SQL batches inside it.
      const response = await fetch(
        `/api/v1/case-suites/${encodeURIComponent(target.id)}/ddt-cases`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ddtCaseIds: preview.items.map((item) => item.id) }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      const failure = await readApiError(response, "移除任务成员失败，请重试。");
      if (failure) throw failure;
      clearBrowserSnapshots();
      onComplete(target.name, preview.items.length, preview.unmatchedCaseIds.length);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.name === "TimeoutError"
          ? "移除请求超时，任务可能已更新；可重试，相同用例不会重复移除。"
          : failure instanceof Error
            ? failure.message
            : "移除任务成员失败，请重试。",
      );
    } finally {
      setWorking(undefined);
    }
  }

  const samples = preview
    ? [
        ...preview.items
          .slice(0, 8)
          .map((item) => ({ key: item.id, caseId: item.caseId, matched: true })),
        ...preview.unmatchedCaseIds
          .slice(0, 8)
          .map((caseId) => ({ key: `skip:${caseId}`, caseId, matched: false })),
      ]
    : [];

  return (
    <ActionDialog
      open
      title={`从任务移除 ${caseIds.length} 条 DDT 用例`}
      description="选择目标任务，预览清单与任务成员的交集后确认移除。只移除任务成员关系，用例库和历史执行记录保留。"
      closeDisabled={working === "remove"}
      onClose={() => {
        request.current?.abort();
        onClose();
      }}
      footer={
        <Space wrap>
          <Button
            type="button"
            variant="secondary"
            disabled={working === "remove"}
            onClick={() => {
              request.current?.abort();
              onClose();
            }}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!target || Boolean(working)}
            onClick={() => void matchMembers()}
          >
            {preview ? "重新匹配" : "预览匹配"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!target || !preview?.items.length || Boolean(working)}
            loading={working === "remove"}
            onClick={() => void removeMembers()}
          >
            <ListMinus size={15} /> 确认移除{preview ? ` ${preview.items.length} 条` : ""}
          </Button>
        </Space>
      }
    >
      <div className="grid min-w-0 gap-4">
        <label className="grid min-w-0 gap-2">
          <span>目标用例任务</span>
          <Select
            aria-label="移除用例的目标任务"
            className="w-full min-w-0"
            value={target?.id}
            disabled={Boolean(working)}
            placeholder="当前版本没有可管理的任务"
            showSearch={{ optionFilterProp: "label" }}
            options={suites.map((suite) => ({ value: suite.id, label: suite.name }))}
            onChange={(id) => {
              setSuiteId(id);
              setPreview(undefined);
              setError("");
            }}
          />
        </label>
        {error ? (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        ) : null}
        {working === "preview" ? (
          <OperationProgress
            label="正在匹配任务成员"
            detail={`已检查 ${completed} / ${caseIds.length} 条`}
            value={(completed / caseIds.length) * 100}
          />
        ) : null}
        {preview ? (
          <>
            <Notice tone={preview.items.length ? "warning" : "info"} role="status">
              匹配 {preview.items.length} 条任务成员 · 跳过 {preview.unmatchedCaseIds.length}{" "}
              条不在任务中的用例
            </Notice>
            <Table
              size="small"
              pagination={false}
              rowKey="key"
              dataSource={samples}
              scroll={{ x: 400, y: "min(280px, 30dvh)" }}
              columns={[
                { title: "CaseID", dataIndex: "caseId", ellipsis: true },
                {
                  title: "处理方式",
                  width: 100,
                  render: (_, row) => (
                    <Tag color={row.matched ? "warning" : "default"}>
                      {row.matched ? "待移除" : "跳过"}
                    </Tag>
                  ),
                },
              ]}
            />
            <small className="text-muted-foreground">
              每类最多预览 8 条；确认将处理全部匹配用例，其他阶段的同名用例不受影响。
            </small>
          </>
        ) : (
          <Notice>
            已选 {caseIds.length} 条用例；预览只读取当前版本及测试阶段的任务成员，不修改任务。
          </Notice>
        )}
      </div>
    </ActionDialog>
  );
}
