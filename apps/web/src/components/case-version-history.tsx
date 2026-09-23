"use client";
import { Notice } from "@/components/ui/notice";

import { Badge } from "@/components/ui/badge";

import { Disclosure } from "@/components/ui/disclosure";

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

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import {
  apiErrorSchema,
  testNgClassCandidateSchema,
  type TestNgClassCandidate,
} from "@autoforge/contracts";
import type { CaseVersion } from "@autoforge/domain";
import { GitCompareArrows, History, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { LinkButton } from "@/components/ui/link-button";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button, Select } from "@/components/ui";
import { formatMethodSignature } from "@/lib/jvm-signature";
import { useConfirm } from "@/components/ui-feedback";

const CHANGE_REASON_LABELS: Record<string, string> = {
  "source.import": "来源导入",
  "source.sync": "权威来源同步",
  "manual.restore": "手动恢复",
};

export function CaseVersionHistory({
  caseDefinitionId,
  versions,
  currentVersion,
  canManage,
  canReadSource,
  onChanged,
}: {
  caseDefinitionId: string;
  versions: CaseVersion[];
  currentVersion: number;
  canManage: boolean;
  canReadSource: boolean;
  onChanged?: () => void;
}) {
  const router = useRouter();
  const confirmAction = useConfirm();
  const orderedVersions = useMemo(
    () => [...versions].sort((left, right) => right.version - left.version),
    [versions],
  );
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leftVersion, setLeftVersion] = useState(currentVersion);
  const [rightVersion, setRightVersion] = useState(
    orderedVersions.find((version) => version.version !== currentVersion)?.version ??
      currentVersion,
  );
  const currentSnapshot = snapshotFor(orderedVersions, currentVersion);
  const comparison = compareSnapshots(
    snapshotFor(orderedVersions, leftVersion),
    snapshotFor(orderedVersions, rightVersion),
  );

  async function restore(version: number): Promise<void> {
    const targetSnapshot = snapshotFor(orderedVersions, version);
    const changes = compareSnapshots(currentSnapshot, targetSnapshot);
    const impact =
      changes.length > 0 ? `将发生以下变更：${changes.join("；")}` : "快照内容没有可见差异。";
    if (
      !(await confirmAction({
        title: `从 v${version} 恢复用例`,
        description: `${impact} 系统会据此创建一个新的不可变版本。`,
        confirmLabel: "创建新版本",
      }))
    )
      return;

    setPendingVersion(version);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/case-definitions/${encodeURIComponent(caseDefinitionId)}/versions/${version}/restore`,
        { method: "POST" },
      );
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const parsed = apiErrorSchema.safeParse(payload);
        throw new Error(
          parsed.success ? parsed.data.error.message : `请求失败（HTTP ${response.status}）。`,
        );
      }
      onChanged?.();
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "恢复版本失败。");
    } finally {
      setPendingVersion(null);
    }
  }

  return (
    <div className={cn("settings-stack", uiPatterns["settings-stack"])}>
      {error ? (
        <div
          className={cn("inline-feedback", caseVersionHistoryStyles["inline-feedback"])}
          role="alert"
        >
          {error}
        </div>
      ) : null}
      <section
        className={cn("version-comparison", caseVersionHistoryStyles["version-comparison"])}
        aria-labelledby="version-comparison-title"
      >
        <div className={cn("section-heading", uiPatterns["section-heading"])}>
          <div>
            <span className={cn("eyebrow", uiPatterns["eyebrow"])}>Diff</span>
            <h3 id="version-comparison-title">指定版本差异</h3>
          </div>
          <GitCompareArrows size={19} aria-hidden="true" />
        </div>
        <div
          className={cn("settings-inline-form", caseVersionHistoryStyles["settings-inline-form"])}
        >
          <label>
            基准版本
            <Select
              onChange={(event) => setLeftVersion(Number(event.currentTarget.value))}
              value={leftVersion}
            >
              {orderedVersions.map(versionOption)}
            </Select>
          </label>
          <label>
            对比版本
            <Select
              onChange={(event) => setRightVersion(Number(event.currentTarget.value))}
              value={rightVersion}
            >
              {orderedVersions.map(versionOption)}
            </Select>
          </label>
        </div>
        {comparison.length > 0 ? (
          <ul className={cn("version-diff-list", caseVersionHistoryStyles["version-diff-list"])}>
            {comparison.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        ) : (
          <p className={cn("muted", uiPatterns["muted"])}>两个版本的可执行快照一致。</p>
        )}
      </section>

      <div className={cn("table-scroll", uiPatterns["table-scroll"])}>
        <Table className={cn("data-table", uiPatterns["data-table"])}>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>变更原因</TableHead>
              <TableHead>操作人</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>内容与引用</TableHead>
              {canManage ? <TableHead>操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {orderedVersions.map((version) => {
              const snapshot = parseSnapshot(version.snapshot);
              const previous = snapshotFor(orderedVersions, version.version - 1);
              const adjacentChanges = compareSnapshots(previous, snapshot);
              return (
                <TableRow key={version.id}>
                  <TableCell>
                    <strong>v{version.version}</strong>
                    {version.version === currentVersion ? (
                      <Badge
                        className={cn(
                          "tag current-version-tag",
                          uiPatterns["tag"],
                          caseVersionHistoryStyles["current-version-tag"],
                        )}
                      >
                        当前
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {CHANGE_REASON_LABELS[version.changeReason] ?? version.changeReason}
                  </TableCell>
                  <TableCell>
                    {version.createdBy ?? (
                      <span className={cn("muted", uiPatterns["muted"])}>—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time>
                  </TableCell>
                  <TableCell>
                    <Disclosure
                      header={<>查看快照与相邻差异</>}
                      headerClassName={cn(
                        "role-action-summary",
                        caseVersionHistoryStyles["role-action-summary"],
                      )}
                    >
                      {snapshot ? (
                        <div
                          className={cn(
                            "version-snapshot-details",
                            caseVersionHistoryStyles["version-snapshot-details"],
                          )}
                        >
                          <p>
                            <strong>JAR 来源：</strong>
                            {canReadSource ? (
                              <Link href={`/case-sources/${encodeURIComponent(version.sourceId)}`}>
                                {version.sourceId}
                              </Link>
                            ) : (
                              <code>{version.sourceId}</code>
                            )}
                          </p>
                          <p>
                            <strong>源码条目：</strong>
                            {snapshot.source?.entryPath ?? "字节码快照（无源码条目）"}
                          </p>
                          {snapshot.source ? (
                            <p>
                              <strong>源码 SHA-256：</strong>
                              <code>{snapshot.source.sha256}</code>
                            </p>
                          ) : null}
                          <p>
                            <strong>相邻版本差异：</strong>
                            {previous
                              ? adjacentChanges.join("；") || "无可执行内容差异"
                              : "首个版本，无相邻基准"}
                          </p>
                          <pre
                            className={cn(
                              "source-code-viewer",
                              caseVersionHistoryStyles["source-code-viewer"],
                            )}
                            tabIndex={0}
                          >
                            <code>
                              {JSON.stringify(snapshotForPresentation(snapshot), null, 2)}
                            </code>
                          </pre>
                        </div>
                      ) : (
                        <Notice tone="error" className={cn("auth-error", uiPatterns["auth-error"])}>
                          该历史快照格式无效，不能展示或恢复。
                        </Notice>
                      )}
                      <LinkButton
                        className={cn(
                          "button button-secondary",
                          uiPatterns["button"],
                          uiPatterns["button-secondary"],
                        )}
                        href={`/run-batches?caseDefinitionId=${encodeURIComponent(caseDefinitionId)}`}
                      >
                        查看该用例关联执行
                      </LinkButton>
                    </Disclosure>
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      {version.version === currentVersion ? (
                        <span className={cn("muted", uiPatterns["muted"])}>—</span>
                      ) : (
                        <Button
                          className={cn("secondary-button", uiPatterns["secondary-button"])}
                          disabled={pendingVersion !== null || !snapshot}
                          onClick={() => void restore(version.version)}
                          type="button"
                        >
                          {pendingVersion === version.version ? (
                            <LoaderCircle className={cn("spin", uiPatterns["spin"])} size={14} />
                          ) : (
                            <History size={14} />
                          )}
                          从该版本创建
                        </Button>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function parseSnapshot(value: unknown): TestNgClassCandidate | null {
  const parsed = testNgClassCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function snapshotFor(versions: CaseVersion[], version: number): TestNgClassCandidate | null {
  return parseSnapshot(versions.find((candidate) => candidate.version === version)?.snapshot);
}

function compareSnapshots(
  before: TestNgClassCandidate | null,
  after: TestNgClassCandidate | null,
): string[] {
  if (!before || !after) return before === after ? [] : ["其中一个版本的快照不可用"];
  const changes: string[] = [];
  addSetDiff(changes, "分组", before.groups, after.groups);
  addRecordDiff(changes, "参数", before.parameters ?? {}, after.parameters ?? {});
  const beforeMethods = new Map(before.methods.map((method) => [methodKey(method), method]));
  const afterMethods = new Map(after.methods.map((method) => [methodKey(method), method]));
  addMethodDiff(changes, beforeMethods, afterMethods);
  for (const [key, beforeMethod] of beforeMethods) {
    const afterMethod = afterMethods.get(key);
    if (!afterMethod) continue;
    const label = methodLabel(beforeMethod);
    if (beforeMethod.enabled !== afterMethod.enabled) {
      changes.push(
        `${label}：${beforeMethod.enabled ? "启用" : "停用"} → ${afterMethod.enabled ? "启用" : "停用"}`,
      );
    }
    addSetDiff(changes, `${label} 分组`, beforeMethod.groups, afterMethod.groups);
    addRecordDiff(
      changes,
      `${label} 参数`,
      beforeMethod.parameters ?? {},
      afterMethod.parameters ?? {},
    );
  }
  if (before.enabled !== after.enabled) {
    changes.push(
      `用例状态：${before.enabled ? "启用" : "停用"} → ${after.enabled ? "启用" : "停用"}`,
    );
  }
  return changes;
}

function addMethodDiff(
  changes: string[],
  before: ReadonlyMap<string, TestNgClassCandidate["methods"][number]>,
  after: ReadonlyMap<string, TestNgClassCandidate["methods"][number]>,
): void {
  const added = [...after]
    .filter(([key]) => !before.has(key))
    .map(([, method]) => methodLabel(method));
  const removed = [...before]
    .filter(([key]) => !after.has(key))
    .map(([, method]) => methodLabel(method));
  if (added.length > 0) changes.push(`方法新增：${added.join("、")}`);
  if (removed.length > 0) changes.push(`方法移除：${removed.join("、")}`);
}

function addSetDiff(changes: string[], label: string, before: string[], after: string[]): void {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((value) => !beforeSet.has(value));
  const removed = before.filter((value) => !afterSet.has(value));
  if (added.length > 0) changes.push(`${label}新增：${added.join("、")}`);
  if (removed.length > 0) changes.push(`${label}移除：${removed.join("、")}`);
}

function addRecordDiff(
  changes: string[],
  label: string,
  before: Record<string, string>,
  after: Record<string, string>,
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] !== after[key]) {
      changes.push(`${label} ${key}：${before[key] ?? "（无）"} → ${after[key] ?? "（无）"}`);
    }
  }
}

function methodKey(method: TestNgClassCandidate["methods"][number]): string {
  return `${method.methodName}${method.descriptor}`;
}

function methodLabel(method: TestNgClassCandidate["methods"][number]): string {
  return `${method.methodName}（${formatMethodSignature(method.descriptor)}）`;
}

function snapshotForPresentation(snapshot: TestNgClassCandidate) {
  return {
    ...snapshot,
    methods: snapshot.methods.map(({ descriptor, ...method }) => ({
      ...method,
      methodSignature: formatMethodSignature(descriptor),
    })),
  };
}

function versionOption(version: CaseVersion) {
  return (
    <option key={version.id} value={version.version}>
      v{version.version}
    </option>
  );
}

function formatDate(value: string): string {
  return formatPlatformDateTime(value, undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const caseVersionHistoryStyles = {
  "current-version-tag": "ml-[7px] bg-success/10 text-success",
  "inline-feedback":
    "border-b border-solid border-border py-2.5 px-4.5 bg-success/10 text-success text-xs [&.error]:border-destructive/10 [&.error]:bg-destructive/10 [&.error]:text-destructive",
  "role-action-summary": "w-fit text-muted-foreground cursor-pointer",
  "settings-inline-form":
    "inline-flex items-end gap-2 [&_label]:grid [&_label]:gap-1.5 [&_label]:text-muted-foreground [&_label]:text-xs [&_label]:font-semibold [&_.ui-button]:[flex:0_0_auto] [&_.ui-button]:whitespace-nowrap",
  "source-code-viewer":
    "max-h-[640px] overflow-auto m-0 p-4.5 border border-solid border-border rounded-lg bg-log-background text-log-foreground font-mono text-xs leading-[1.65] [tab-size:2] whitespace-pre",
  "version-comparison": "grid gap-3.5 border border-solid border-border rounded-lg p-4 bg-muted",
  "version-diff-list": "grid gap-[7px] m-0 pl-5 text-muted-foreground",
  "version-snapshot-details":
    "grid min-w-[min(680px,_75vw)] gap-2.5 my-3 mx-0 [&_p]:m-0 [&_p]:[overflow-wrap:anywhere]",
} as const;
