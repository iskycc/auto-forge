import { Button, DatetimeInput, Input, Select } from "@/components/ui";

import { Download, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { SectionTabs } from "@/components/section-tabs";
import {
  hasPermissionInAnyScope,
  requireAuthorizedPageProjectScope,
  requirePageProjectScope,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { selectableProjectIds, selectedProjectId } from "@/lib/selected-project";

export const dynamic = "force-dynamic";

type AuditPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AuditPage({ searchParams }: AuditPageProps) {
  const { identity } = await requirePageProjectScope("audit.read");
  const services = await getPlatformServices();
  const values = await searchParams;
  const projects = await services.identities
    .listProjects(selectableProjectIds(identity))
    .catch(() => []);
  const projectId = await selectedProjectId(identity, projects, "audit.read");
  if (projectId) requireAuthorizedPageProjectScope(identity, "audit.read", projectId);
  const filter = {
    ...(projectId ? { projectId } : {}),
    ...optionalFilter("actorId", values.actorId),
    ...optionalFilter("action", values.action),
    ...optionalFilter("resourceType", values.resourceType),
    ...optionalResult(values.result),
    ...optionalDate("recordedAfter", values.recordedAfter),
    ...optionalDate("recordedBefore", values.recordedBefore),
    ...optionalFilter("cursor", values.cursor),
    limit: 100,
  };
  const events = await services.identityAccess.listAudit(identity, filter);
  const exportParameters = auditParameters(values, projectId);
  exportParameters.set("maximumEvents", "5000");
  const canReadAutomation =
    hasPermissionInAnyScope(identity, "case_suite.read") ||
    hasPermissionInAnyScope(identity, "ldap.read");

  return (
    <section className="page-stack">
      <header className="page-header operations-page-header">
        <div>
          <p className="eyebrow">Audit</p>
          <h1>安全审计</h1>
          <p>按操作者、动作、资源、项目、结果和 UTC 时间查询持久审计证据。</p>
        </div>
        {hasPermissionInAnyScope(identity, "audit.export") ? (
          <a
            className="button button-secondary"
            href={`/api/v1/audit-events/export?${exportParameters}`}
          >
            <Download size={16} /> 导出 CSV
          </a>
        ) : null}
      </header>

      <SectionTabs
        label="运维审计"
        tabs={[
          ...(canReadAutomation
            ? [{ href: "/settings/automation", label: "运维计划", active: false }]
            : []),
          { href: "/audit", label: "安全审计", active: true },
        ]}
      />

      <form action="/audit" className="content-card audit-filter-panel" method="get">
        <label>
          操作者 ID
          <Input defaultValue={single(values.actorId)} name="actorId" />
        </label>
        <label>
          动作
          <Input defaultValue={single(values.action)} name="action" placeholder="例如 auth.login" />
        </label>
        <label>
          资源类型
          <Input defaultValue={single(values.resourceType)} name="resourceType" />
        </label>
        <label>
          结果
          <Select defaultValue={single(values.result) ?? ""} name="result">
            <option value="">全部</option>
            <option value="succeeded">成功</option>
            <option value="rejected">拒绝</option>
            <option value="failed">失败</option>
          </Select>
        </label>
        <label>
          开始时间
          <DatetimeInput defaultValue={single(values.recordedAfter)} name="recordedAfter" />
        </label>
        <label>
          结束时间
          <DatetimeInput defaultValue={single(values.recordedBefore)} name="recordedBefore" />
        </label>
        <Button className="button button-primary" type="submit">
          <Search size={16} /> 查询
        </Button>
      </form>

      <section className="card table-card audit-table-card">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Evidence</span>
            <h2>审计事件</h2>
          </div>
          <ShieldCheck size={21} aria-hidden="true" />
        </div>
        {events.items.length === 0 ? (
          <div className="inline-empty">当前筛选条件下没有审计事件。</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>UTC 时间</th>
                  <th>动作</th>
                  <th>结果</th>
                  <th>操作者</th>
                  <th>资源</th>
                  <th>项目</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {events.items.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <time dateTime={event.recordedAt}>{event.recordedAt}</time>
                    </td>
                    <td>
                      <code>{event.action}</code>
                    </td>
                    <td>
                      <span className={`audit-result audit-result-${event.result}`}>
                        {auditResultLabel(event.result)}
                      </span>
                    </td>
                    <td>{event.actorId ?? event.actorType}</td>
                    <td>
                      {event.resourceType}
                      {event.resourceId ? ` · ${event.resourceId}` : ""}
                    </td>
                    <td>{event.projectId ?? "系统"}</td>
                    <td>
                      <details>
                        <summary>查看</summary>
                        <pre>{JSON.stringify(event.details, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.nextCursor ? (
          <Link
            className="button button-secondary"
            href={`/audit?${nextPageParameters(values, projectId, events.nextCursor)}`}
          >
            下一页
          </Link>
        ) : null}
      </section>
    </section>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function auditResultLabel(result: "succeeded" | "rejected" | "failed"): string {
  return result === "succeeded" ? "成功" : result === "rejected" ? "拒绝" : "失败";
}

function optionalFilter<Key extends string>(
  key: Key,
  value: string | string[] | undefined,
): Partial<Record<Key, string>> {
  const normalized = single(value);
  return normalized ? ({ [key]: normalized } as Partial<Record<Key, string>>) : {};
}

function optionalResult(value: string | string[] | undefined): {
  result?: "succeeded" | "rejected" | "failed";
} {
  const normalized = single(value);
  return normalized === "succeeded" || normalized === "rejected" || normalized === "failed"
    ? { result: normalized }
    : {};
}

function optionalDate<Key extends "recordedAfter" | "recordedBefore">(
  key: Key,
  value: string | string[] | undefined,
): Partial<Record<Key, string>> {
  const normalized = single(value);
  if (!normalized) return {};
  const timestamp = new Date(normalized);
  return Number.isNaN(timestamp.getTime())
    ? {}
    : ({ [key]: timestamp.toISOString() } as Partial<Record<Key, string>>);
}

function auditParameters(
  values: Record<string, string | string[] | undefined>,
  projectId?: string,
): URLSearchParams {
  const parameters = new URLSearchParams();
  for (const key of ["actorId", "action", "resourceType", "result"] as const) {
    const value = single(values[key]);
    if (value) parameters.set(key, value);
  }
  for (const key of ["recordedAfter", "recordedBefore"] as const) {
    const value = optionalDate(key, values[key])[key];
    if (value) parameters.set(key, value);
  }
  if (projectId) parameters.set("projectId", projectId);
  return parameters;
}

function nextPageParameters(
  values: Record<string, string | string[] | undefined>,
  projectId: string | undefined,
  cursor: string,
): URLSearchParams {
  const parameters = auditParameters(values, projectId);
  parameters.set("cursor", cursor);
  return parameters;
}
