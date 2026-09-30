import { Descriptions } from "antd";
import { Badge } from "@/components/ui/badge";
import { Disclosure } from "@/components/ui/disclosure";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import type { CaseDefinitionWithMethods } from "@autoforge/domain";
import { Notice } from "@/components/ui/notice";
import type { ReactNode } from "react";

import { CaseDefinitionEditor } from "@/components/case-definition-editor";
import { CaseExecutionHistory } from "@/components/case-execution-history";
import { CaseFailureAnalysisHistory } from "@/components/case-failure-analysis-history";
import { CaseVersionHistory } from "@/components/case-version-history";
import { LazyCaseSource } from "@/components/lazy-case-source";
import { StatusBadge } from "@/components/status-badge";
import type { CaseDetailView, CaseHistoryView } from "@/lib/case-detail-view";
import { caseExecutionResultLabel } from "@/lib/case-execution-presentation";
import { formatMethodSignature } from "@/lib/jvm-signature";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

type Presentation = "page" | "inspector";

function formatDate(value: string, timeZone: string): string {
  return formatPlatformDateTime(value, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CaseDetailContent({
  detail,
  presentation = "page",
  section = "all",
  onDefinitionUpdated,
  onVersionsChanged,
  managementActions,
}: {
  detail: CaseDetailView;
  presentation?: Presentation;
  section?: "all" | "history" | "definition";
  onDefinitionUpdated?(definition: CaseDefinitionWithMethods): void;
  onVersionsChanged?(): void;
  managementActions?: ReactNode;
}) {
  const { definition, timeZone } = detail;
  const inspector = presentation === "inspector";
  return (
    <>
      {section !== "history" ? (
        <>
          <Card
            as="section"
            aria-label="用例基本信息"
            className="case-definition-summary min-w-0 p-4"
          >
            <Descriptions
              className={cn(
                inspector ? "case-inspector-meta" : "source-meta-grid",
                "[&_table]:w-full [&_table]:table-fixed!",
              )}
              bordered
              size="small"
              layout="vertical"
              column={inspector ? 2 : { xs: 2, sm: 2, md: 2, lg: 2, xl: 4 }}
              classNames={{ content: "min-w-0 [overflow-wrap:anywhere]", label: "text-xs" }}
              items={[
                {
                  key: "state",
                  label: "状态",
                  children: (
                    <strong className="flex flex-wrap gap-2">
                      <StatusBadge enabled={definition.enabled} />
                      {definition.archived ? <Badge>已归档</Badge> : null}
                    </strong>
                  ),
                },
                {
                  key: "package",
                  label: "包名",
                  children: (
                    <strong className="font-medium">{definition.packageName || "—"}</strong>
                  ),
                },
                {
                  key: "scope",
                  label: "版本 / 测试阶段",
                  children: (
                    <strong className="font-medium">
                      {detail.projectVersionName} / {detail.testStageName}
                    </strong>
                  ),
                },
                {
                  key: "groups",
                  label: "分组",
                  children: (
                    <strong className="font-medium">{definition.groups.join("、") || "—"}</strong>
                  ),
                },
                {
                  key: "tags",
                  label: "标签",
                  children: (
                    <strong className="font-medium">{definition.tags.join("、") || "—"}</strong>
                  ),
                },
                {
                  key: "methods",
                  label: "测试方法",
                  children: <strong className="font-medium">{definition.methods.length}</strong>,
                },
                {
                  key: "revision",
                  label: "修订",
                  children: <strong className="font-medium">r{definition.revision}</strong>,
                },
                {
                  key: "updated",
                  label: "最近更新",
                  children: (
                    <strong className="font-medium">
                      {formatDate(definition.updatedAt, timeZone)}
                    </strong>
                  ),
                },
                {
                  key: "parameters",
                  label: "参数（只读）",
                  span: "filled",
                  children: (
                    <strong className="whitespace-pre-wrap font-medium">
                      {Object.entries(definition.parameters)
                        .map(([name, value]) => `${name}=${value}`)
                        .join("；") || "—"}
                    </strong>
                  ),
                },
              ]}
            />
          </Card>

          {!detail.executable ? (
            <Notice className="implementation-notice min-w-0" tone="warning" showIcon role="status">
              该用例来自 sources JAR，可查看和管理源码，但不能直接执行；执行时请导入包含 .class
              的测试 JAR。
            </Notice>
          ) : null}
        </>
      ) : null}

      {section !== "definition" ? (
        <CaseHistoryContent
          detail={detail}
          caseDefinitionId={definition.id}
          projectId={definition.projectId}
          presentation={presentation}
        />
      ) : null}

      {section !== "history" ? (
        <>
          {detail.canReadSource ? (
            <LazyCaseSource
              key={definition.id}
              caseDefinitionId={definition.id}
              revision={definition.revision}
            />
          ) : null}

          {detail.canManage ? (
            <CaseDetailSection presentation={presentation} title="用例元数据">
              <CaseDefinitionEditor
                definition={definition}
                {...(onDefinitionUpdated ? { onUpdated: onDefinitionUpdated } : {})}
              />
              {managementActions}
            </CaseDetailSection>
          ) : null}

          <CaseDetailSection
            presentation={presentation}
            title={`测试方法（${definition.methods.length}）`}
            open
          >
            <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
              <Table
                className={cn(
                  "data-table table-fixed [&_td]:align-top [&_td]:[overflow-wrap:anywhere]",
                  uiPatterns["data-table"],
                )}
              >
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30%]">方法</TableHead>
                    <TableHead className="w-[30%]">方法签名</TableHead>
                    <TableHead>分组</TableHead>
                    <TableHead className="w-24">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {definition.methods.map((method) => (
                    <TableRow key={method.id}>
                      <TableCell>
                        <strong>{method.methodName}</strong>
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "method-signature",
                            caseDetailContentStyles["method-signature"],
                          )}
                        >
                          {formatMethodSignature(method.descriptor)}
                        </span>
                      </TableCell>
                      <TableCell>{method.groups.join("、") || "—"}</TableCell>
                      <TableCell>
                        <StatusBadge enabled={method.enabled} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CaseDetailSection>

          <CaseDetailSection
            presentation={presentation}
            title={`版本历史（${detail.versions.length}）`}
          >
            <CaseVersionHistory
              canManage={detail.canManage}
              canReadSource={detail.canReadSource}
              caseDefinitionId={definition.id}
              currentVersion={definition.currentVersion}
              {...(onVersionsChanged ? { onChanged: onVersionsChanged } : {})}
              versions={detail.versions}
            />
          </CaseDetailSection>
        </>
      ) : null}
    </>
  );
}

export function CaseHistoryContent({
  detail,
  caseDefinitionId,
  projectId,
  presentation = "page",
  compact = false,
}: {
  detail: CaseHistoryView;
  caseDefinitionId: string;
  projectId: string;
  presentation?: Presentation;
  compact?: boolean;
}) {
  const { activity, timeZone } = detail;
  const historyCaseId = detail.historyContext?.caseDefinitionId ?? caseDefinitionId;
  const inspector = presentation === "inspector";
  return (
    <>
      <CaseExecutionHistory
        compact={compact}
        key={`executions:${historyCaseId}`}
        caseDefinitionId={historyCaseId}
        {...(detail.historyContext
          ? { historyUrl: detail.historyContext.executionHistoryUrl }
          : {})}
        initialPage={detail.executionHistory}
        canReadLogs={detail.canReadLogs}
        canRetryRuns={Boolean(detail.canRetry)}
        timeZone={timeZone}
      />
      <CaseFailureAnalysisHistory
        key={`analyses:${historyCaseId}`}
        canReadEvidence={detail.canReadAnalysisEvidence}
        caseDefinitionId={historyCaseId}
        {...(detail.historyContext ? { historyUrl: detail.historyContext.analysisHistoryUrl } : {})}
        compact={inspector}
        initialPage={detail.failureAnalysisHistory}
        projectId={projectId}
        timeZone={timeZone}
      />

      <CaseDetailSection
        presentation={presentation}
        title={`执行结果统计历史（最近 ${activity.analyses.length} 条）`}
      >
        <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
          <Table
            className={cn(
              "data-table table-fixed [&_td]:align-top [&_td]:[overflow-wrap:anywhere]",
              uiPatterns["data-table"],
            )}
          >
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">完成时间</TableHead>
                <TableHead className="w-24">结果</TableHead>
                <TableHead className="w-40">通过 / 失败 / 跳过</TableHead>
                <TableHead>失败签名</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activity.analyses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>当前用例尚无执行结果统计。</TableCell>
                </TableRow>
              ) : null}
              {activity.analyses.map((analysis) => (
                <TableRow key={analysis.attemptId}>
                  <TableCell>{formatDate(analysis.completedAt, timeZone)}</TableCell>
                  <TableCell>
                    {caseExecutionResultLabel(analysis.resultCode ?? analysis.outcome)}
                  </TableCell>
                  <TableCell>
                    {analysis.passed} / {analysis.failed} / {analysis.skipped}
                  </TableCell>
                  <TableCell>{analysis.failureSignature ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CaseDetailSection>
    </>
  );
}

function CaseDetailSection({
  presentation,
  title,
  children,
  open = false,
}: {
  presentation: Presentation;
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  if (presentation === "inspector") {
    return (
      <Disclosure
        header={<>{title}</>}
        className={cn("case-inspector-section", caseDetailContentStyles["case-inspector-section"])}
        defaultOpen={open}
      >
        {children}
      </Disclosure>
    );
  }
  return (
    <Card
      as="section"
      className={cn("card table-card", uiPatterns["card"], caseDetailContentStyles["table-card"])}
    >
      <div className={cn("card-heading", uiPatterns["card-heading"])}>
        <h2>{title}</h2>
      </div>
      <div className="min-w-0 p-4">{children}</div>
    </Card>
  );
}

const caseDetailContentStyles = {
  "case-inspector-section":
    "min-w-0 overflow-hidden border border-solid border-border rounded-lg bg-card [&_.ui-disclosure-label]:min-h-11 [&_.ui-disclosure-label]:py-3 [&_.ui-disclosure-label]:px-3.5 [&_.ui-disclosure-label]:text-foreground [&_.ui-disclosure-label]:font-semibold [&_.ui-disclosure-label]:cursor-pointer [&[data-open=true]_.ui-disclosure-label]:border-b [&[data-open=true]_.ui-disclosure-label]:border-solid [&[data-open=true]_.ui-disclosure-label]:border-border [&_.ui-disclosure-body_>_:not(summary):not(.table-scroll)]:m-3.5 [&_.ui-disclosure-body_>_.settings-stack]:m-0 [&_.ui-disclosure-body_>_.settings-stack]:p-3.5",
  "method-signature":
    "block whitespace-normal text-muted-foreground text-xs [overflow-wrap:anywhere]",
  "table-card":
    "overflow-hidden [&_.ui-card-content_>_.card-heading]:mb-0 [&_.ui-card-content_>_.card-heading]:min-h-14 [&_.ui-card-content_>_.card-heading]:items-center [&_.ui-card-content_>_.card-heading]:border-b [&_.ui-card-content_>_.card-heading]:border-solid [&_.ui-card-content_>_.card-heading]:border-border [&_.ui-card-content_>_.card-heading]:py-3.5 [&_.ui-card-content_>_.card-heading]:px-4.5",
} as const;
