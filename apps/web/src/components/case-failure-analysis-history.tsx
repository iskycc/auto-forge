"use client";

import type {
  FailureAnalysisHistoryItemView,
  FailureAnalysisHistoryPageView,
} from "@autoforge/contracts";
import { ClipboardCheck, ExternalLink, ImageIcon, LoaderCircle, Maximize2, X } from "lucide-react";
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
}: {
  caseDefinitionId: string;
  projectId: string;
  initialPage: FailureAnalysisHistoryPageView;
  canReadEvidence: boolean;
  timeZone: string;
  compact?: boolean;
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
      const parameters = new URLSearchParams({ cursor: nextCursor, limit: "20" });
      const response = await fetch(
        `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/failure-analyses?${parameters}`,
        { cache: "no-store" },
      );
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
      <section className={compact ? "case-analysis-history compact" : "card case-analysis-history"}>
        <div className="card-heading">
          <div>
            <span className="eyebrow">Failure analysis history</span>
            <h2>失败分析结论（{nextCursor ? `已加载 ${items.length}` : items.length}）</h2>
            <p>按分析完成时间倒序展示，结论与当前用例永久关联。</p>
          </div>
          <ClipboardCheck size={22} aria-hidden="true" />
        </div>

        {items.length === 0 ? (
          <div className="case-analysis-history-empty">当前用例尚无已完成的失败分析结论。</div>
        ) : (
          <div className="case-analysis-history-list">
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

        {error ? <p className="form-error">{error}</p> : null}
        {!compact && nextCursor ? (
          <div className="case-analysis-history-more">
            <Button
              disabled={loading}
              onClick={() => void loadMore()}
              type="button"
              variant="secondary"
            >
              {loading ? <LoaderCircle className="spin" size={15} /> : null}
              {loading ? "正在加载…" : "加载更早的分析结论"}
            </Button>
          </div>
        ) : null}
      </section>

      {preview?.claim.screenshot ? (
        <div
          className="case-analysis-evidence-overlay"
          onMouseDown={() => setPreview(undefined)}
          role="presentation"
        >
          <section
            aria-label={`查看分析截图 ${preview.claim.screenshot.fileName}`}
            aria-modal="true"
            className="case-analysis-evidence-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <span>
                <strong>{preview.claim.screenshot.fileName}</strong>
                <small>分析证明截图</small>
              </span>
              <Button
                aria-label="关闭分析截图"
                onClick={() => setPreview(undefined)}
                size="compact"
                type="button"
              >
                <X size={16} />
              </Button>
            </header>
            {/* eslint-disable-next-line @next/next/no-img-element -- evidence is authenticated application content */}
            <img
              alt={`分析证明截图：${preview.claim.screenshot.fileName}`}
              src={evidenceUrl(preview, projectId)}
            />
          </section>
        </div>
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
    <details className="case-analysis-history-item" open={open || undefined}>
      <summary>
        <span className={`analysis-status completed ${claim.category ?? ""}`}>
          {claim.category ? CATEGORY_LABELS[claim.category] : "已完成"}
        </span>
        <strong>
          #{item.batchSequenceNumber} {item.batchName}
        </strong>
        <small>
          {claim.claimantDisplayName}（{claim.claimantUsername}） ·{" "}
          {formatPlatformDateTime(claim.completedAt ?? claim.updatedAt, timeZone)}
        </small>
      </summary>
      <div className="case-analysis-history-content">
        <dl>
          <HistoryField label="问题说明" value={claim.issueDescription} />
          <HistoryField label="用例修改证明" value={claim.caseFixEvidence} />
          <HistoryField label="问题单">
            {claim.ticketReference ? <ReferenceValue value={claim.ticketReference} /> : "—"}
          </HistoryField>
          <HistoryField label="备注" value={claim.remark} />
        </dl>
        <div className="case-analysis-history-links">
          <Link href={`/run-batches/${encodeURIComponent(claim.batchId)}`}>查看任务详情</Link>
          {claim.rerunProofUrl ? (
            <a href={claim.rerunProofUrl} rel="noreferrer" target="_blank">
              <ExternalLink size={14} /> 重跑通过日志
            </a>
          ) : null}
          {claim.screenshot ? (
            canReadEvidence ? (
              <Button
                className="case-analysis-history-link"
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
    </details>
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
