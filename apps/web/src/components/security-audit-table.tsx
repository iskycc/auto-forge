"use client";

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
      <div className="audit-empty" role="status">
        <ShieldCheck size={28} />
        <strong>没有符合条件的审计记录</strong>
        <p>可调整筛选条件，或清空筛选查看最近的安全事件。</p>
      </div>
    );
  return (
    <div className="table-scroll">
      <table className="data-table security-audit-table">
        <colgroup>
          <col className="audit-time-column" />
          <col className="audit-actor-column" />
          <col className="audit-action-column" />
          <col className="audit-resource-column" />
          <col className="audit-result-column" />
          <col className="audit-detail-column" />
        </colgroup>
        <thead>
          <tr>
            <th>时间</th>
            <th>操作者</th>
            <th>操作</th>
            <th>涉及对象</th>
            <th>结果</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const isExpanded = expanded.has(event.id);
            const detailId = `audit-details-${event.id}`;
            return (
              <Fragment key={event.id}>
                <tr className="audit-event-row">
                  <td>
                    <time dateTime={event.recordedAt} title={`UTC：${event.recordedAt}`}>
                      {formatLocalDateTime(event.recordedAt, timeZone)}
                    </time>
                  </td>
                  <td>
                    <strong title={event.actorId}>{event.actor}</strong>
                  </td>
                  <td>
                    <strong>{event.action}</strong>
                    <small>{event.category}</small>
                  </td>
                  <td>
                    <strong>{event.resource}</strong>
                    <small>{event.project}</small>
                    {event.resourceId ? (
                      <small title={event.resourceId}>编号 {event.resourceId.slice(0, 8)}</small>
                    ) : null}
                  </td>
                  <td>
                    <span className={`audit-result audit-result-${event.result}`}>
                      {event.resultLabel}
                    </span>
                  </td>
                  <td>
                    <Button
                      type="button"
                      className="audit-detail-toggle"
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
                  </td>
                </tr>
                {isExpanded ? (
                  <tr className="audit-detail-row">
                    <td colSpan={6}>
                      <section
                        id={detailId}
                        aria-label={`${event.action}的事件详情`}
                        className="audit-event-details"
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
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
