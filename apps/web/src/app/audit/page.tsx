import { Disclosure } from "@/components/ui/disclosure";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import {
  securityAuditActions,
  securityAuditCategories,
  type SecurityAuditCategory,
} from "@autoforge/contracts";
import { Download, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";
import { Button, DatetimeInput, Input, Select } from "@/components/ui";
import { SecurityAuditTable } from "@/components/security-audit-table";
import { RefreshAuditButton } from "@/components/refresh-audit-button";
import { presentAuditEvent } from "@/lib/audit-presentation";
import {
  hasPermissionInAnyScope,
  requireAuthorizedPageProjectScope,
  requirePageProjectScope,
} from "@/lib/auth";
import { getPlatformServices } from "@/lib/services";
import { selectableProjectIds, selectedProjectId } from "@/lib/selected-project";
import {
  platformDateTimeInputValue,
  platformDateTimeParameterToIso,
} from "@/lib/platform-date-time";

export const dynamic = "force-dynamic";
type AuditPageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AuditPage({ searchParams }: AuditPageProps) {
  const { identity } = await requirePageProjectScope("audit.read");
  const services = await getPlatformServices();
  const timeZone = services.configurationStore.read().web.timeZone;
  const values = await searchParams;
  const projects = await services.identities.listProjects(selectableProjectIds(identity));
  const projectId = await selectedProjectId(identity, projects, "audit.read");
  if (projectId) requireAuthorizedPageProjectScope(identity, "audit.read", projectId);
  const categoryValue = single(values.category);
  const category =
    categoryValue && Object.hasOwn(securityAuditCategories, categoryValue)
      ? (categoryValue as SecurityAuditCategory)
      : undefined;
  const filter = {
    ...(projectId ? { projectId } : {}),
    ...(category ? { category } : {}),
    ...optionalFilter("query", values.query),
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
      : Promise.resolve({ items: [] }),
    hasPermissionInAnyScope(identity, "runner.read")
      ? services.runnerControl.list(500)
      : Promise.resolve([]),
  ]);
  const userNames = new Map<string, string>([
    [identity.user.id, `${identity.user.displayName} · ${identity.user.username}`],
    ...userPage.items.map((user) => [user.id, `${user.displayName} · ${user.username}`] as const),
  ]);
  const runnerNames = new Map(runners.map((runner) => [runner.id, runner.name] as const));
  const actorNames = new Map([...userNames, ...runnerNames]);
  for (const event of events.items) {
    if (event.actorId && typeof event.details.actorName === "string")
      actorNames.set(event.actorId, event.details.actorName);
  }
  if (filter.actorId && !actorNames.has(filter.actorId))
    actorNames.set(filter.actorId, `指定人员 · ${filter.actorId.slice(0, 8)}`);
  const projectNames = new Map(projects.map((project) => [project.id, project.name] as const));
  const cursorTrail = auditCursorTrail(values.trail);
  const exportParameters = auditParameters(values, projectId, timeZone);
  exportParameters.set("maximumEvents", "5000");
  const advancedFilters = Boolean(filter.actorId || filter.recordedAfter || filter.recordedBefore);

  return (
    <section className={cn("page-stack audit-page", uiPatterns["page-stack"])}>
      <header
        className={cn(
          "page-header operations-page-header",
          uiPatterns["page-header"],
          pageStyles["operations-page-header"],
        )}
      >
        <div>
          <p className={cn("eyebrow", uiPatterns["eyebrow"])}>访问与变更追踪</p>
          <h1>安全审计</h1>
          <p>追踪重要数据变更、账号登录和访问安全事件。</p>
        </div>
        <div className={cn("button-row", uiPatterns["button-row"])}>
          <RefreshAuditButton />
          {hasPermissionInAnyScope(identity, "audit.export") ? (
            <LinkButton
              className={cn(
                "button button-secondary",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
              )}
              href={`/api/v1/audit-events/export?${exportParameters}`}
            >
              <Download size={16} />
              导出记录
            </LinkButton>
          ) : null}
        </div>
      </header>
      <Card
        as="section"
        className={cn(
          "content-card audit-card",
          uiPatterns["content-card"],
          pageStyles["audit-card"],
        )}
        aria-label="安全审计记录"
      >
        <form
          action="/audit"
          className={cn("audit-filter-panel", pageStyles["audit-filter-panel"])}
          method="get"
        >
          <div className={cn("audit-filter-grid", pageStyles["audit-filter-grid"])}>
            <label>
              搜索记录
              <div className={cn("audit-search-field", pageStyles["audit-search-field"])}>
                <Search size={16} aria-hidden="true" />
                <Input
                  aria-label="搜索审计记录"
                  defaultValue={single(values.query)}
                  maxLength={128}
                  name="query"
                  placeholder="搜索操作、人员或对象编号"
                />
              </div>
            </label>
            <label>
              审计分类
              <Select name="category" defaultValue={category ?? ""}>
                <option value="">全部分类</option>
                {Object.entries(securityAuditCategories).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              操作类型
              <Select name="action" defaultValue={single(values.action) ?? ""}>
                <option value="">全部操作</option>
                {securityAuditActions.map((entry) => (
                  <option key={entry.action} value={entry.action}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              操作结果
              <Select name="result" defaultValue={single(values.result) ?? ""}>
                <option value="">全部结果</option>
                <option value="succeeded">成功</option>
                <option value="rejected">已拒绝</option>
                <option value="failed">失败</option>
              </Select>
            </label>
          </div>
          <Disclosure
            header={
              <>
                <SlidersHorizontal size={15} />
                人员与时间筛选
              </>
            }
            className={cn("audit-advanced-filters", pageStyles["audit-advanced-filters"])}
            defaultOpen={advancedFilters}
          >
            <div className={cn("audit-advanced-grid", pageStyles["audit-advanced-grid"])}>
              <label>
                操作者
                <Select name="actorId" defaultValue={single(values.actorId) ?? ""}>
                  <option value="">全部操作者</option>
                  {[...actorNames].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
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
            </div>
          </Disclosure>
          <div className={cn("audit-filter-actions", pageStyles["audit-filter-actions"])}>
            <p>仅记录重要数据变更与访问安全事件</p>
            <div>
              <LinkButton
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
                href="/audit"
              >
                清空筛选
              </LinkButton>
              <Button type="submit" variant="primary">
                <Search size={16} />
                查询
              </Button>
            </div>
          </div>
        </form>
        <div className={cn("audit-list-heading", pageStyles["audit-list-heading"])}>
          <h2>
            <ShieldCheck size={18} />
            安全事件
          </h2>
          <span>本页 {events.items.length} 条</span>
        </div>
        <SecurityAuditTable
          events={events.items.map((event) =>
            presentAuditEvent(event, {
              users: userNames,
              runners: runnerNames,
              projects: projectNames,
            }),
          )}
          timeZone={timeZone}
        />
        <nav
          aria-label="审计事件分页"
          className={cn("audit-pagination", pageStyles["audit-pagination"])}
        >
          <span>第 {cursorTrail.length + 1} 页 · 每页最多 30 条</span>
          <div>
            {cursorTrail.length ? (
              <LinkButton
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
                href={`/audit?${previousPageParameters(values, projectId, cursorTrail, timeZone)}`}
              >
                上一页
              </LinkButton>
            ) : (
              <Button type="button" disabled>
                上一页
              </Button>
            )}
            {events.nextCursor ? (
              <LinkButton
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
                href={`/audit?${nextPageParameters(values, projectId, events.nextCursor, cursorTrail, timeZone)}`}
              >
                下一页
              </LinkButton>
            ) : (
              <Button type="button" disabled>
                下一页
              </Button>
            )}
          </div>
        </nav>
      </Card>
    </section>
  );
}

function single(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
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
  for (const key of ["query", "category", "actorId", "action", "resourceType", "result"] as const) {
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

const pageStyles = {
  "audit-advanced-filters":
    "[&_.ui-disclosure-label]:inline-flex [&_.ui-disclosure-label]:min-h-8 [&_.ui-disclosure-label]:items-center [&_.ui-disclosure-label]:gap-2 [&_.ui-disclosure-label]:list-none [&_.ui-disclosure-label::-webkit-details-marker]:hidden [&_.ui-disclosure-label]:w-fit [&_.ui-disclosure-label]:cursor-pointer [&_.ui-disclosure-label]:text-muted-foreground [&_.ui-disclosure-label]:text-sm",
  "audit-advanced-grid": "grid grid-cols-3 gap-3 pt-4",
  "audit-card":
    "[--audit-time-width:16%] [--audit-actor-width:18%] [--audit-action-width:21%] [--audit-result-width:10%] [--audit-detail-width:90px] overflow-hidden",
  "audit-filter-actions":
    "flex items-center justify-between gap-3 [&_>_p]:m-0 [&_>_p]:text-muted-foreground [&_>_p]:text-xs [&_>_div]:flex [&_>_div]:items-center [&_>_div]:gap-2",
  "audit-filter-grid":
    "grid grid-cols-[minmax(0,_1.6fr)_repeat(3,_minmax(0,_1fr))] gap-3 items-end max-[1281px]:grid-cols-2",
  "audit-filter-panel":
    "grid gap-4 p-5 border-b border-solid border-border [&_label]:grid [&_label]:min-w-0 [&_label]:gap-2 [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold",
  "audit-list-heading":
    "flex items-center justify-between gap-3 py-4 px-5 [&_>_span]:m-0 [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:m-0 [&_h2]:text-sm",
  "audit-pagination":
    "flex items-center justify-between gap-3 py-4 px-5 border-t border-solid border-border [&_>_span]:m-0 [&_>_span]:text-muted-foreground [&_>_span]:text-xs [&_>_div]:flex [&_>_div]:items-center [&_>_div]:gap-2",
  "audit-search-field":
    "relative block [&_.ui-input]:pl-9! [&_>_svg]:absolute [&_>_svg]:z-1 [&_>_svg]:left-3 [&_>_svg]:top-1/2 [&_>_svg]:[transform:translateY(-50%)] [&_>_svg]:pointer-events-none",
  "operations-page-header": "items-center",
} as const;
