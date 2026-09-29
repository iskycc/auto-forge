"use client";

import { Empty, Flex, Typography } from "antd";
import { UploadCloud, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { JarImportResult } from "@autoforge/contracts";
import type { CaseDefinitionWithMethods, DdtCaseSummary, DdtScope } from "@autoforge/domain";
import { CaseDebugDdtEditor } from "./case-debug-ddt-editor";
import { Segmented } from "./ui/segmented";
import { Button, Input, Select } from "./ui";
import { Notice } from "./ui/notice";
import { ActionDialog } from "./action-dialog";
import { CaseDebugImportProgress } from "./case-debug-import-progress";
import { debugRequest } from "@/lib/case-debug-client";
import { useToast } from "./ui-feedback";

const JarImporter = dynamic(() => import("./jar-importer").then((module) => module.JarImporter));
const DdtImportDialog = dynamic(() =>
  import("./ddt-management-workspace").then((module) => module.DdtImportDialog),
);

export type DebugInputChoice = {
  id: string;
  label: string;
  suggestedClass?: { id: string; label: string };
};

export function CaseDebugInput({
  kind,
  scope,
  active,
  disabled,
  canUpload,
  maxJarBytes,
  scopeLabels,
  value,
  onChange,
}: {
  kind: "jar" | "ddt";
  scope: DdtScope;
  active: boolean;
  disabled: boolean;
  canUpload: boolean;
  maxJarBytes: number;
  scopeLabels: { project: string; version: string; stage: string };
  value: DebugInputChoice | undefined;
  onChange: (choice: DebugInputChoice | undefined) => void;
}) {
  const [ddtSource, setDdtSource] = useState<"personal" | "formal">("personal");
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [candidates, setCandidates] = useState<DebugInputChoice[]>([]);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [nextCursor, setNextCursor] = useState<string>();
  const [hasPreviousPage, setHasPreviousPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importJobId, setImportJobId] = useState("");
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);
  const toast = useToast();
  const scopeQuery = new URLSearchParams(scope).toString();
  const label = kind === "jar" ? "测试类" : "DDT 用例";

  const search = useCallback(
    async (keyword: string, cursor?: string) => {
      const generation = ++requestGeneration.current;
      setLoading(true);
      setError("");
      setSubmittedQuery(keyword);
      try {
        const parameters = new URLSearchParams(scopeQuery);
        parameters.set("query", keyword);
        parameters.set("limit", "50");
        if (cursor) parameters.set("cursor", cursor);
        let items: DebugInputChoice[];
        let next: string | undefined;
        if (kind === "jar") {
          const page = await debugRequest<{
            items: CaseDefinitionWithMethods[];
            nextCursor?: string;
          }>(`/api/v1/case-definitions?${parameters}`);
          items = page.items
            .filter((item) => item.enabled && !item.archived)
            .map((item) => ({ id: item.id, label: item.className }));
          next = page.nextCursor;
        } else {
          const page = await debugRequest<{ items: DdtCaseSummary[]; nextCursor?: string }>(
            `${ddtSource === "personal" ? "/api/v1/case-debug/ddt" : "/api/v1/ddt"}/cases?${parameters}`,
          );
          items = page.items.map((item) => ({
            id: item.caseId,
            label: item.caseId,
            ...(item.executionClass
              ? {
                  suggestedClass: {
                    id: item.executionClass.caseDefinitionId,
                    label: item.executionClass.className,
                  },
                }
              : {}),
          }));
          next = page.nextCursor;
        }
        if (generation !== requestGeneration.current) return;
        setCandidates(items);
        setNextCursor(next);
        setHasPreviousPage(Boolean(cursor));
        return items;
      } catch (problem) {
        if (generation === requestGeneration.current)
          setError(problem instanceof Error ? problem.message : "候选加载失败。");
      } finally {
        if (generation === requestGeneration.current) setLoading(false);
      }
    },
    [scopeQuery, kind, ddtSource],
  );

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => void search(""), 0);
    return () => {
      clearTimeout(timer);
      requestGeneration.current += 1;
    };
  }, [active, search]);

  const imported = useCallback(() => {
    setImporting(false);
    setQuery("");
    void search("");
    setDdtSource("personal");
    toast.success("已导入个人调试库，可选择用例继续调试。");
  }, [search, toast]);
  const importedJar = useCallback(
    (result: JarImportResult) => {
      setImporting(false);
      const firstClass = result.inspection.classes[0]?.className ?? "";
      setQuery(firstClass);
      void search(firstClass).then((items) => {
        const selected = items?.find((item) => item.label === firstClass);
        if (selected) onChange(selected);
      });
      toast.success("已导入正式用例库，可继续调试。");
    },
    [onChange, search, toast],
  );
  const endpoint = (path: string) => `/api/v1/case-debug/ddt/${path}?${scopeQuery}`;
  const options =
    value && !candidates.some((candidate) => candidate.id === value.id)
      ? [value, ...candidates]
      : candidates;

  async function choose(choice: DebugInputChoice | undefined) {
    if (kind !== "ddt" || ddtSource === "personal" || !choice) {
      onChange(choice);
      return;
    }
    setCopying(true);
    setError("");
    try {
      await debugRequest(endpoint("copy"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId: choice.id }),
      });
      onChange(choice);
      setDdtSource("personal");
      setQuery("");
      toast.success("已使用个人副本；已有的个人修改会保留。");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "复制失败。");
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-3" aria-label={`${label}输入`}>
      <Flex justify="space-between" align="center" gap="small" wrap>
        <Typography.Text strong>{label}</Typography.Text>
        {canUpload ? (
          <Button disabled={disabled} onClick={() => setImporting(true)}>
            <UploadCloud size={15} />
            {kind === "jar" ? "上传 JAR" : "导入表格"}
          </Button>
        ) : null}
      </Flex>
      {kind === "ddt" ? (
        <>
          <Segmented
            label="DDT 数据来源"
            value={ddtSource}
            onChange={setDdtSource}
            block
            options={[
              { value: "personal", label: "个人数据" },
              { value: "formal", label: "复制现有用例" },
            ]}
          />
          <Typography.Text type="secondary" className="text-xs">
            {ddtSource === "personal"
              ? "上传、编辑仅影响你的调试数据。"
              : "选择正式用例后复制到个人空间，保留已有个人修改。"}
          </Typography.Text>
        </>
      ) : null}
      <Flex gap="small">
        <Input
          aria-label={`搜索${label}`}
          placeholder={kind === "jar" ? "完整类名或关键词" : "CaseId 或关键词"}
          maxLength={200}
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search(query);
            }
          }}
        />
        <Button
          aria-label={`检索${label}`}
          disabled={disabled || loading || copying}
          onClick={() => void search(query)}
        >
          <Search size={15} />
          搜索
        </Button>
      </Flex>
      <Select
        aria-label={`调试${label}`}
        value={value?.id ?? ""}
        disabled={disabled || loading || copying}
        onChange={(event) =>
          void choose(options.find((candidate) => candidate.id === event.target.value))
        }
      >
        <option value="">{loading ? "正在加载…" : `请选择一个${label}`}</option>
        {options.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.label}
          </option>
        ))}
      </Select>
      {!loading && !options.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无候选，请调整关键词或上传文件"
        />
      ) : null}
      {nextCursor || hasPreviousPage ? (
        <Flex justify="flex-end" gap="small">
          <Button
            disabled={disabled || loading || copying}
            onClick={() => void search(submittedQuery)}
          >
            回到首批
          </Button>
          <Button
            disabled={disabled || loading || !nextCursor}
            onClick={() => void search(submittedQuery, nextCursor)}
          >
            下一批候选
          </Button>
        </Flex>
      ) : null}
      {value ? (
        <Typography.Text
          className="min-w-0 [overflow-wrap:anywhere] [&_.ant-typography-copy]:!h-8 [&_.ant-typography-copy]:!w-8"
          copyable
        >
          {value.label}
        </Typography.Text>
      ) : null}

      {kind === "ddt" && value ? (
        <Button disabled={disabled || copying} onClick={() => setEditing(true)}>
          查看 / 编辑个人数据
        </Button>
      ) : null}
      {editing && value ? (
        <CaseDebugDdtEditor scope={scope} caseId={value.id} onClose={() => setEditing(false)} />
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {importJobId ? (
        <CaseDebugImportProgress
          key={importJobId}
          jobId={importJobId}
          scope={scope}
          active={active}
          onComplete={imported}
        />
      ) : null}
      {importing && kind === "jar" ? (
        <ActionDialog
          open
          protectUnsavedChanges
          title="上传并导入测试 JAR"
          description="扫描确认后导入正式用例库，导入成功后在调试页选择执行。"
          onClose={() => setImporting(false)}
          className="w-[min(960px,calc(100vw-3rem))]"
        >
          <JarImporter
            presentation="embedded"
            projectName={scopeLabels.project}
            projectVersionName={scopeLabels.version}
            testStageName={scopeLabels.stage}
            maxJarBytes={maxJarBytes}
            versions={[]}
            canInherit={false}
            {...scope}
            onImported={importedJar}
          />
        </ActionDialog>
      ) : null}
      {importing && kind === "ddt" ? (
        <DdtImportDialog
          overwriteLabel="覆盖个人数据"
          description="仅导入个人调试库，不会修改正式用例。先预检，再选择冲突策略。"
          endpoint={endpoint}
          onClose={() => setImporting(false)}
          onComplete={async (jobId) => {
            setImporting(false);
            setImportJobId(jobId);
          }}
        />
      ) : null}
    </div>
  );
}
