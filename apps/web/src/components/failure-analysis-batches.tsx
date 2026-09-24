"use client";

import { Alert, Tag } from "antd";
import type { FailureAnalysisBatch, FailureAnalysisBatchPage } from "@autoforge/contracts";
import { Archive, ArrowRight, BarChart3, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { Tabs } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/link-button";
import { Progress } from "@/components/ui/progress";
import { ActionDialog } from "@/components/action-dialog";
import { FailureAnalysisExportButton } from "@/components/failure-analysis-export-button";
import { useToast } from "@/components/ui-feedback";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import { analysisPageStyles as pageStyles } from "./failure-analysis-batches.styles";

export function FailureAnalysisBatches({
  batchPage,
  view,
  projectId,
  projectVersionId,
  canOrganize,
  canReadStatistics,
  loading,
}: {
  batchPage: FailureAnalysisBatchPage;
  view: "started" | "archived";
  projectId: string;
  projectVersionId: string;
  canOrganize: boolean;
  canReadStatistics: boolean;
  loading: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [selectedBatch, setSelectedBatch] = useState<FailureAnalysisBatch>();
  const [removedActivations, setRemovedActivations] = useState<Map<string, string | undefined>>(
    () => new Map(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // A closed execution can be explicitly started again before its old snapshot is refreshed.
  const visibleBatches = batchPage.items.filter(
    (batch) =>
      !removedActivations.has(batch.id) || removedActivations.get(batch.id) !== batch.startedAt,
  );
  const archiving = Boolean(selectedBatch?.progressStartedAt);

  async function confirmChange() {
    if (!selectedBatch || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/v1/failure-analysis/batches", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          projectVersionId,
          batchId: selectedBatch.id,
          action: archiving ? "archive" : "close",
        }),
      });
      const message = await readApiErrorMessage(response, "操作失败，请稍后重试。");
      if (message) throw new Error(message);
      setRemovedActivations((current) =>
        new Map(current).set(selectedBatch.id, selectedBatch.startedAt),
      );
      setSelectedBatch(undefined);
      toast.success(
        archiving ? "分析任务已归档，可在“已归档”中查看。" : "分析任务已关闭，原执行记录保持不变。",
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请稍后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Tabs
        label="分析任务状态"
        value={view}
        items={[
          { key: "started", label: "分析任务" },
          { key: "archived", label: "已归档" },
        ]}
        onChange={(value) => router.push(`/case-analysis?view=${value}`, { scroll: false })}
      />
      {loading ? (
        <Alert
          type="info"
          showIcon
          title="正在准备分析任务快照"
          description="后台准备完成后会自动显示，无需反复刷新。"
        />
      ) : (
        <>
          {visibleBatches.length === 0 ? (
            <Card
              as="section"
              className={cn(
                "content-card failure-analysis-empty",
                uiPatterns["content-card"],
                pageStyles["failure-analysis-empty"],
              )}
            >
              <CheckCircle2 size={26} />
              <strong>
                {view === "archived" ? "当前版本暂无归档任务" : "当前版本尚未创建分析任务"}
              </strong>
              <span>
                {view === "archived"
                  ? "已有分析进展的任务归档后会保留在这里，方便后续查阅。"
                  : "点击“新建分析任务”选择最近执行，也可从执行历史或执行详情开始分析。"}
              </span>
            </Card>
          ) : (
            <section
              className={cn(
                "failure-analysis-batch-grid",
                pageStyles["failure-analysis-batch-grid"],
              )}
              aria-label={view === "archived" ? "已归档分析任务" : "可分析任务"}
            >
              {visibleBatches.map((batch) => (
                <Card
                  as="article"
                  className={cn(
                    "content-card failure-analysis-batch-card",
                    uiPatterns["content-card"],
                    pageStyles["failure-analysis-batch-card"],
                  )}
                  key={batch.id}
                >
                  <div
                    className={cn(
                      "failure-analysis-batch-heading",
                      pageStyles["failure-analysis-batch-heading"],
                    )}
                  >
                    <span className={cn("eyebrow", uiPatterns["eyebrow"])}>
                      任务 #{batch.sequenceNumber}
                    </span>
                    <Tag
                      color={
                        batch.archivedAt
                          ? "default"
                          : batch.completedRuns === batch.failedRuns
                            ? "success"
                            : "processing"
                      }
                      className="m-0"
                    >
                      {batch.archivedAt
                        ? "已归档"
                        : batch.completedRuns === batch.failedRuns
                          ? "分析完成"
                          : "分析中"}
                    </Tag>
                  </div>
                  <h2>{batch.suiteName}</h2>
                  <p>
                    <Clock3 size={14} /> {formatPlatformDateTime(batch.createdAt)}
                  </p>
                  {batch.archivedAt ? (
                    <p>归档于 {formatPlatformDateTime(batch.archivedAt)}</p>
                  ) : null}
                  <dl>
                    <div className={"round-metric"}>
                      <dt>最终轮次</dt>
                      <dd>第 {batch.currentRound} 轮</dd>
                    </div>
                    <div className={"failure-metric"}>
                      <dt>最终失败</dt>
                      <dd>{batch.failedRuns}</dd>
                    </div>
                    <div className={"claimed-metric"}>
                      <dt>已认领</dt>
                      <dd>{batch.claimedRuns}</dd>
                    </div>
                    <div className={"completed-metric"}>
                      <dt>已完成分析</dt>
                      <dd>{batch.completedRuns}</dd>
                    </div>
                  </dl>
                  <div
                    className={cn(
                      "failure-analysis-batch-progress",
                      pageStyles["failure-analysis-batch-progress"],
                    )}
                  >
                    <span>
                      分析进度
                      <strong>
                        {batch.completedRuns} / {batch.failedRuns}
                      </strong>
                    </span>
                    <Progress
                      aria-label={`任务 ${batch.suiteName} 分析进度`}
                      max={Math.max(1, batch.failedRuns)}
                      value={batch.completedRuns}
                    />
                  </div>
                  <div
                    className={cn(
                      "failure-analysis-batch-actions",
                      pageStyles["failure-analysis-batch-actions"],
                    )}
                  >
                    {canReadStatistics ? (
                      <LinkButton
                        className={"ui-button ui-button-secondary"}
                        href={`/case-analysis/${encodeURIComponent(batch.id)}/statistics`}
                      >
                        <BarChart3 size={15} /> 分析统计
                      </LinkButton>
                    ) : null}
                    <FailureAnalysisExportButton batchId={batch.id} />
                    {canOrganize && !batch.archivedAt ? (
                      <Button
                        size="compact"
                        variant="ghost"
                        onClick={() => {
                          setSelectedBatch(batch);
                          setError("");
                        }}
                      >
                        {batch.progressStartedAt ? <Archive size={15} /> : <XCircle size={15} />}
                        {batch.progressStartedAt ? "归档分析任务" : "关闭分析任务"}
                      </Button>
                    ) : null}
                    <LinkButton
                      aria-label="查看用例分析详情"
                      className={"ui-button ui-button-secondary failure-analysis-batch-link"}
                      href={`/case-analysis/${encodeURIComponent(batch.id)}`}
                    >
                      {batch.archivedAt ? "查看归档详情" : "进入分析工作台"}{" "}
                      <ArrowRight size={15} />
                    </LinkButton>
                  </div>
                </Card>
              ))}
            </section>
          )}

          {visibleBatches.length > 0 ? (
            <nav
              className={cn(
                "failure-analysis-pagination",
                pageStyles["failure-analysis-pagination"],
              )}
              aria-label="用例分析任务分页"
            >
              <span>本页 {visibleBatches.length} 个任务</span>
              {batchPage.nextCursor ? (
                <LinkButton
                  className={"ui-button ui-button-secondary"}
                  href={`/case-analysis?view=${view}&cursor=${encodeURIComponent(batchPage.nextCursor)}`}
                >
                  查看更早任务 <ArrowRight size={15} />
                </LinkButton>
              ) : null}
            </nav>
          ) : null}
        </>
      )}
      <ActionDialog
        open={Boolean(selectedBatch)}
        title={archiving ? "归档分析任务" : "关闭分析任务"}
        onClose={() => setSelectedBatch(undefined)}
        closeDisabled={pending}
        footer={
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={() => setSelectedBatch(undefined)}>
              取消
            </Button>
            <Button
              disabled={pending}
              variant={archiving ? "primary" : "danger"}
              onClick={() => void confirmChange()}
            >
              {pending ? "处理中…" : archiving ? "确认归档" : "确认关闭"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <strong className="block [overflow-wrap:anywhere]">{selectedBatch?.suiteName}</strong>
            <span className="text-xs text-muted-foreground">
              执行 #{selectedBatch?.sequenceNumber} · 已认领 {selectedBatch?.claimedRuns} 个 ·
              已完成分析 {selectedBatch?.completedRuns} 个
            </span>
          </div>
          <Alert
            showIcon
            type={archiving ? "info" : "warning"}
            title={archiving ? "保留分析记录，移入归档区" : "仅关闭没有分析进展的任务"}
            description={
              archiving
                ? "已有结论、证明材料和认领信息会完整保留。归档后仅可查看和导出，其他人已打开的页面也不能再修改。"
                : "关闭后会从分析任务列表移除，并清除尚未开始分析的认领。原执行记录和日志保留，之后仍可重新开始分析。若已有用例保存分析进展，系统会阻止关闭。"
            }
          />
          {error ? <Alert type="error" showIcon title={error} /> : null}
        </div>
      </ActionDialog>
    </>
  );
}
