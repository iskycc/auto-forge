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
        <div className="content-card diagnostic-dead-letters">
          <div className="section-heading">
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
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>任务类型</th>
                  <th>关联对象</th>
                  <th>失败原因</th>
                  <th>投递次数</th>
                  <th>失败时间</th>
                </tr>
              </thead>
              <tbody>
                {diagnostic.deadLetters.map((deadLetter) => (
                  <tr key={deadLetter.messageId}>
                    <td>{queueJobKindLabel(deadLetter.kind)}</td>
                    <td>
                      <code title={deadLetter.runId}>{shortId(deadLetter.runId)}</code>
                    </td>
                    <td>
                      <strong>{deadLetter.errorCode}</strong>
                      <small className="table-secondary">{deadLetter.errorSummary}</small>
                    </td>
                    <td>{deadLetter.deliveryAttempts}</td>
                    <td>
                      <time dateTime={deadLetter.failedAt}>{formatDate(deadLetter.failedAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
