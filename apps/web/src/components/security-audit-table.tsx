"use client";
import { EmptyState } from "@/components/ui/empty-state";

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

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import type { AuditEventPresentation } from "@/lib/audit-presentation";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { Button } from "./ui";

export function SecurityAuditTable({
  events,
  timeZone,
}: {
  events: AuditEventPresentation[];
  timeZone: string;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  if (!events.length)
    return (
      <EmptyState
        className={cn("audit-empty", securityAuditTableStyles["audit-empty"])}
        role="status"
      >
        <ShieldCheck size={28} />
        <strong>没有符合条件的审计记录</strong>
        <p>可调整筛选条件，或清空筛选查看最近的安全事件。</p>
      </EmptyState>
    );
  return (
    <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
      <Table
        className={cn(
          "data-table security-audit-table",
          uiPatterns["data-table"],
          securityAuditTableStyles["security-audit-table"],
        )}
      >
        <colgroup>
          <col className={"audit-time-column"} />
          <col className={"audit-actor-column"} />
          <col className={"audit-action-column"} />
          <col className={"audit-resource-column"} />
          <col className={"audit-result-column"} />
          <col className={"audit-detail-column"} />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>时间</TableHead>
            <TableHead>操作者</TableHead>
            <TableHead>操作</TableHead>
            <TableHead>涉及对象</TableHead>
            <TableHead>结果</TableHead>
            <TableHead>详情</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => {
            const isExpanded = expanded.has(event.id);
            const detailId = `audit-details-${event.id}`;
            return (
              <Fragment key={event.id}>
                <TableRow className={"audit-event-row"}>
                  <TableCell>
                    <time dateTime={event.recordedAt} title={`UTC：${event.recordedAt}`}>
                      {formatLocalDateTime(event.recordedAt, timeZone)}
                    </time>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn("audit-actor", securityAuditTableStyles["audit-actor"])}
                      title={`${event.actor} · ${event.actorId ?? ""}`}
                    >
                      <strong>{event.actor.split(" · ")[0]}</strong>
                      {event.actor.includes(" · ") ? (
                        <small>{event.actor.split(" · ").slice(1).join(" · ")}</small>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <strong>{event.action}</strong>
                    <small>{event.category}</small>
                  </TableCell>
                  <TableCell>
                    <strong>{event.resource}</strong>
                    <small>{event.project}</small>
                    {event.resourceId ? (
                      <small title={event.resourceId}>编号 …{event.resourceId.slice(-12)}</small>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        securityAuditTableStyles["audit-result"],
                        `audit-result audit-result audit-result-${event.result}`,
                      )}
                    >
                      {event.resultLabel}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      className={"audit-detail-toggle"}
                      aria-expanded={isExpanded}
                      aria-controls={detailId}
                      aria-label={`${isExpanded ? "收起" : "查看"}事件详情：${event.action}`}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(event.id)) next.delete(event.id);
                          else next.add(event.id);
                          return next;
                        })
                      }
                    >
                      {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      {isExpanded ? "收起" : "查看"}
                    </Button>
                  </TableCell>
                </TableRow>
                {isExpanded ? (
                  <TableRow
                    className={cn("audit-detail-row", securityAuditTableStyles["audit-detail-row"])}
                  >
                    <TableCell colSpan={6}>
                      <section
                        id={detailId}
                        aria-label={`${event.action}的事件详情`}
                        className={cn(
                          "audit-event-details",
                          securityAuditTableStyles["audit-event-details"],
                        )}
                      >
                        <h3>{event.action}</h3>
                        <dl>
                          {event.details.map((detail, index) => (
                            <div key={`${detail.label}-${index}`}>
                              <dt>{detail.label}</dt>
                              <dd>{detail.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </section>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const securityAuditTableStyles = {
  "audit-actor":
    "block min-w-0 [&_:is(strong,_small)]:block [&_:is(strong,_small)]:overflow-hidden [&_:is(strong,_small)]:text-ellipsis [&_:is(strong,_small)]:whitespace-nowrap",
  "audit-detail-row": "[&_>_td]:bg-muted",
  "audit-empty":
    "grid justify-items-center gap-3 [padding:calc(20px_*_3)_20px] text-muted-foreground [&_strong]:text-foreground [&_p]:m-0 [&_p]:text-sm",
  "audit-event-details":
    "p-2 [&_h3]:[margin:0_0_16px] [&_h3]:text-sm [&_dl]:grid [&_dl]:grid-cols-2 [&_dl]:gap-[12px_20px] [&_dl]:m-0 [&_dl_>_div]:min-w-0 [&_dt]:text-muted-foreground [&_dt]:text-xs [&_dd]:[margin:calc(8px_/_2)_0_0] [&_dd]:text-sm [&_dd]:whitespace-pre-wrap [&_dd]:[overflow-wrap:anywhere]",
  "audit-result":
    "inline-flex items-center min-h-[calc(8px_*_3)] rounded-full py-0 px-2 text-xs font-semibold whitespace-nowrap [&.audit-result-succeeded]:bg-success/10 [&.audit-result-succeeded]:text-success [&.audit-result-rejected]:bg-warning/10 [&.audit-result-rejected]:text-warning [&.audit-result-failed]:bg-destructive/10 [&.audit-result-failed]:text-destructive",
  "security-audit-table":
    "w-full min-w-0 [table-layout:fixed] [&_.audit-time-column]:w-[var(--audit-time-width)] [&_.audit-actor-column]:w-[var(--audit-actor-width)] [&_.audit-action-column]:w-[var(--audit-action-width)] [&_.audit-result-column]:w-[var(--audit-result-width)] [&_.audit-detail-column]:w-[var(--audit-detail-width)] [&_th]:p-3 [&_th]:[vertical-align:top] [&_th]:whitespace-normal [&_th]:[overflow-wrap:anywhere] [&_td]:p-3 [&_td]:[vertical-align:top] [&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere] [&_td]:px-3 [&_td_strong]:block [&_td_strong]:text-sm [&_td_strong]:font-semibold [&_td_small]:block [&_td_small]:[margin-top:calc(8px_/_2)] [&_td_small]:text-muted-foreground [&_td_small]:text-xs [&_time]:block [&_time]:[margin-top:calc(8px_/_2)] [&_time]:text-muted-foreground [&_time]:text-xs [&_time]:whitespace-normal [&_time]:leading-[1.6] [&_.audit-detail-toggle]:min-h-[calc(8px_*_4)] [&_.audit-detail-toggle]:[padding:calc(8px_/_2)_8px] [&_.audit-detail-toggle]:gap-[calc(8px_/_2)] [&_.audit-detail-toggle]:text-xs",
} as const;
