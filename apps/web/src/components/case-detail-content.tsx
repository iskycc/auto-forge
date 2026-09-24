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
import type { CaseDetailView } from "@/lib/case-detail-view";
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
  onDefinitionUpdated,
  onVersionsChanged,
  managementActions,
}: {
  detail: CaseDetailView;
  presentation?: Presentation;
  onDefinitionUpdated?(definition: CaseDefinitionWithMethods): void;
  onVersionsChanged?(): void;
  managementActions?: ReactNode;
}) {
  const { definition, activity, timeZone } = detail;
  const inspector = presentation === "inspector";
  const historyCaseId = detail.historyContext?.caseDefinitionId ?? definition.id;
  return (
    <>
      <Card
        as="section"
        className={`case-definition-summary ${inspector ? "" : cn("card source-summary-card", uiPatterns["card"], caseDetailContentStyles["source-summary-card"])}`}
      >
        <div
          className={
            inspector
              ? cn("case-inspector-meta", caseDetailContentStyles["case-inspector-meta"])
              : cn("source-meta-grid", caseDetailContentStyles["source-meta-grid"])
          }
        >
          <div>
            <span>状态</span>
            <strong>
              <StatusBadge enabled={definition.enabled} />
              {definition.archived ? (
                <Badge className={cn("tag", uiPatterns["tag"])}>已归档</Badge>
              ) : null}
            </strong>
          </div>
          <div>
            <span>包名</span>
            <strong>{definition.packageName || "—"}</strong>
          </div>
          <div>
            <span>版本 / 测试阶段</span>
            <strong>
              {detail.projectVersionName} / {detail.testStageName}
            </strong>
          </div>
          <div>
            <span>分组</span>
            <strong>{definition.groups.join("、") || "—"}</strong>
          </div>
          <div>
            <span>标签</span>
            <strong>{definition.tags.join("、") || "—"}</strong>
          </div>
          <div>
            <span>测试方法</span>
            <strong>{definition.methods.length}</strong>
          </div>
          <div>
            <span>修订</span>
            <strong>r{definition.revision}</strong>
          </div>
          <div>
            <span>最近更新</span>
            <strong>{formatDate(definition.updatedAt, timeZone)}</strong>
          </div>
          <div
            className={
              inspector
                ? cn(
                    "case-inspector-meta-wide",
                    caseDetailContentStyles["case-inspector-meta-wide"],
                  )
                : "source-meta-wide"
            }
          >
            <span>参数（只读）</span>
            <strong>
              {Object.entries(definition.parameters)
                .map(([name, value]) => `${name}=${value}`)
                .join("；") || "—"}
            </strong>
          </div>
        </div>
      </Card>

      {!detail.executable ? (
        <Notice className="implementation-notice min-w-0" tone="warning" showIcon role="status">
          该用例来自 sources JAR，可查看和管理源码，但不能直接执行；执行时请导入包含 .class 的测试
          JAR。
        </Notice>
      ) : null}

      <CaseExecutionHistory
        key={`executions:${historyCaseId}`}
        caseDefinitionId={historyCaseId}
        {...(detail.historyContext
          ? { historyUrl: detail.historyContext.executionHistoryUrl }
          : {})}
        initialPage={detail.executionHistory}
        canReadLogs={detail.canReadLogs}
        canCreateRuns={detail.canRun}
        timeZone={timeZone}
      />
      <CaseFailureAnalysisHistory
        key={`analyses:${historyCaseId}`}
        canReadEvidence={detail.canReadAnalysisEvidence}
        caseDefinitionId={historyCaseId}
        {...(detail.historyContext ? { historyUrl: detail.historyContext.analysisHistoryUrl } : {})}
        compact={inspector}
        initialPage={detail.failureAnalysisHistory}
        projectId={definition.projectId}
        timeZone={timeZone}
      />

      <CaseDetailSection
        presentation={presentation}
        title={`执行结果统计历史（最近 ${activity.analyses.length} 条）`}
      >
        <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
          <Table className={cn("data-table", uiPatterns["data-table"])}>
            <TableHeader>
              <TableRow>
                <TableHead>完成时间</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>通过 / 失败 / 跳过</TableHead>
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
          <Table className={cn("data-table", uiPatterns["data-table"])}>
            <TableHeader>
              <TableRow>
                <TableHead>方法</TableHead>
                <TableHead>方法签名</TableHead>
                <TableHead>分组</TableHead>
                <TableHead>状态</TableHead>
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
      {children}
    </Card>
  );
}

const caseDetailContentStyles = {
  "case-inspector-meta":
    "grid grid-cols-2 gap-2 [&_>_div]:grid [&_>_div]:min-w-0 [&_>_div]:gap-1 [&_>_div]:border [&_>_div]:border-solid [&_>_div]:border-border [&_>_div]:rounded-lg [&_>_div]:p-2.5 [&_>_div]:bg-card [&_span]:text-muted-foreground [&_span]:text-xs [&_strong]:min-w-0 [&_strong]:[overflow-wrap:anywhere]",
  "case-inspector-meta-wide": "col-span-full",
  "case-inspector-section":
    "min-w-0 overflow-hidden border border-solid border-border rounded-lg bg-card [&_.ui-disclosure-label]:min-h-11 [&_.ui-disclosure-label]:py-3 [&_.ui-disclosure-label]:px-3.5 [&_.ui-disclosure-label]:text-foreground [&_.ui-disclosure-label]:font-semibold [&_.ui-disclosure-label]:cursor-pointer [&[data-open=true]_.ui-disclosure-label]:border-b [&[data-open=true]_.ui-disclosure-label]:border-solid [&[data-open=true]_.ui-disclosure-label]:border-border [&_.ui-disclosure-body_>_:not(summary):not(.table-scroll)]:m-3.5 [&_.ui-disclosure-body_>_.settings-stack]:m-0 [&_.ui-disclosure-body_>_.settings-stack]:p-3.5",
  "method-signature":
    "max-w-[340px] overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground text-xs",
  "source-meta-grid":
    "grid grid-cols-[1.4fr_2fr_0.8fr_1fr] gap-px overflow-hidden border border-solid border-border rounded-lg bg-border [&_>_div]:flex [&_>_div]:min-w-0 [&_>_div]:flex-col [&_>_div]:gap-[7px] [&_>_div]:p-[13px] [&_>_div]:bg-muted [&_>_div:last-child:nth-child(4n_+_1)]:col-span-full [&_>_div:last-child:nth-child(4n_+_2)]:[grid-column:span_3] [&_>_div:last-child:nth-child(4n_+_3)]:[grid-column:span_2] [&_span]:text-muted-foreground [&_span]:text-xs [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-normal [&_strong]:text-xs [&_strong]:[overflow-wrap:anywhere] [&_strong]:whitespace-normal",
  "source-summary-card": "p-4.5",
  "table-card":
    "overflow-hidden [&_.ui-card-content_>_.card-heading]:min-h-17 [&_.ui-card-content_>_.card-heading]:items-center [&_.ui-card-content_>_.card-heading]:border-b [&_.ui-card-content_>_.card-heading]:border-solid [&_.ui-card-content_>_.card-heading]:border-border [&_.ui-card-content_>_.card-heading]:py-3.5 [&_.ui-card-content_>_.card-heading]:px-4.5",
} as const;
