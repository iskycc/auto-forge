import { Alert, Card, Descriptions, Tag } from "antd";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import type { SharedAttemptLogView } from "@autoforge/contracts";
import { Link2Off } from "lucide-react";
import Link from "next/link";
import { LinkButton } from "@/components/ui/link-button";
import type { ReactNode } from "react";

import { SharedAttemptLogActions } from "@/components/shared-attempt-log-actions";
import { CustomScrollArea } from "@/components/custom-scroll-area";
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
    <main className={cn("share-log-page", sharedAttemptLogContentStyles["share-log-page"])}>
      <div className={cn("share-log-layout", sharedAttemptLogContentStyles["share-log-layout"])}>
        <Card
          role="complementary"
          className={cn("share-log-aside", sharedAttemptLogContentStyles["share-log-aside"])}
          styles={{ body: { padding: 0, height: "100%" } }}
        >
          <CustomScrollArea
            ariaLabel="用例信息"
            className={cn(
              "share-log-aside-scroll",
              sharedAttemptLogContentStyles["share-log-aside-scroll"],
            )}
          >
            <div
              className={cn(
                "share-log-aside-content",
                sharedAttemptLogContentStyles["share-log-aside-content"],
              )}
            >
              <p className={cn("eyebrow", uiPatterns["eyebrow"])}>Shared Attempt Log</p>
              <div
                className={cn(
                  "share-log-heading",
                  sharedAttemptLogContentStyles["share-log-heading"],
                )}
              >
                <h1>{view.displayName}</h1>
                <Tag
                  className={cn(
                    sharedAttemptLogContentStyles["batch-status"],
                    `batch-status ${sharedOutcomeClass(view.outcome)}`,
                  )}
                >
                  {sharedOutcomeLabel(view.outcome)}
                </Tag>
              </div>
              <SharedLogRerunAction
                access={rerunAccess}
                attempt={{ id: view.attemptId, status: view.outcome }}
              />
              {view.rounds.length > 1 ? (
                <RoundLogNavigation historyHref={historyHref} timeZone={timeZone} view={view} />
              ) : null}
              <div
                className={cn("share-log-facts", sharedAttemptLogContentStyles["share-log-facts"])}
              >
                <ShareFact label="执行类路径">
                  <code>{view.casePath}</code>
                </ShareFact>
                <ShareFact label={view.caseType === "ddt" ? "用例名称（CaseID）" : "用例名称"}>
                  {view.displayName}
                </ShareFact>
                <ShareFact label="用例更新时间">
                  <span title="本次执行使用的依赖 JAR 压缩包上传或登记时间">
                    {view.dependencyUpdatedAt ? (
                      <ShareTime timeZone={timeZone} value={view.dependencyUpdatedAt} />
                    ) : (
                      "未记录"
                    )}
                  </span>
                </ShareFact>
                <ShareFact label="执行结果">
                  <Tag
                    className={cn(
                      sharedAttemptLogContentStyles["batch-status"],
                      `batch-status ${sharedOutcomeClass(view.outcome)}`,
                    )}
                  >
                    {sharedOutcomeLabel(view.outcome)}
                  </Tag>
                  {view.resultCode ? <code>{view.resultCode}</code> : null}
                </ShareFact>
                {view.summary ? (
                  <ShareFact label="错误描述">
                    <pre
                      className={cn(
                        "share-log-summary",
                        sharedAttemptLogContentStyles["share-log-summary"],
                      )}
                    >
                      {view.summary}
                    </pre>
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
              </div>
            </div>
          </CustomScrollArea>
        </Card>
        <Card
          className={cn("share-log-main", sharedAttemptLogContentStyles["share-log-main"])}
          title="执行日志"
          extra={<Tag color="blue">只读日志</Tag>}
          role="region"
          aria-label="执行日志"
          styles={{
            body: {
              padding: 0,
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            },
          }}
        >
          {truncated ? (
            <Alert
              type="warning"
              showIcon
              className="share-log-truncated m-4 shrink-0"
              title="日志过大已截断：仅展示前 512 KB 内容，完整日志请联系日志发布者导出。"
            />
          ) : null}
          <CustomScrollArea
            ariaLabel="日志内容"
            className={cn(
              "share-log-output-scroll",
              sharedAttemptLogContentStyles["share-log-output-scroll"],
            )}
          >
            <pre
              className={cn(
                "execution-log share-log-output",
                sharedAttemptLogContentStyles["execution-log"],
                sharedAttemptLogContentStyles["share-log-output"],
              )}
            >
              {bounded.text
                ? renderedSegments.map((segment, index) => (
                    <span className={segment.classes.join(" ")} key={index}>
                      {segment.text}
                    </span>
                  ))
                : "本次尝试暂无日志内容。"}
            </pre>
          </CustomScrollArea>
        </Card>
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
        className={cn(
          "button button-secondary share-log-rerun-login",
          uiPatterns["button"],
          uiPatterns["button-secondary"],
          sharedAttemptLogContentStyles["share-log-rerun-login"],
        )}
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
      <LinkButton
        variant="primary"
        className={cn(
          "button button-primary share-log-rerun-login",
          uiPatterns["button"],
          uiPatterns["button-primary"],
          sharedAttemptLogContentStyles["share-log-rerun-login"],
        )}
        href="/login"
      >
        登录后执行此用例
      </LinkButton>
    );
  }
  return (
    <Button
      className={cn(
        "button button-secondary share-log-rerun-login",
        uiPatterns["button"],
        uiPatterns["button-secondary"],
        sharedAttemptLogContentStyles["share-log-rerun-login"],
      )}
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
    <nav
      className={cn("share-log-rounds", sharedAttemptLogContentStyles["share-log-rounds"])}
      aria-label="同一用例的执行历史"
    >
      <div
        className={cn(
          "share-log-rounds-heading",
          sharedAttemptLogContentStyles["share-log-rounds-heading"],
        )}
      >
        <h2>执行历史</h2>
        <span>{view.rounds.length} 个结果</span>
      </div>
      <ol
        className={cn(
          "share-log-round-list",
          sharedAttemptLogContentStyles["share-log-round-list"],
        )}
      >
        {view.rounds.map((round) => {
          const active = round.attemptId === view.attemptId;
          return (
            <li
              className={cn(
                "share-log-round-item",
                sharedAttemptLogContentStyles["share-log-round-item"],
              )}
              key={round.attemptId}
            >
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  sharedAttemptLogContentStyles["share-log-round-link"],
                  `share-log-round-link${active ? " active" : ""}`,
                )}
                href={`${historyHref}?attempt=${encodeURIComponent(round.attemptId)}`}
                prefetch={false}
              >
                <span
                  className={cn(
                    "share-log-round-link-heading",
                    sharedAttemptLogContentStyles["share-log-round-link-heading"],
                  )}
                >
                  <strong>
                    {round.kind === "manual_rerun"
                      ? "手动重跑"
                      : executionRoundLabel(round.executionRound, round.attemptNumber)}
                  </strong>
                  <Tag
                    className={cn(
                      sharedAttemptLogContentStyles["batch-status"],
                      `batch-status ${sharedOutcomeClass(round.outcome)}`,
                    )}
                  >
                    {sharedOutcomeLabel(round.outcome)}
                  </Tag>
                </span>
                <span
                  className={cn(
                    "share-log-round-meta",
                    sharedAttemptLogContentStyles["share-log-round-meta"],
                  )}
                >
                  <span
                    className={cn(
                      "share-log-round-time",
                      sharedAttemptLogContentStyles["share-log-round-time"],
                    )}
                  >
                    <ShareTime timeZone={timeZone} value={round.finishedAt ?? round.startedAt} />
                    {round.durationMs !== null ? (
                      <span>{(round.durationMs / 1_000).toFixed(1)} 秒</span>
                    ) : null}
                  </span>
                  {round.requestedBy ? (
                    <span
                      className={cn(
                        "share-log-round-requester",
                        sharedAttemptLogContentStyles["share-log-round-requester"],
                      )}
                    >
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
    <Descriptions
      className="share-log-fact"
      size="small"
      column={1}
      layout="vertical"
      styles={{
        label: { paddingBottom: 4, fontSize: 12, color: "var(--muted-foreground)" },
        content: { overflowWrap: "anywhere", minWidth: 0 },
      }}
      items={[
        {
          key: label,
          label,
          children: (
            <div className="flex min-w-0 flex-wrap items-center gap-2 [&_code]:text-xs">
              {children}
            </div>
          ),
        },
      ]}
    />
  );
}

function ShareTime({ value, timeZone }: { value: string | null; timeZone: string }) {
  if (!value) return <>—</>;
  return <time title={`UTC ${value}`}>{formatLocalDateTime(value, timeZone)}</time>;
}

export function InvalidAttemptLogShareView() {
  return (
    <main
      className={cn(
        "share-log-page share-log-page-center",
        sharedAttemptLogContentStyles["share-log-page"],
        sharedAttemptLogContentStyles["share-log-page-center"],
      )}
    >
      <section
        className={cn("share-log-invalid", sharedAttemptLogContentStyles["share-log-invalid"])}
        aria-label="日志公开访问链接不可用"
      >
        <span
          className={cn(
            "share-log-invalid-icon",
            sharedAttemptLogContentStyles["share-log-invalid-icon"],
          )}
          aria-hidden="true"
        >
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
    <main
      className={cn(
        "share-log-page share-log-page-center",
        sharedAttemptLogContentStyles["share-log-page"],
        sharedAttemptLogContentStyles["share-log-page-center"],
      )}
      aria-busy="true"
    >
      <LoadingState
        label="正在加载执行日志"
        description="正在校验永久分享凭据并读取有界日志内容。"
      />
    </main>
  );
}

const sharedAttemptLogContentStyles = {
  "batch-status": uiPatterns["batch-status"],
  "execution-log": uiPatterns["execution-log"],
  "share-log-aside":
    "min-h-0 overflow-hidden border border-solid border-border rounded-xl bg-card shadow-xs",
  "share-log-aside-content": "[box-sizing:border-box] min-h-full p-6",
  "share-log-aside-scroll": "h-full",
  "share-log-fact":
    "grid gap-1 [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dt]:font-semibold [&_dd]:flex [&_dd]:flex-wrap [&_dd]:items-center [&_dd]:gap-2 [&_dd]:m-0 [&_dd]:text-foreground [&_dd]:text-sm [&_dd]:[overflow-wrap:anywhere] [&_code]:font-mono [&_code]:text-xs",
  "share-log-facts": "grid gap-3.5 m-0",
  "share-log-heading":
    "flex items-start justify-between gap-3 [margin:6px_0_18px] [&_h1]:m-0 [&_h1]:text-lg [&_h1]:leading-[1.35] [&_h1]:[overflow-wrap:anywhere]",
  "share-log-invalid":
    "grid justify-items-center gap-2.5 w-[min(100%,_420px)] border border-solid border-border rounded-xl py-11 px-9 bg-card shadow-xs text-center [&_h1]:[margin:4px_0_0] [&_h1]:text-lg [&_p]:m-0 [&_p]:text-muted-foreground [&_p]:text-sm [&_p]:leading-[1.7]",
  "share-log-invalid-icon":
    "grid place-items-center w-14 h-14 rounded-full bg-warning/10 text-warning",
  "share-log-layout":
    "grid grid-cols-[minmax(340px,_380px)_minmax(0,_1fr)] gap-4.5 items-stretch w-[min(100%,_1680px)] h-full min-h-0 my-0 mx-auto",
  "share-log-main":
    "flex min-w-0 min-h-0 flex-col overflow-hidden border border-solid border-border rounded-xl bg-card shadow-xs",
  "share-log-output":
    "[box-sizing:border-box] w-full min-h-full max-h-none m-0 border-0 rounded-none [padding:18px_24px_24px] overflow-visible",
  "share-log-output-scroll": "min-h-0 [flex:1_1_auto]",
  "share-log-page": `box-border h-dvh min-h-0 overflow-hidden p-6 bg-background text-foreground`,
  "share-log-page-center": "grid place-items-center",
  "share-log-rerun-login": "mb-4.5",
  "share-log-round-item":
    'relative pl-4.5 [&::before]:absolute [&::before]:z-1 [&::before]:top-[17px] [&::before]:left-0.5 [&::before]:w-[9px] [&::before]:h-[9px] [&::before]:border-2 [&::before]:border-solid [&::before]:border-border [&::before]:rounded-full [&::before]:bg-card [&::before]:[content:""] [&:not(:last-child)::after]:absolute [&:not(:last-child)::after]:top-[27px] [&:not(:last-child)::after]:bottom-[-16px] [&:not(:last-child)::after]:left-1.5 [&:not(:last-child)::after]:w-px [&:not(:last-child)::after]:bg-input [&:not(:last-child)::after]:[content:""] [&:has(.share-log-round-link.active)::before]:border-info [&:has(.share-log-round-link.active)::before]:bg-info [&:has(.share-log-round-link.active)::before]:shadow-xs',
  "share-log-round-link":
    "grid gap-[7px] min-w-0 border border-solid border-transparent rounded-lg py-2.5 px-[11px] text-inherit [text-decoration:none] [&:hover]:border-input [&:hover]:bg-muted [&:focus-visible]:[outline:2px_solid_var(--info)] [&:focus-visible]:[outline-offset:2px] [&.active]:border-info [&.active]:bg-info/10",
  "share-log-round-link-heading": "flex items-center justify-between gap-2.5 [&_strong]:text-sm",
  "share-log-round-list": "grid gap-2 m-0 p-0 [list-style:none]",
  "share-log-round-meta":
    "flex items-center justify-start gap-2.5 flex-wrap gap-y-1 text-muted-foreground text-xs",
  "share-log-round-requester": "[flex:1_0_100%] whitespace-nowrap",
  "share-log-round-time":
    'inline-flex gap-2.5 whitespace-nowrap [&_>_:not(:last-child)::after]:ml-2.5 [&_>_:not(:last-child)::after]:[content:"·"]',
  "share-log-rounds": "[margin:0_0_20px] border-t border-solid border-border border-b py-4.5 px-0",
  "share-log-rounds-heading":
    "flex items-center justify-between gap-2.5 mb-2.5 [&_h2]:m-0 [&_h2]:text-sm [&_>_span]:text-muted-foreground [&_>_span]:text-xs",
  "share-log-summary":
    "m-0 w-full border border-solid border-border rounded-lg py-2.5 px-3 bg-muted text-destructive font-mono text-xs leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]",
  "share-log-truncated": "[flex:0_0_auto] [margin:14px_16px_0]",
  "status-warning":
    "[margin:0_0_10px] border border-solid border-transparent rounded-lg py-2 px-2.5 text-warning bg-warning/10 text-xs",
} as const;
