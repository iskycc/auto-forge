"use client";
import { EvidenceImagePreview } from "./ui/evidence-image-preview";
import { Badge } from "@/components/ui/badge";

import { LoadingIcon } from "@/components/ui/loading-icon";

import { EmptyState } from "@/components/ui/empty-state";

import { Notice } from "@/components/ui/notice";

import { Disclosure } from "@/components/ui/disclosure";

import { Card } from "@/components/ui/card";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type {
  FailureAnalysisHistoryItemView,
  FailureAnalysisHistoryPageView,
} from "@autoforge/contracts";
import { ClipboardCheck, ExternalLink, ImageIcon, Maximize2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui";
import { readApiErrorMessage } from "@/lib/client-api";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

const CATEGORY_LABELS = {
  rerun_passed: "重跑通过",
  case_fixed: "用例问题已修改",
  code_issue_filed: "代码问题已提单",
} as const;

export function CaseFailureAnalysisHistory({
  caseDefinitionId,
  projectId,
  initialPage,
  canReadEvidence,
  timeZone,
  compact = false,
  historyUrl,
}: {
  caseDefinitionId: string;
  projectId: string;
  initialPage: FailureAnalysisHistoryPageView;
  canReadEvidence: boolean;
  timeZone: string;
  compact?: boolean;
  historyUrl?: string;
}) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<FailureAnalysisHistoryItemView>();

  async function loadMore(): Promise<void> {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError("");
    try {
      const url = new URL(
        historyUrl ??
          `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/failure-analyses`,
        window.location.origin,
      );
      url.searchParams.set("cursor", nextCursor);
      url.searchParams.set("limit", "20");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error((await readApiErrorMessage(response, "读取失败分析历史失败。"))!);
      }
      const page = (await response.json()) as FailureAnalysisHistoryPageView;
      setItems((current) => {
        const knownIds = new Set(current.map((item) => item.claim.id));
        return [...current, ...page.items.filter((item) => !knownIds.has(item.claim.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取失败分析历史失败。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Card
        as="section"
        className={cn(
          uiPatterns["card"],
          caseFailureAnalysisHistoryStyles["case-analysis-history"],
          `card case-analysis-history${compact ? " compact" : ""}`,
        )}
      >
        <div className={cn("card-heading", uiPatterns["card-heading"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Failure analysis history</span>
            <h2>失败分析结论（{nextCursor ? `已加载 ${items.length}` : items.length}）</h2>
            <p>按分析完成时间倒序展示，结论与当前用例永久关联。</p>
          </div>
          <ClipboardCheck size={22} aria-hidden="true" />
        </div>

        {items.length === 0 ? (
          <EmptyState
            className={cn(
              "case-analysis-history-empty",
              caseFailureAnalysisHistoryStyles["case-analysis-history-empty"],
            )}
          >
            当前用例尚无已完成的失败分析结论。
          </EmptyState>
        ) : (
          <div
            className={cn(
              "case-analysis-history-list",
              caseFailureAnalysisHistoryStyles["case-analysis-history-list"],
            )}
          >
            {items.map((item, index) => (
              <AnalysisHistoryItem
                canReadEvidence={canReadEvidence}
                item={item}
                key={item.claim.id}
                onPreview={() => setPreview(item)}
                open={!compact && index === 0}
                timeZone={timeZone}
              />
            ))}
          </div>
        )}

        {error ? (
          <Notice tone="error" className={cn("form-error", uiPatterns["form-error"])}>
            {error}
          </Notice>
        ) : null}
        {nextCursor ? (
          <div
            className={cn(
              "case-analysis-history-more",
              caseFailureAnalysisHistoryStyles["case-analysis-history-more"],
            )}
          >
            <Button
              disabled={loading}
              onClick={() => void loadMore()}
              type="button"
              variant="secondary"
            >
              {loading ? <LoadingIcon size={15} /> : null}
              {loading ? "正在加载…" : "加载更早的分析结论"}
            </Button>
          </div>
        ) : null}
      </Card>

      {preview?.claim.screenshot ? (
        <EvidenceImagePreview
          image={{
            src: evidenceUrl(preview, projectId),
            alt: `分析证明截图：${preview.claim.screenshot.fileName}`,
            fileName: preview.claim.screenshot.fileName,
          }}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </>
  );
}

function AnalysisHistoryItem({
  item,
  timeZone,
  canReadEvidence,
  open,
  onPreview,
}: {
  item: FailureAnalysisHistoryItemView;
  timeZone: string;
  canReadEvidence: boolean;
  open: boolean;
  onPreview: () => void;
}) {
  const { claim } = item;
  return (
    <Disclosure
      header={
        <>
          <Badge
            className={cn(
              caseFailureAnalysisHistoryStyles["analysis-status"],
              `analysis-status completed ${claim.category ?? ""}`,
            )}
          >
            {claim.category ? CATEGORY_LABELS[claim.category] : "已完成"}
          </Badge>
          <strong>
            #{item.batchSequenceNumber} {item.batchName}
          </strong>
          <small>
            {claim.claimantDisplayName}（{claim.claimantUsername}） ·{" "}
            {formatPlatformDateTime(claim.completedAt ?? claim.updatedAt, timeZone)}
          </small>
        </>
      }
      className={cn(
        "case-analysis-history-item",
        caseFailureAnalysisHistoryStyles["case-analysis-history-item"],
      )}
      defaultOpen={open || undefined}
    >
      <div
        className={cn(
          "case-analysis-history-content",
          caseFailureAnalysisHistoryStyles["case-analysis-history-content"],
        )}
      >
        <dl>
          <HistoryField label="问题说明" value={claim.issueDescription} />
          <HistoryField label="用例修改证明" value={claim.caseFixEvidence} />
          <HistoryField label="问题单">
            {claim.ticketReference ? <ReferenceValue value={claim.ticketReference} /> : "—"}
          </HistoryField>
          <HistoryField label="备注" value={claim.remark} />
        </dl>
        <div
          className={cn(
            "case-analysis-history-links",
            caseFailureAnalysisHistoryStyles["case-analysis-history-links"],
          )}
        >
          <Link href={`/run-batches/${encodeURIComponent(claim.batchId)}`}>查看任务详情</Link>
          {claim.rerunProofUrl ? (
            <a href={claim.rerunProofUrl} rel="noreferrer" target="_blank">
              <ExternalLink size={14} /> 重跑通过日志
            </a>
          ) : null}
          {claim.screenshot ? (
            canReadEvidence ? (
              <Button
                className={"case-analysis-history-link"}
                onClick={onPreview}
                size="compact"
                type="button"
                variant="ghost"
              >
                <Maximize2 size={14} /> 查看并放大截图
              </Button>
            ) : (
              <span title={claim.screenshot.fileName}>
                <ImageIcon size={14} /> 已保存证明截图
              </span>
            )
          ) : null}
        </div>
      </div>
    </Disclosure>
  );
}

function HistoryField({
  label,
  value,
  children,
}: {
  label: string;
  value?: string | undefined;
  children?: ReactNode;
}) {
  if (!value && !children) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children ?? value}</dd>
    </div>
  );
}

function ReferenceValue({ value }: { value: string }) {
  if (!/^https?:\/\//iu.test(value)) return value;
  return (
    <a href={value} rel="noreferrer" target="_blank">
      {value} <ExternalLink size={13} />
    </a>
  );
}

function evidenceUrl(item: FailureAnalysisHistoryItemView, projectId: string): string {
  return `/api/v1/failure-analysis/claims/${encodeURIComponent(item.claim.id)}/evidence?projectId=${encodeURIComponent(projectId)}`;
}

const caseFailureAnalysisHistoryStyles = {
  "analysis-status":
    "inline-flex max-w-full [flex:0_0_auto] flex-wrap items-center gap-[5px] py-[3px] px-[7px] rounded-full bg-muted text-muted-foreground text-xs font-semibold [&.available]:bg-info/10 [&.available]:text-info [&.claimed]:bg-warning/10 [&.claimed]:text-warning [&.analyzing]:bg-info/10 [&.analyzing]:text-info [&.completed]:bg-success/10 [&.completed]:text-success [&_small]:overflow-hidden [&_small]:max-w-full [&_small]:text-inherit! [&_small]:text-ellipsis [&_small]:whitespace-nowrap",
  "case-analysis-evidence-dialog":
    "grid w-[min(1320px,_calc(100vw_-_48px))] max-h-[calc(100vh_-_48px)] [grid-template-rows:auto_minmax(0,_1fr)] overflow-hidden rounded-xl bg-card shadow-lg [&_>_header]:flex [&_>_header]:items-center [&_>_header]:justify-between [&_>_header]:gap-3.5 [&_>_header]:border-b [&_>_header]:border-solid [&_>_header]:border-border [&_>_header]:[padding:11px_13px_11px_17px] [&_>_header_>_span]:grid [&_>_header_>_span]:min-w-0 [&_>_header_small]:text-muted-foreground [&_>_img]:max-w-full [&_>_img]:max-h-[calc(100vh_-_112px)] [&_>_img]:m-auto [&_>_img]:p-4.5 [&_>_img]:[object-fit:contain]",

  "case-analysis-history":
    "grid gap-3 p-4.5 [&.compact]:p-4 [&.compact_.case-analysis-history-item_.ui-disclosure-label]:grid-cols-[auto_minmax(0,_1fr)] [&.compact_.case-analysis-history-item_.ui-disclosure-label]:items-start [&.compact_.case-analysis-history-item_.ui-disclosure-label_small]:col-span-full [&.compact_.case-analysis-history-item_.ui-disclosure-label_small]:pl-0.5 [&.compact_.case-analysis-history-item_.ui-disclosure-label_small]:text-left [&.compact_.analysis-status]:flex-nowrap [&.compact_.analysis-status]:whitespace-nowrap [&.compact_.case-analysis-history-content_dl]:grid-cols-[minmax(0,_1fr)] [&_.card-heading_p]:[margin:4px_0_0] [&_.card-heading_p]:text-muted-foreground",
  "case-analysis-history-content":
    "grid gap-3 border-t border-solid border-border p-[13px] bg-muted [&_dl]:grid [&_dl]:grid-cols-2 [&_dl]:gap-[10px_16px] [&_dl]:m-0 [&_dl_>_div]:min-w-0 [&_dt]:mb-[3px] [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:m-0 [&_dd]:text-muted-foreground [&_dd]:leading-[1.55] [&_dd]:[overflow-wrap:anywhere] [&_dd_a]:inline-flex [&_dd_a]:items-center [&_dd_a]:gap-[5px]",
  "case-analysis-history-empty":
    "border border-dashed border-border rounded-lg p-5.5 bg-muted text-muted-foreground text-center",
  "case-analysis-history-item":
    "overflow-hidden border border-solid border-border rounded-lg bg-card [&_.ui-disclosure-label]:grid [&_.ui-disclosure-label]:min-h-13.5 [&_.ui-disclosure-label]:grid-cols-[auto_minmax(150px,_1fr)_minmax(220px,_auto)] [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-2.5 [&_.ui-disclosure-label]:py-2.5 [&_.ui-disclosure-label]:px-[13px] [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:[list-style-position:inside] [&_.ui-disclosure-label:hover]:bg-muted [&_.ui-disclosure-label_strong]:overflow-hidden [&_.ui-disclosure-label_strong]:text-ellipsis [&_.ui-disclosure-label_strong]:whitespace-nowrap [&_.ui-disclosure-label_small]:min-w-0 [&_.ui-disclosure-label_small]:overflow-hidden [&_.ui-disclosure-label_small]:text-muted-foreground [&_.ui-disclosure-label_small]:text-right [&_.ui-disclosure-label_small]:text-ellipsis [&_.ui-disclosure-label_small]:whitespace-nowrap",
  "case-analysis-history-links":
    "[&_a]:inline-flex [&_a]:items-center [&_a]:gap-[5px] [&_button]:inline-flex [&_button]:items-center [&_button]:gap-[5px] [&_button]:border-0 [&_button]:p-0 [&_button]:bg-transparent [&_button]:text-info [&_button]:cursor-pointer [&_button]:[font:inherit] flex flex-wrap items-center gap-[13px] text-sm [&_span]:inline-flex [&_span]:items-center [&_span]:gap-[5px] [&_span]:text-muted-foreground",
  "case-analysis-history-list": "grid gap-[9px]",
  "case-analysis-history-more": "flex justify-center",
} as const;
