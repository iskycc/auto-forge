"use client";

import type {
  DdtScope,
  DdtSrExecutionMapping,
  DdtSrExecutionMappingPage,
  DdtExecutionClass,
  DdtExecutionClassRangePage,
} from "@autoforge/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Code2, Link2, Search, Settings2, RefreshCw } from "lucide-react";
import { DdtRequirementCategoriesDialog } from "./ddt-requirement-categories-dialog";
import { ActionDialog } from "./action-dialog";
import { Button, Input } from "./ui";
import { useConfirm, useToast } from "./ui-feedback";
import { requestDdtJson } from "@/lib/ddt-client";
import { clearBrowserSnapshots } from "@/lib/browser-read-cache";

type Endpoint = (path: string, query?: Record<string, string>) => string;
const jsonHeaders = { "content-type": "application/json" };
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}

export function DdtSrAssociations({ scope, canManage }: { scope: DdtScope; canManage: boolean }) {
  const params = useSearchParams();
  const query = params.get("query") ?? "";
  const [result, setResult] = useState<DdtSrExecutionMappingPage>({ items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<DdtSrExecutionMapping | "range" | "categories" | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const endpoint: Endpoint = useCallback(
    (path, extra = {}) => `/api/v1/ddt/${path}?${new URLSearchParams({ ...scope, ...extra })}`,
    [scope],
  );
  const toast = useToast();
  const confirm = useConfirm();
  const load = useCallback(
    async (cursor?: string) => {
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setLoading(true);
      setError("");
      try {
        const page = await requestDdtJson<DdtSrExecutionMappingPage>(
          endpoint("sr-mappings", { query, limit: "60", ...(cursor ? { cursor } : {}) }),
          { signal: controller.signal },
        );
        if (!controller.signal.aborted)
          setResult((previous) =>
            cursor ? { ...page, items: [...previous.items, ...page.items] } : page,
          );
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [endpoint, query],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [load, refresh]);
  const reload = () => {
    clearBrowserSnapshots();
    setRefresh((value) => value + 1);
  };
  const unlink = async (mapping: DdtSrExecutionMapping) => {
    if (
      !(await confirm({
        title: `解除 ${mapping.srNum} 的关联`,
        description:
          "本 SR 下所有用例将没有执行类，新执行会被预检阻止。已创建的执行记录保持原快照。",
        confirmLabel: "解除关联",
      }))
    )
      return;
    setLoading(true);
    try {
      await requestDdtJson(endpoint("sr-categories"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          srNum: mapping.srNum,
          categoryId: null,
          expectedRevision: mapping.revision,
        }),
      });
      toast.success(`已解除 SR ${mapping.srNum} 的需求分类。`);
      reload();
    } catch (failure) {
      toast.error(errorMessage(failure));
      setLoading(false);
    }
  };
  return (
    <section className="ddt-sr-associations card" aria-label="SR 关联工作台">
      <div className="ddt-association-toolbar">
        <form
          className="search-field"
          onSubmit={(event) => {
            event.preventDefault();
            const url = new URL(window.location.href);
            const search = String(new FormData(event.currentTarget).get("query") ?? "").trim();
            if (search) url.searchParams.set("query", search);
            else url.searchParams.delete("query");
            window.history.pushState(null, "", url);
          }}
        >
          <Search size={16} />
          <Input
            aria-label="搜索 SR"
            placeholder="按 SR 前缀搜索"
            key={query}
            name="query"
            defaultValue={query}
            disabled={loading}
          />
          <Button className="button button-secondary" type="submit" disabled={loading}>
            搜索
          </Button>
        </form>
        <Button className="button button-secondary" disabled={loading} onClick={reload}>
          <RefreshCw size={15} />
          刷新
        </Button>
        <Button className="button button-secondary" onClick={() => setDialog("range")}>
          <Settings2 size={15} />
          {canManage ? "配置测试类范围" : "查看测试类范围"}
        </Button>
        <Button className="button button-primary" onClick={() => setDialog("categories")}>
          <Settings2 size={15} />
          {canManage ? "配置需求分类" : "查看需求分类"}
        </Button>
      </div>
      <p className="ddt-association-hint">
        先配置需求分类及其执行类，再为 SR 选择分类。SR 下所有 DDT
        用例共享分类执行类，后续导入自动继承。
      </p>
      {!canManage ? (
        <p className="inline-notice">当前账号只可查看；配置需要用例管理权限。</p>
      ) : null}
      {error ? (
        <div className="inline-notice error" role="alert">
          {error}
          <Button className="button button-secondary" onClick={reload}>
            重试
          </Button>
        </div>
      ) : null}
      <div className="ddt-sr-table" aria-busy={loading}>
        <div className="ddt-sr-row ddt-sr-table-heading">
          <span>SR / 业务分组</span>
          <span>用例数</span>
          <span>需求分类 / 执行类</span>
          <span>状态</span>
          <span>操作</span>
        </div>
        {result.items.map((mapping) => (
          <div className="ddt-sr-row" key={mapping.srNum} data-sr={mapping.srNum}>
            <strong>{mapping.srNum}</strong>
            <span>{mapping.caseCount.toLocaleString()}</span>
            <div className="ddt-sr-class">
              <strong>
                {mapping.category?.name ?? (mapping.executionClass ? "历史直接关联" : "尚未分类")}
              </strong>
              <code>
                {mapping.executionClass?.className ??
                  (mapping.category
                    ? "分类执行类已删除，请编辑分类"
                    : "本 SR 下用例共享一个测试类")}
              </code>
            </div>
            <span className={mapping.legacyConflict ? "ddt-association-warning" : ""}>
              {mapping.legacyConflict
                ? "旧关联待确认"
                : mapping.executionClass
                  ? !mapping.executionClass.enabled || mapping.executionClass.archived
                    ? "测试类不可用"
                    : "已关联"
                  : mapping.category
                    ? "测试类不可用"
                    : "未关联"}
            </span>
            <div className="ddt-sr-actions">
              {canManage ? (
                <>
                  <Button
                    className="button button-secondary"
                    disabled={loading}
                    onClick={() => setDialog(mapping)}
                    aria-label={`设置 ${mapping.srNum} 的分类`}
                  >
                    <Link2 size={14} />
                    {mapping.category ? "更换分类" : "设置分类"}
                  </Button>
                  {mapping.category || mapping.executionClass ? (
                    <Button
                      className="button button-ghost"
                      disabled={loading}
                      onClick={() => void unlink(mapping)}
                      aria-label={`解除 ${mapping.srNum} 的关联`}
                    >
                      解除
                    </Button>
                  ) : null}
                </>
              ) : (
                <span>只读</span>
              )}
            </div>
            {mapping.legacyConflict ? (
              <p className="ddt-sr-conflict">
                此 SR
                原有用例关联了不同测试类，请确认统一的执行类后再执行。原始关联保留用于升级核对。
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {!loading && !error && !result.items.length ? (
        <div className="empty-state">
          <Code2 size={24} />
          <strong>{query ? "没有匹配的 SR" : "当前范围还没有 SR"}</strong>
          <p>导入 DDT 用例后，其 srNum 会显示在这里。</p>
        </div>
      ) : null}
      <footer className="ddt-association-footer">
        <span>{loading ? "正在读取 SR 关联…" : `已显示 ${result.items.length} 个 SR`}</span>
        {result.nextCursor ? (
          <Button
            className="button button-secondary"
            disabled={loading}
            onClick={() => void load(result.nextCursor)}
          >
            加载更多 SR
          </Button>
        ) : null}
      </footer>
      {dialog === "range" ? (
        <DdtExecutionClassesDialog
          endpoint={endpoint}
          canManage={canManage}
          onClose={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : dialog ? (
        <DdtRequirementCategoriesDialog
          endpoint={endpoint}
          mapping={dialog === "categories" ? null : dialog}
          canManage={canManage}
          onClose={() => {
            setDialog(null);
            reload();
          }}
          onSaved={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
    </section>
  );
}

function DdtExecutionClassesDialog({
  endpoint,
  canManage,
  onClose,
}: {
  endpoint: Endpoint;
  canManage: boolean;
  onClose(): void;
}) {
  const [range, setRange] = useState<DdtExecutionClassRangePage>({ revision: 0, items: [] });
  const [candidates, setCandidates] = useState<DdtExecutionClass[]>([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const activeRequest = useRef<AbortController | null>(null);
  const toast = useToast();
  const load = useCallback(
    async (cursor?: string) => {
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setLoading(true);
      setError("");
      try {
        const [page, found] = await Promise.all([
          requestDdtJson<DdtExecutionClassRangePage>(
            endpoint("execution-range", {
              query: "",
              limit: "60",
              ...(cursor ? { cursor } : {}),
            }),
            { signal: controller.signal, cache: "reload" },
          ),
          !canManage
            ? Promise.resolve({ items: [] as DdtExecutionClass[] })
            : requestDdtJson<{ items: DdtExecutionClass[] }>(
                endpoint("execution-classes", { query, limit: "50" }),
                { signal: controller.signal, cache: "reload" },
              ),
        ]);
        if (controller.signal.aborted) return;
        setRange((previous) =>
          cursor ? { ...page, items: [...previous.items, ...page.items] } : page,
        );
        setCandidates(found.items);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [endpoint, query, canManage],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [load, refresh]);
  const changeRange = async (item: DdtExecutionClass, included: boolean) => {
    setSaving(true);
    setError("");
    try {
      await requestDdtJson(endpoint("execution-range"), {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          caseDefinitionId: item.caseDefinitionId,
          className: item.className,
          included,
          expectedRevision: range.revision,
        }),
      });
      toast.success(included ? "已加入候选测试类范围。" : "已从候选测试类范围移除。");
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(errorMessage(failure));
      toast.error(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ActionDialog
      open
      title="测试类候选范围"
      description="仅维护当前项目版本和测试阶段需要执行 DDT 的测试类。仍被需求分类或 SR 使用的类需先解除引用。"
      className="ddt-association-dialog"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      {error ? (
        <div className="inline-notice error" role="alert">
          {error}
          <Button
            className="button button-secondary"
            disabled={loading || saving}
            onClick={() => {
              setRefresh((value) => value + 1);
            }}
          >
            刷新范围
          </Button>
        </div>
      ) : null}
      {canManage ? (
        <form
          className="search-field"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft.trim());
          }}
        >
          <Search size={16} />
          <Input
            aria-label="搜索测试类"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="搜索当前阶段的 TestNG 测试类"
            disabled={saving}
          />
          <Button className="button button-secondary" type="submit" disabled={loading || saving}>
            搜索
          </Button>
        </form>
      ) : null}
      <div
        className={
          !canManage ? "ddt-association-class-panels single" : "ddt-association-class-panels"
        }
      >
        <section aria-label="候选测试类范围">
          <h3>已加入范围</h3>
          <div className="ddt-association-class-list">
            {range.items.map((item) => (
              <div className="ddt-association-class-item" key={item.caseDefinitionId}>
                <>
                  <ClassLabel item={item} />
                  {canManage ? (
                    <Button
                      className="button button-secondary"
                      disabled={loading || saving}
                      onClick={() => void changeRange(item, false)}
                      aria-label={`移除 ${item.className}`}
                    >
                      移除
                    </Button>
                  ) : null}
                </>
              </div>
            ))}
          </div>
          {!loading && !range.items.length ? (
            <p className="ddt-association-hint">候选范围为空。从右侧加入需要执行 DDT 的测试类。</p>
          ) : null}
          {range.nextCursor ? (
            <Button
              className="button button-secondary"
              disabled={loading || saving}
              onClick={() => void load(range.nextCursor)}
            >
              加载更多候选类
            </Button>
          ) : null}
        </section>
        {canManage ? (
          <section aria-label="可加入的测试类">
            <h3>从 TestNG 用例库添加</h3>
            <div className="ddt-association-class-list">
              {candidates.map((item) => (
                <div className="ddt-association-class-item" key={item.caseDefinitionId}>
                  <ClassLabel item={item} />
                  <Button
                    className="button button-secondary"
                    disabled={
                      loading ||
                      saving ||
                      !item.enabled ||
                      item.archived ||
                      range.items.some(
                        (allowed) => allowed.caseDefinitionId === item.caseDefinitionId,
                      )
                    }
                    onClick={() => void changeRange(item, true)}
                    aria-label={`加入 ${item.className}`}
                  >
                    {range.items.some(
                      (allowed) => allowed.caseDefinitionId === item.caseDefinitionId,
                    )
                      ? "已加入"
                      : "加入"}
                  </Button>
                </div>
              ))}
            </div>
            {!loading && !candidates.length ? (
              <p className="ddt-association-hint">
                没有可用测试类，请确认已导入并设置当前阶段的权威 JAR 来源。
              </p>
            ) : null}
            {candidates.length === 50 ? (
              <p className="ddt-association-hint">显示前 50 个匹配类，请用搜索缩小范围。</p>
            ) : null}
          </section>
        ) : null}
      </div>
      <footer className="ddt-association-footer">
        <span>
          {saving ? "正在保存…" : loading ? "正在读取测试类…" : "每次加入或移除均立即保存"}
        </span>
        <Button className="button button-secondary" disabled={saving} onClick={onClose}>
          完成
        </Button>
      </footer>
    </ActionDialog>
  );
}
function ClassLabel({ item }: { item: DdtExecutionClass }) {
  return (
    <span className="ddt-association-class-label">
      <strong>{item.displayName}</strong>
      <code>{item.className}</code>
      {!item.enabled || item.archived ? <small>测试类已停用或归档</small> : null}
    </span>
  );
}
