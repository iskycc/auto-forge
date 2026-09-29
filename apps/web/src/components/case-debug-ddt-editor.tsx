"use client";
import { useEffect, useState } from "react";
import { Alert, Spin, Typography } from "antd";
import type { DdtCase, DdtScope } from "@autoforge/domain";
import { ddtCaseDataSchema } from "@autoforge/contracts";
import { ActionDialog } from "./action-dialog";
import { Button, Textarea } from "./ui";
import { debugRequest } from "@/lib/case-debug-client";
import { useToast } from "./ui-feedback";

export function CaseDebugDdtEditor({
  scope,
  caseId,
  onClose,
}: {
  scope: DdtScope;
  caseId: string;
  onClose(): void;
}) {
  const [item, setItem] = useState<DdtCase>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const url = `/api/v1/case-debug/ddt/cases/${encodeURIComponent(caseId)}?${new URLSearchParams(scope)}`;
  useEffect(() => {
    const controller = new AbortController();
    void debugRequest<DdtCase>(url, { signal: controller.signal })
      .then((next) => {
        setItem(next);
        setDraft(JSON.stringify(next.data, null, 2));
      })
      .catch((problem: unknown) => {
        if (!controller.signal.aborted)
          setError(problem instanceof Error ? problem.message : "读取失败。");
      });
    return () => controller.abort();
  }, [url]);
  async function save() {
    if (!item) return;
    setBusy(true);
    setError("");
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft);
      } catch {
        throw new Error("JSON 格式不正确，请检查引号、逗号和括号。");
      }
      const validated = ddtCaseDataSchema.safeParse(parsed);
      if (!validated.success)
        throw new Error("用例数据必须为字段对象，值支持文本、数字、布尔值或用户旅程步骤。");
      await debugRequest(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: validated.data, revision: item.revision }),
      });
      toast.success("已保存个人调试数据。");
      onClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "保存失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open
      title="编辑个人调试数据"
      description={caseId}
      protectUnsavedChanges
      onClose={onClose}
      closeDisabled={busy}
      className="w-[min(800px,calc(100vw-3rem))]"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={!item} loading={busy} onClick={() => void save()}>
            保存个人数据
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-3">
        <Typography.Text type="secondary">
          修改本人的账号、输入等字段，不影响正式用例和其他用户。CaseId 保持不变。
        </Typography.Text>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {!item && !error ? <Spin /> : null}
        {item ? (
          <Textarea
            aria-label="个人 DDT JSON 数据"
            rows={16}
            className="font-mono text-xs"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : null}
      </div>
    </ActionDialog>
  );
}
