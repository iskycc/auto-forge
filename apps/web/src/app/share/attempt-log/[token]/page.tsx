import type { SharedAttemptLogView } from "@autoforge/contracts";
import { Link2Off } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { highlightLogLevels } from "@/lib/log-levels";
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
  title: "执行日志分享",
};

/**
 * 免登录的执行日志分享页。token 只标识一次执行尝试的只读视图，
 * 无效或过期时渲染整页错误态而不是跳转登录。
 */
export default async function SharedAttemptLogPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const services = await getPlatformServices();
  const view = await services.attemptLogShares.getSharedAttemptLog(token);
  if (!view) return <InvalidShareView />;
  return <SharedAttemptLogContent view={view} />;
}

function SharedAttemptLogContent({ view }: { view: SharedAttemptLogView }) {
  const { text: logText, truncated } = truncateSharedLogText(view.logText);
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
            <ShareFact label="批次 / 尝试号">
              <span title={`批次 ${view.batchId} · 尝试 ${view.attemptId}`}>
                批次 {view.batchId.slice(0, 8)} · 第 {view.attemptNumber} 次尝试
              </span>
            </ShareFact>
            <ShareFact label="链接有效期">
              <ShareTime value={view.expiresAt} />
            </ShareFact>
          </dl>
        </aside>
        <section className="share-log-main" aria-label="执行日志">
          {truncated ? (
            <p className="status-warning share-log-truncated" role="status">
              日志过大已截断：仅展示前 512 KB 内容，完整日志请联系分享者导出。
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
      <section className="share-log-invalid" aria-label="分享链接不可用">
        <span className="share-log-invalid-icon" aria-hidden="true">
          <Link2Off size={30} strokeWidth={1.8} />
        </span>
        <h1>链接无效或已过期</h1>
        <p>该分享链接可能已被撤销或超过有效期，请联系分享者重新生成后再访问。</p>
      </section>
    </main>
  );
}
