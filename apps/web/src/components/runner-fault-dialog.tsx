"use client";
import { Dialog } from "@/components/ui/dialog";
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
    <Dialog
      open
      title={"执行机异常事件"}
      onClose={onClose}
      className={cn(
        "runner-update-dialog runner-fault-dialog",
        runnerFaultDialogStyles["runner-update-dialog"],
        runnerFaultDialogStyles["runner-fault-dialog"],
      )}
      backdropClassName="runner-update-overlay"
    >
      <header
        className={cn("runner-update-titlebar", runnerFaultDialogStyles["runner-update-titlebar"])}
      >
        <span>
          <AlertTriangle size={16} aria-hidden="true" />
          <strong>执行机异常事件</strong>
          <small>仅统计会触发自动重调度的非用例异常</small>
        </span>
        <Button aria-label="关闭" onClick={onClose} type="button">
          <X size={16} />
        </Button>
      </header>
      <div className={cn("runner-update-body", runnerFaultDialogStyles["runner-update-body"])}>
        {incidents.length === 0 ? (
          <div className={cn("inline-empty", uiPatterns["inline-empty"])}>
            当前批次没有执行机异常事件。
          </div>
        ) : (
          <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
            <Table
              className={cn(
                "data-table runner-fault-table",
                uiPatterns["data-table"],
                runnerFaultDialogStyles["runner-fault-table"],
              )}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>执行机</TableHead>
                  <TableHead>异常类型</TableHead>
                  <TableHead>错误描述</TableHead>
                  <TableHead>次数</TableHead>
                  <TableHead>影响用例</TableHead>
                  <TableHead>最近发生</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {incidents.map((incident) => (
                  <TableRow key={incident.key}>
                    <TableCell title={incident.runnerId}>{runnerName(incident.runnerId)}</TableCell>
                    <TableCell>
                      <code>{incident.resultCode}</code>
                    </TableCell>
                    <TableCell title={incident.summary}>{incident.summary}</TableCell>
                    <TableCell>{incident.count}</TableCell>
                    <TableCell title={incident.caseNames.join("、") || "请按异常状态筛选用例"}>
                      {incident.caseNames.join("、") || "按异常筛选查看"}
                    </TableCell>
                    <TableCell>
                      <time title={`UTC ${incident.lastOccurredAt}`}>
                        {formatLocalDateTime(incident.lastOccurredAt)}
                      </time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Dialog>
  );
}

const runnerFaultDialogStyles = {
  "runner-fault-dialog": "w-[min(1180px,_calc(100vw_-_64px))]",
  "runner-fault-table":
    "[table-layout:fixed] min-w-[980px] [&_th:nth-child(1)]:w-[14%] [&_th:nth-child(2)]:w-[20%] [&_th:nth-child(3)]:w-[25%] [&_th:nth-child(4)]:w-[7%] [&_th:nth-child(5)]:w-[20%] [&_th:nth-child(6)]:w-[14%] [&_td]:overflow-hidden [&_td]:whitespace-nowrap [&_td]:text-ellipsis",
  "runner-update-body": "grid gap-4 p-4.5 overflow-y-auto",
  "runner-update-dialog":
    "grid w-[min(640px,_92vw)] max-h-[86vh] [grid-template-rows:auto_minmax(0,_1fr)] overflow-hidden border border-solid border-border rounded-xl bg-card shadow-lg",

  "runner-update-titlebar":
    "flex items-center justify-between gap-3 py-3.5 px-4.5 border-b border-solid border-border [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-2.5 [&_small]:text-muted-foreground",
} as const;
