import { Button, DatetimeInput, Input, Select } from "@/components/ui";

import { Download, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";

import {
  hasPermissionInAnyScope,
  requireAuthorizedPageProjectScope,
  requirePageProjectScope,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { formatLocalDateTime } from "@/lib/run-batch-presentation";
import { selectableProjectIds, selectedProjectId } from "@/lib/selected-project";
import {
  platformDateTimeInputValue,
  platformDateTimeParameterToIso,
} from "@/lib/platform-date-time";

export const dynamic = "force-dynamic";

type AuditPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AuditPage({ searchParams }: AuditPageProps) {
  const { identity } = await requirePageProjectScope("audit.read");
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
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
    ...optionalDate("recordedAfter", values.recordedAfter, timeZone),
    ...optionalDate("recordedBefore", values.recordedBefore, timeZone),
    ...optionalFilter("cursor", values.cursor),
    limit: 30,
  };
  const [events, userPage, runners] = await Promise.all([
    services.identityAccess.listAudit(identity, filter),
    hasPermissionInAnyScope(identity, "user.read")
      ? services.identityAccess.listUsers(identity, { limit: 100 })
      : Promise.resolve({ items: [], nextCursor: undefined }),
    hasPermissionInAnyScope(identity, "runner.read")
      ? services.runnerControl.list(500)
      : Promise.resolve([]),
  ]);
  const userNames = new Map([
    [identity.user.id, `${identity.user.displayName} · ${identity.user.username}`],
    ...userPage.items.map((user) => [user.id, `${user.displayName} · ${user.username}`] as const),
  ]);
  const runnerNames = new Map(runners.map((runner) => [runner.id, runner.name] as const));
  const projectNames = new Map(projects.map((project) => [project.id, project.name] as const));
  const cursorTrail = auditCursorTrail(values.trail);
  const exportParameters = auditParameters(values, projectId, timeZone);
  exportParameters.set("maximumEvents", "5000");

  return (
    <section className="page-stack">
      <header className="page-header operations-page-header">
        <div>
          <p className="eyebrow">Audit</p>
          <h1>安全审计</h1>
          <p>按操作者、动作、资源、项目、结果和时间查询持久审计证据；原始 UTC 值可悬停查看。</p>
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

      <form action="/audit" className="content-card audit-filter-panel" method="get">
        <label>
          操作者
          <Input
            defaultValue={single(values.actorId)}
            list="audit-actor-options"
            name="actorId"
            placeholder="选择名称或粘贴 ID"
          />
          <datalist id="audit-actor-options">
            {[...userNames].map(([id, name]) => (
              <option key={`user:${id}`} label={name} value={id} />
            ))}
            {[...runnerNames].map(([id, name]) => (
              <option key={`runner:${id}`} label={`${name} · Runner`} value={id} />
            ))}
          </datalist>
        </label>
        <label>
          动作
          <Input
            defaultValue={single(values.action)}
            list="audit-action-options"
            name="action"
            placeholder="选择常用动作或输入动作码"
          />
          <datalist id="audit-action-options">
            {auditActionOptions(events.items.map((event) => event.action)).map((action) => (
              <option key={action} value={action} />
            ))}
          </datalist>
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
          <DatetimeInput
            defaultValue={dateInputValue(values.recordedAfter, timeZone)}
            name="recordedAfter"
          />
        </label>
        <label>
          结束时间
          <DatetimeInput
            defaultValue={dateInputValue(values.recordedBefore, timeZone)}
            name="recordedBefore"
          />
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
          <span className="table-count">本页 {events.items.length} 条</span>
        </div>
        {events.items.length === 0 ? (
          <div className="inline-empty">当前筛选条件下没有审计事件。</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
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
                      <time dateTime={event.recordedAt} title={`UTC：${event.recordedAt}`}>
                        {formatLocalDateTime(event.recordedAt, timeZone)}
                      </time>
                    </td>
                    <td>
                      <code>{event.action}</code>
                    </td>
                    <td>
                      <span className={`audit-result audit-result-${event.result}`}>
                        {auditResultLabel(event.result)}
                      </span>
                    </td>
                    <td title={event.actorId}>
                      {actorLabel(event.actorType, event.actorId, userNames, runnerNames)}
                    </td>
                    <td title={event.resourceId}>
                      {resourceLabel(event.resourceType, event.resourceId)}
                    </td>
                    <td title={event.projectId}>
                      {event.projectId
                        ? (projectNames.get(event.projectId) ?? shortId(event.projectId))
                        : "系统"}
                    </td>
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
        {cursorTrail.length > 0 || events.nextCursor ? (
          <nav aria-label="审计事件分页" className="pagination">
            {cursorTrail.length > 0 ? (
              <Link
                className="button button-secondary"
                href={`/audit?${previousPageParameters(values, projectId, cursorTrail, timeZone)}`}
              >
                上一页
              </Link>
            ) : (
              <span />
            )}
            {events.nextCursor ? (
              <Link
                className="button button-secondary"
                href={`/audit?${nextPageParameters(values, projectId, events.nextCursor, cursorTrail, timeZone)}`}
              >
                下一页
              </Link>
            ) : null}
          </nav>
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
  timeZone: string,
): Partial<Record<Key, string>> {
  const normalized = single(value);
  if (!normalized) return {};
  const timestamp = platformDateTimeParameterToIso(normalized, timeZone);
  return timestamp ? ({ [key]: timestamp } as Partial<Record<Key, string>>) : {};
}

function dateInputValue(value: string | string[] | undefined, timeZone: string): string {
  const timestamp = single(value);
  const iso = timestamp ? platformDateTimeParameterToIso(timestamp, timeZone) : undefined;
  return platformDateTimeInputValue(iso, timeZone);
}

function auditParameters(
  values: Record<string, string | string[] | undefined>,
  projectId: string | undefined,
  timeZone: string,
): URLSearchParams {
  const parameters = new URLSearchParams();
  for (const key of ["actorId", "action", "resourceType", "result"] as const) {
    const value = single(values[key]);
    if (value) parameters.set(key, value);
  }
  for (const key of ["recordedAfter", "recordedBefore"] as const) {
    const value = optionalDate(key, values[key], timeZone)[key];
    if (value) parameters.set(key, value);
  }
  if (projectId) parameters.set("projectId", projectId);
  return parameters;
}

function nextPageParameters(
  values: Record<string, string | string[] | undefined>,
  projectId: string | undefined,
  cursor: string,
  trail: readonly string[],
  timeZone: string,
): URLSearchParams {
  const parameters = auditParameters(values, projectId, timeZone);
  parameters.set("cursor", cursor);
  parameters.set("trail", JSON.stringify([...trail, single(values.cursor) ?? ""]));
  return parameters;
}

function previousPageParameters(
  values: Record<string, string | string[] | undefined>,
  projectId: string | undefined,
  trail: readonly string[],
  timeZone: string,
): URLSearchParams {
  const parameters = auditParameters(values, projectId, timeZone);
  const previousCursor = trail.at(-1);
  if (previousCursor) parameters.set("cursor", previousCursor);
  const remainingTrail = trail.slice(0, -1);
  if (remainingTrail.length > 0) parameters.set("trail", JSON.stringify(remainingTrail));
  return parameters;
}

function auditCursorTrail(value: string | string[] | undefined): string[] {
  const raw = single(value);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string" && item.length <= 512)
          .slice(-20)
      : [];
  } catch {
    return [];
  }
}

function actorLabel(
  actorType: "user" | "runner" | "system",
  actorId: string | undefined,
  userNames: ReadonlyMap<string, string>,
  runnerNames: ReadonlyMap<string, string>,
): string {
  if (!actorId) return actorType === "system" ? "系统" : actorType === "runner" ? "Runner" : "用户";
  if (actorType === "user") return userNames.get(actorId) ?? `用户 · ${shortId(actorId)}`;
  if (actorType === "runner") return runnerNames.get(actorId) ?? `Runner · ${shortId(actorId)}`;
  return `系统 · ${shortId(actorId)}`;
}

function resourceLabel(resourceType: string, resourceId: string | undefined): string {
  const typeLabel: Record<string, string> = {
    user: "用户",
    runner: "执行机",
    project: "项目",
    case_suite: "用例任务",
    run_batch: "执行批次",
    session: "会话",
  };
  const label = typeLabel[resourceType] ?? resourceType;
  return resourceId ? `${label} · ${shortId(resourceId)}` : label;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function auditActionOptions(currentActions: readonly string[]): string[] {
  return [
    ...new Set([
      ...currentActions,
      "auth.login",
      "auth.logout",
      "runner.register",
      "runner.update",
      "run_batch.create",
      "run_batch.cancel",
    ]),
  ].sort();
}
