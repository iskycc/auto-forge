import type { SharedAttemptLogView } from "@autoforge/contracts";
import { Link2Off } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { SharedAttemptLogActions } from "@/components/shared-attempt-log-actions";
import { Button } from "@/components/ui";
import { LoadingState } from "@/components/loading-state";
import { highlightLogLevels } from "@/lib/log-levels";
import { visibleAttemptLogText } from "@/lib/log-presentation";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { parseSafeAnsi } from "@/lib/safe-ansi";
import {
  sharedOutcomeClass,
  sharedOutcomeLabel,
  truncateSharedLogText,
} from "@/lib/shared-attempt-log";

export type SharedLogRerunAccess = "allowed" | "read_only" | "login" | "forbidden";

export function SharedAttemptLogContent({
  view,
  timeZone,
  rerunAccess,
  historyHref,
}: {
  view: SharedAttemptLogView;
  timeZone: string;
  rerunAccess: SharedLogRerunAccess;
  /** 不包含 query 的当前分享入口，用于同标签页切换同一用例的其他轮次。 */
  historyHref: string;
}) {
  const bounded = truncateSharedLogText(visibleAttemptLogText(view.logText));
  const truncated = Boolean(view.logTruncated) || bounded.truncated;
  const renderedSegments = highlightLogLevels(parseSafeAnsi(bounded.text));
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
          <SharedLogRerunAction
            access={rerunAccess}
            attempt={{ id: view.attemptId, status: view.outcome }}
          />
          {view.rounds.length > 1 ? (
            <RoundLogNavigation historyHref={historyHref} timeZone={timeZone} view={view} />
          ) : null}
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
              <ShareTime timeZone={timeZone} value={view.startedAt} />
            </ShareFact>
            <ShareFact label="执行结束时间">
              <ShareTime timeZone={timeZone} value={view.finishedAt} />
            </ShareFact>
            <ShareFact label="执行耗时">
              {view.durationMs !== null ? `${(view.durationMs / 1_000).toFixed(1)} 秒` : "—"}
            </ShareFact>
            <ShareFact label="批次 / 当前轮次">
              <span title={`批次 ${view.batchId} · 尝试 ${view.attemptId}`}>
                批次 #{view.batchSequenceNumber} ·{" "}
                {view.kind === "manual_rerun"
                  ? "手动重跑"
                  : executionRoundLabel(view.executionRound, view.attemptNumber)}
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
            {bounded.text
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

function SharedLogRerunAction({
  access,
  attempt,
}: {
  access: SharedLogRerunAccess;
  attempt: { id: string; status: SharedAttemptLogView["outcome"] };
}) {
  if (access === "allowed") {
    return <SharedAttemptLogActions attempt={attempt} canCreateRuns />;
  }
  if (access === "read_only") {
    if (attempt.status === "assigned" || attempt.status === "running") {
      return <SharedAttemptLogActions attempt={attempt} canCreateRuns={false} />;
    }
    return (
      <Button
        className="button button-secondary share-log-rerun-login"
        disabled
        title="当前账号没有该项目的执行创建权限"
        type="button"
      >
        无权执行此用例
      </Button>
    );
  }
  if (access === "login") {
    return (
      <Link className="button button-primary share-log-rerun-login" href="/login">
        登录后执行此用例
      </Link>
    );
  }
  return (
    <Button
      className="button button-secondary share-log-rerun-login"
      disabled
      title="当前账号没有该项目的日志读取或执行创建权限"
      type="button"
    >
      无权执行此用例
    </Button>
  );
}

function RoundLogNavigation({
  view,
  timeZone,
  historyHref,
}: {
  view: SharedAttemptLogView;
  timeZone: string;
  historyHref: string;
}) {
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
                href={`${historyHref}?attempt=${encodeURIComponent(round.attemptId)}`}
                prefetch={false}
              >
                <span className="share-log-round-link-heading">
                  <strong>
                    {round.kind === "manual_rerun"
                      ? "手动重跑"
                      : executionRoundLabel(round.executionRound, round.attemptNumber)}
                  </strong>
                  <span className={`batch-status ${sharedOutcomeClass(round.outcome)}`}>
                    {sharedOutcomeLabel(round.outcome)}
                  </span>
                </span>
                <span className="share-log-round-meta">
                  <span className="share-log-round-time">
                    <ShareTime timeZone={timeZone} value={round.finishedAt ?? round.startedAt} />
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

function executionRoundLabel(executionRound: number, attemptNumber: number): string {
  return executionRound === attemptNumber
    ? `第 ${executionRound} 轮`
    : `第 ${executionRound} 轮 · 第 ${attemptNumber} 次尝试`;
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

function ShareTime({ value, timeZone }: { value: string | null; timeZone: string }) {
  if (!value) return <>—</>;
  return <time title={`UTC ${value}`}>{formatLocalDateTime(value, timeZone)}</time>;
}

export function InvalidAttemptLogShareView() {
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

export function SharedAttemptLogLoadingView() {
  return (
    <main className="share-log-page share-log-page-center" aria-busy="true">
      <LoadingState
        label="正在加载执行日志"
        description="正在校验永久分享凭据并读取有界日志内容。"
      />
    </main>
  );
}
