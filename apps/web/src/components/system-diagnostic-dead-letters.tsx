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
import type { SystemDiagnostic } from "@autoforge/contracts";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";

export function DiagnosticDeadLetters({
  diagnostic,
  canManage,
  redriving,
  loading,
  redriveDeadLetters,
}: {
  diagnostic: SystemDiagnostic;
  canManage: boolean;
  redriving: boolean;
  loading: boolean;
  redriveDeadLetters(): Promise<void>;
}) {
  return (
    <>
      {diagnostic.deadLetters.length > 0 ? (
        <Card
          as="div"
          className={cn(
            "content-card diagnostic-dead-letters",
            uiPatterns["content-card"],
            systemDiagnosticDeadLettersStyles["diagnostic-dead-letters"],
          )}
        >
          <div className={cn("section-heading", uiPatterns["section-heading"])}>
            <div>
              <h3>死信任务</h3>
              <p>保留最后一次失败原因；确认问题已修复后可重新投递。</p>
            </div>
            {canManage ? (
              <Button
                disabled={redriving || loading}
                onClick={() => void redriveDeadLetters()}
                type="button"
                variant="secondary"
              >
                <RotateCcw size={15} /> {redriving ? "正在重新投递…" : "重新投递（最多 100 条）"}
              </Button>
            ) : null}
          </div>
          <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
            <Table className={cn("data-table", uiPatterns["data-table"])}>
              <TableHeader>
                <TableRow>
                  <TableHead>任务类型</TableHead>
                  <TableHead>关联对象</TableHead>
                  <TableHead>失败原因</TableHead>
                  <TableHead>投递次数</TableHead>
                  <TableHead>失败时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diagnostic.deadLetters.map((deadLetter) => (
                  <TableRow key={deadLetter.messageId}>
                    <TableCell>{queueJobKindLabel(deadLetter.kind)}</TableCell>
                    <TableCell>
                      <code title={deadLetter.runId}>{shortId(deadLetter.runId)}</code>
                    </TableCell>
                    <TableCell>
                      <strong>{deadLetter.errorCode}</strong>
                      <small className={cn("table-secondary", uiPatterns["table-secondary"])}>
                        {deadLetter.errorSummary}
                      </small>
                    </TableCell>
                    <TableCell>{deadLetter.deliveryAttempts}</TableCell>
                    <TableCell>
                      <time dateTime={deadLetter.failedAt}>{formatDate(deadLetter.failedAt)}</time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

function queueJobKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    "dispatch-run": "执行调度",
    "ldap-sync": "历史 LDAP 同步（已停用）",
    "analytics-rollup": "质量统计",
    "retention-cleanup": "数据清理",
    "object-cleanup": "对象清理",
    "jar-import": "JAR 导入",
    "analytics-export": "质量导出",
    "ddt-import": "DDT 导入",
  };
  return labels[kind] ?? kind;
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

const systemDiagnosticDeadLettersStyles = {
  "diagnostic-dead-letters":
    "grid gap-2.5 border border-solid border-border rounded-xl p-3.5 bg-warning/10 [&_.section-heading_h3]:m-0 [&_.section-heading_p]:m-0 [&_.section-heading_p]:mt-[3px] [&_.section-heading_p]:text-muted-foreground [&_.section-heading_p]:text-xs [&_.table-scroll]:max-h-[360px] [&_.table-scroll]:bg-card",
} as const;
