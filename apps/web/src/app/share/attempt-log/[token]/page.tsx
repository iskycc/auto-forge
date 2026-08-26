import type { SharedAttemptLogView } from "@autoforge/contracts";
import { Link2Off } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { highlightLogLevels } from "@/lib/log-levels";
import { visibleAttemptLogText } from "@/lib/log-presentation";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { parseSafeAnsi } from "@/lib/safe-ansi";
import { getPlatformServices } from "@/lib/services";
import {
  sharedOutcomeClass,
  sharedOutcomeLabel,
  truncateSharedLogText,
} from "@/lib/shared-attempt-log";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "执行日志公开访问",
};

/**
 * 免登录的执行日志公开访问页。token 以签发 attempt 为锚点，并允许只读切换该
 * ExecutionRun 的其他已完成轮次；链接永久有效，失效时渲染整页错误态而不是跳转登录。
 */
export default async function SharedAttemptLogPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ attempt?: string | string[] }>;
}) {
  const { token } = await params;
  const attemptParameter = (await searchParams).attempt;
  const selectedAttemptId =
    typeof attemptParameter === "string" && attemptParameter.length <= 128
      ? attemptParameter
      : undefined;
  const services = await getPlatformServices();
  const view = await services.attemptLogShares.getSharedAttemptLog(token, selectedAttemptId);
  if (!view) return <InvalidShareView />;
  return <SharedAttemptLogContent token={token} view={view} />;
}

function SharedAttemptLogContent({ token, view }: { token: string; view: SharedAttemptLogView }) {
  const { text: logText, truncated } = truncateSharedLogText(visibleAttemptLogText(view.logText));
  const renderedSegments = highlightLogLevels(parseSafeAnsi(logText));
  return (
    <main className="share-log-page">
      <div className="share-log-layout">
        <aside className="share-log-aside">
          <p className="eyebrow">Shared Attempt Log</p>
          <div className="share-log-heading">
            <h1>{view.displayName}</h1>
            <span className={`batch-status ${sharedOutcomeClass(view.outcome)}`}>
              {sharedOutcomeLabel(view.outcome)}
            </span>
          </div>
          {view.rounds.length > 1 ? <RoundLogNavigation token={token} view={view} /> : null}
          <dl className="share-log-facts">
            <ShareFact label="用例路径">
              <code>{view.casePath}</code>
            </ShareFact>
            <ShareFact label="用例名称">{view.displayName}</ShareFact>
            <ShareFact label="执行结果">
              <span className={`batch-status ${sharedOutcomeClass(view.outcome)}`}>
                {sharedOutcomeLabel(view.outcome)}
              </span>
              {view.resultCode ? <code>{view.resultCode}</code> : null}
            </ShareFact>
            {view.summary ? (
              <ShareFact label="错误描述">
                <pre className="share-log-summary">{view.summary}</pre>
              </ShareFact>
            ) : null}
            <ShareFact label="执行开始时间">
              <ShareTime value={view.startedAt} />
            </ShareFact>
            <ShareFact label="执行结束时间">
              <ShareTime value={view.finishedAt} />
            </ShareFact>
            <ShareFact label="执行耗时">
              {view.durationMs !== null ? `${(view.durationMs / 1_000).toFixed(1)} 秒` : "—"}
            </ShareFact>
            <ShareFact label="批次 / 当前轮次">
              <span title={`批次 ${view.batchId} · 尝试 ${view.attemptId}`}>
                批次 #{view.batchSequenceNumber} ·{" "}
                {view.kind === "manual_rerun" ? "手动重跑" : `第 ${view.attemptNumber} 轮`}
              </span>
              {view.requestedBy ? <span>{requesterLabel(view.requestedBy)}</span> : null}
            </ShareFact>
          </dl>
        </aside>
        <section className="share-log-main" aria-label="执行日志">
          {truncated ? (
            <p className="status-warning share-log-truncated" role="status">
              日志过大已截断：仅展示前 512 KB 内容，完整日志请联系日志发布者导出。
            </p>
          ) : null}
          <pre className="execution-log execution-log-dark share-log-output">
            {logText
              ? renderedSegments.map((segment, index) => (
                  <span className={segment.classes.join(" ")} key={index}>
                    {segment.text}
                  </span>
                ))
              : "本次尝试暂无日志内容。"}
          </pre>
        </section>
      </div>
    </main>
  );
}

function RoundLogNavigation({ token, view }: { token: string; view: SharedAttemptLogView }) {
  return (
    <nav className="share-log-rounds" aria-label="同一用例的执行历史">
      <div className="share-log-rounds-heading">
        <h2>执行历史</h2>
        <span>{view.rounds.length} 个结果</span>
      </div>
      <ol className="share-log-round-list">
        {view.rounds.map((round) => {
          const active = round.attemptId === view.attemptId;
          return (
            <li className="share-log-round-item" key={round.attemptId}>
              <Link
                aria-current={active ? "page" : undefined}
                className={`share-log-round-link${active ? " active" : ""}`}
                href={`/share/attempt-log/${encodeURIComponent(token)}?attempt=${encodeURIComponent(round.attemptId)}`}
                prefetch={false}
              >
                <span className="share-log-round-link-heading">
                  <strong>
                    {round.kind === "manual_rerun" ? "手动重跑" : `第 ${round.attemptNumber} 轮`}
                  </strong>
                  <span className={`batch-status ${sharedOutcomeClass(round.outcome)}`}>
                    {sharedOutcomeLabel(round.outcome)}
                  </span>
                </span>
                <span className="share-log-round-meta">
                  <span className="share-log-round-time">
                    <ShareTime value={round.finishedAt ?? round.startedAt} />
                    {round.durationMs !== null ? (
                      <span>{(round.durationMs / 1_000).toFixed(1)} 秒</span>
                    ) : null}
                  </span>
                  {round.requestedBy ? (
                    <span className="share-log-round-requester">
                      {requesterLabel(round.requestedBy)}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function requesterLabel(requestedBy: { username: string; source: "local" | "ldap" }): string {
  return `by ${requestedBy.username}（${requestedBy.source === "ldap" ? "LDAP" : "本地"}）`;
}

function ShareFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="share-log-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** 时间统一用用户时区展示，UTC 原值放在 title 中，与详情页约定一致。 */
function ShareTime({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return <time title={`UTC ${value}`}>{formatLocalDateTime(value)}</time>;
}

function InvalidShareView() {
  return (
    <main className="share-log-page share-log-page-center">
      <section className="share-log-invalid" aria-label="日志公开访问链接不可用">
        <span className="share-log-invalid-icon" aria-hidden="true">
          <Link2Off size={30} strokeWidth={1.8} />
        </span>
        <h1>链接无效</h1>
        <p>该日志公开访问链接无效或已被撤销，请联系日志发布者重新生成。</p>
      </section>
    </main>
  );
}
