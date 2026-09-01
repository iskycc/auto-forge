"use client";

import { formatPlatformDateTime } from "@/lib/platform-date-time";

import {
  apiErrorSchema,
  testNgClassCandidateSchema,
  type TestNgClassCandidate,
} from "@autoforge/contracts";
import type { CaseVersion } from "@autoforge/domain";
import { GitCompareArrows, History, LoaderCircle } from "lucide-react";
import Link from "next/link";
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
    <div className="settings-stack">
      {error ? (
        <div className="inline-feedback" role="alert">
          {error}
        </div>
      ) : null}
      <section className="version-comparison" aria-labelledby="version-comparison-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Diff</span>
            <h3 id="version-comparison-title">指定版本差异</h3>
          </div>
          <GitCompareArrows size={19} aria-hidden="true" />
        </div>
        <div className="settings-inline-form">
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
          <ul className="version-diff-list">
            {comparison.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">两个版本的可执行快照一致。</p>
        )}
      </section>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>版本</th>
              <th>变更原因</th>
              <th>操作人</th>
              <th>创建时间</th>
              <th>内容与引用</th>
              {canManage ? <th>操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {orderedVersions.map((version) => {
              const snapshot = parseSnapshot(version.snapshot);
              const previous = snapshotFor(orderedVersions, version.version - 1);
              const adjacentChanges = compareSnapshots(previous, snapshot);
              return (
                <tr key={version.id}>
                  <td>
                    <strong>v{version.version}</strong>
                    {version.version === currentVersion ? (
                      <span className="tag current-version-tag">当前</span>
                    ) : null}
                  </td>
                  <td>{CHANGE_REASON_LABELS[version.changeReason] ?? version.changeReason}</td>
                  <td>{version.createdBy ?? <span className="muted">—</span>}</td>
                  <td>
                    <time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time>
                  </td>
                  <td>
                    <details>
                      <summary className="role-action-summary">查看快照与相邻差异</summary>
                      {snapshot ? (
                        <div className="version-snapshot-details">
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
                          <pre className="source-code-viewer" tabIndex={0}>
                            <code>
                              {JSON.stringify(snapshotForPresentation(snapshot), null, 2)}
                            </code>
                          </pre>
                        </div>
                      ) : (
                        <p className="auth-error">该历史快照格式无效，不能展示或恢复。</p>
                      )}
                      <Link
                        className="button button-secondary"
                        href={`/run-batches?caseDefinitionId=${encodeURIComponent(caseDefinitionId)}`}
                      >
                        查看该用例关联执行
                      </Link>
                    </details>
                  </td>
                  {canManage ? (
                    <td>
                      {version.version === currentVersion ? (
                        <span className="muted">—</span>
                      ) : (
                        <Button
                          className="secondary-button"
                          disabled={pendingVersion !== null || !snapshot}
                          onClick={() => void restore(version.version)}
                          type="button"
                        >
                          {pendingVersion === version.version ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : (
                            <History size={14} />
                          )}
                          从该版本创建
                        </Button>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
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
