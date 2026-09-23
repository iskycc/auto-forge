"use client";
import { Notice } from "@/components/ui/notice";

import { EmptyState } from "@/components/ui/empty-state";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { useEffect, useRef, useState } from "react";
import { CopyPlus, LoaderCircle, Pause } from "lucide-react";
import { ActionDialog } from "./action-dialog";
import { Button, Select } from "./ui";
import { useToast } from "./ui-feedback";
import styles from "./version-case-inheritance-dialog.styles";

export type InheritanceVersion = {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string }>;
};

type Progress = {
  inheritedCount: number;
  skippedCount: number;
  cursor?: string;
  complete: boolean;
};

export function VersionCaseInheritanceDialog({
  scope,
  scopeLabels,
  caseType,
  rules,
  copyPage,
  versions,
  onClose,
  onChanged,
}: {
  scope: { projectId: string; projectVersionId: string; testStageId: string };
  scopeLabels: { project: string; version: string; stage: string };
  caseType: string;
  rules: readonly string[];
  copyPage: (
    input: { sourceProjectVersionId: string; sourceTestStageId: string; cursor?: string },
    signal: AbortSignal,
  ) => Promise<{ inheritedCount: number; skippedCount: number; nextCursor?: string | undefined }>;

  versions: InheritanceVersion[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const sources = versions.filter((version) => version.id !== scope.projectVersionId);
  const [versionId, setVersionId] = useState("");
  const [stageId, setStageId] = useState("");
  const [pending, setPending] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [progress, setProgress] = useState<Progress>();
  const [error, setError] = useState("");
  const stop = useRef(false);
  const alive = useRef(true);
  const inFlight = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const toast = useToast();
  const sourceVersion = sources.find((version) => version.id === versionId);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
      inFlight.current?.abort();
    };
  }, []);

  async function run() {
    if (running.current || !versionId || !stageId || progress?.complete) return;
    running.current = true;
    stop.current = false;
    setPending(true);
    setPausing(false);
    setError("");
    let current: Progress = progress ?? { inheritedCount: 0, skippedCount: 0, complete: false };
    setProgress(current);
    const startedAt = performance.now();
    try {
      do {
        const controller = new AbortController();
        inFlight.current = controller;
        const result = await copyPage(
          {
            sourceProjectVersionId: versionId,
            sourceTestStageId: stageId,
            ...(current.cursor ? { cursor: current.cursor } : {}),
          },
          AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        );
        if (!alive.current) return;
        if (result.nextCursor && result.nextCursor === current.cursor)
          throw new Error("继承进度未推进，请刷新后重试。");
        current = {
          inheritedCount: current.inheritedCount + result.inheritedCount,
          skippedCount: current.skippedCount + result.skippedCount,
          complete: !result.nextCursor,
          ...(result.nextCursor ? { cursor: result.nextCursor } : {}),
        };
        setProgress(current);
      } while (!current.complete && !stop.current && performance.now() - startedAt < 30_000);
      if (current.complete)
        toast.success(
          `${caseType} 继承完成：新增 ${current.inheritedCount} 条，跳过 ${current.skippedCount} 条已有用例。`,
        );
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : "继承失败，请稍后继续。");
    } finally {
      running.current = false;
      inFlight.current = undefined;
      if (alive.current) {
        setPending(false);
        setPausing(false);
        try {
          await onChanged();
        } catch (failure) {
          setError(
            failure instanceof Error ? failure.message : "刷新列表失败，请关闭弹窗后刷新页面。",
          );
        }
      }
    }
  }

  return (
    <ActionDialog
      open
      title={`从其他版本继承 ${caseType} 用例`}
      onClose={onClose}
      closeDisabled={pending}
      className={styles.dialog ?? ""}
      description={`将来源阶段的全部 ${caseType} 用例复制到当前范围，两个版本之后可独立维护。`}
      footer={
        <>
          <Button type="button" disabled={pending} onClick={onClose}>
            关闭
          </Button>
          {pending ? (
            <Button
              type="button"
              disabled={pausing}
              onClick={() => {
                stop.current = true;
                setPausing(true);
              }}
            >
              <Pause size={15} />
              {pausing ? "正在暂停…" : "暂停继承"}
            </Button>
          ) : null}
          {!progress?.complete ? (
            <Button
              type="button"
              className={cn("primary-button", uiPatterns["primary-button"])}
              disabled={pending || !versionId || !stageId}
              onClick={() => void run()}
            >
              {pending ? (
                <LoaderCircle size={15} className={cn("spin", uiPatterns["spin"])} />
              ) : (
                <CopyPlus size={15} />
              )}
              {pending ? "正在继承…" : progress ? "继续继承" : "开始继承"}
            </Button>
          ) : null}
        </>
      }
    >
      <div className={styles.content}>
        <div className={styles.target}>
          <span>继承到当前范围</span>
          <strong>
            {scopeLabels.project} / {scopeLabels.version} / {scopeLabels.stage}
          </strong>
        </div>
        {sources.length ? (
          <div className={styles.fields}>
            <label>
              来源版本
              <Select
                value={versionId}
                disabled={pending || Boolean(progress)}
                onChange={(event) => {
                  setVersionId(event.target.value);
                  setStageId("");
                }}
              >
                <option value="">请选择其他版本</option>
                {sources.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              来源测试阶段
              <Select
                value={stageId}
                disabled={!sourceVersion || pending || Boolean(progress)}
                onChange={(event) => setStageId(event.target.value)}
              >
                <option value="">请选择测试阶段</option>
                {sourceVersion?.stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        ) : (
          <EmptyState className={cn("empty-state", uiPatterns["empty-state"])}>
            当前项目暂无其他版本，请先创建来源版本并导入 {caseType} 用例。
          </EmptyState>
        )}
        {sourceVersion && !sourceVersion.stages.length ? (
          <p className={cn("settings-note", uiPatterns["settings-note"])}>
            所选版本暂无测试阶段，请选择其他版本。
          </p>
        ) : null}
        <ul className={styles.rules}>
          {rules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
          <li>分批保存，暂停或关闭后已完成部分会保留。重新开始时自动跳过已有用例。</li>
        </ul>
        {progress ? (
          <div className={styles.progress} role="status" aria-live="polite">
            <strong>{pending ? "正在继承" : progress.complete ? "继承完成" : "继承已暂停"}</strong>
            <span>
              新增 {progress.inheritedCount} 条 · 跳过 {progress.skippedCount} 条已有用例
            </span>
            {progress.complete && progress.inheritedCount + progress.skippedCount === 0 ? (
              <span>来源阶段没有可继承的 {caseType} 用例。</span>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <Notice tone="error" className={cn("auth-error", uiPatterns["auth-error"])} role="alert">
            {error} 已完成部分已保留，可点击“继续继承”。
          </Notice>
        ) : null}
      </div>
    </ActionDialog>
  );
}
