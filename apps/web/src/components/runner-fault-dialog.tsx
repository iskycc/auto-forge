"use client";

import { AlertTriangle, X } from "lucide-react";

import { Button } from "@/components/ui";
import type { RunnerFaultIncident } from "@/lib/runner-fault-incidents";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";

export function RunnerFaultDialog({
  incidents,
  runnerName,
  onClose,
}: {
  incidents: readonly RunnerFaultIncident[];
  runnerName: (runnerId: string) => string;
  onClose: () => void;
}) {
  return (
    <div className="runner-update-overlay" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="执行机异常事件"
        aria-modal="true"
        className="runner-update-dialog runner-fault-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="runner-update-titlebar">
          <span>
            <AlertTriangle size={16} aria-hidden="true" />
            <strong>执行机异常事件</strong>
            <small>仅统计会触发自动重调度的非用例异常</small>
          </span>
          <Button aria-label="关闭" onClick={onClose} type="button">
            <X size={16} />
          </Button>
        </header>
        <div className="runner-update-body">
          {incidents.length === 0 ? (
            <div className="inline-empty">当前批次没有执行机异常事件。</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table runner-fault-table">
                <thead>
                  <tr>
                    <th>执行机</th>
                    <th>异常类型</th>
                    <th>错误描述</th>
                    <th>次数</th>
                    <th>影响用例</th>
                    <th>最近发生</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((incident) => (
                    <tr key={incident.key}>
                      <td title={incident.runnerId}>{runnerName(incident.runnerId)}</td>
                      <td>
                        <code>{incident.resultCode}</code>
                      </td>
                      <td title={incident.summary}>{incident.summary}</td>
                      <td>{incident.count}</td>
                      <td title={incident.caseNames.join("、")}>{incident.caseNames.join("、")}</td>
                      <td>
                        <time title={`UTC ${incident.lastOccurredAt}`}>
                          {formatLocalDateTime(incident.lastOccurredAt)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
