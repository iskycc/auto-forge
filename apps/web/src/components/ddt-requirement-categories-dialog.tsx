"use client";
import { EmptyState } from "@/components/ui/empty-state";

import { Notice } from "@/components/ui/notice";

import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import type {
  DdtExecutionClassRangePage,
  DdtRequirementCategory,
  DdtRequirementCategoryPage,
  DdtSrExecutionMapping,
} from "@autoforge/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Input } from "@/components/ui";
import { useToast, useConfirm } from "./ui-feedback";
import { requestDdtJson } from "@/lib/ddt-client";
import { clearBrowserSnapshots } from "@/lib/browser-read-cache";

type Endpoint = (path: string, extra?: Record<string, string>) => string;
const headers = { "content-type": "application/json" };
const message = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试。");

export function DdtRequirementCategoriesDialog({
  endpoint,
  mapping,
  canManage,
  onClose,
  onSaved,
}: {
  endpoint: Endpoint;
  mapping: DdtSrExecutionMapping | null;
  canManage: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const [page, setPage] = useState<DdtRequirementCategoryPage>({ items: [] });
  const [editing, setEditing] = useState<DdtRequirementCategory | "new" | null>(null);
  const [selected, setSelected] = useState(mapping?.category?.id ?? "");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      try {
        const result = await requestDdtJson<DdtRequirementCategoryPage>(
          endpoint("requirement-categories", { query, limit: "60", ...(cursor ? { cursor } : {}) }),
          { signal: controller.signal, cache: "reload" },
        );
        if (!controller.signal.aborted)
          setPage((previous) =>
            cursor ? { ...result, items: [...previous.items, ...result.items] } : result,
          );
      } catch (failure) {
        if (!controller.signal.aborted) setError(message(failure));
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
      request.current?.abort();
    };
  }, [load]);
  const remove = async (category: DdtRequirementCategory) => {
    if (
      !(await confirm({
        title: `删除分类“${category.name}”`,
        description: "正在被 SR 使用的分类不能删除，请先更换或解除 SR 分类。",
        confirmLabel: "删除分类",
      }))
    )
      return;
    setSaving(true);
    try {
      await requestDdtJson(endpoint("requirement-categories/delete"), {
        method: "POST",
        headers,
        body: JSON.stringify({ id: category.id, expectedRevision: category.revision }),
      });
      clearBrowserSnapshots();
      toast.success("已删除需求分类。");
      await load();
    } catch (failure) {
      setError(message(failure));
      toast.error(message(failure));
    } finally {
      setSaving(false);
    }
  };
  const assign = async () => {
    if (!mapping || !selected) return;
    setSaving(true);
    try {
      await requestDdtJson(endpoint("sr-categories"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          srNum: mapping.srNum,
          categoryId: selected,
          expectedRevision: mapping.revision,
        }),
      });
      clearBrowserSnapshots();
      toast.success(
        `已设置 SR ${mapping.srNum} 的需求分类，其下所有 DDT 用例自动使用分类的执行类。`,
      );
      onSaved();
    } catch (failure) {
      setError(message(failure));
      toast.error(message(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ActionDialog
      open
      title={mapping ? `设置 SR ${mapping.srNum} 的分类` : "需求分类"}
      description={
        mapping
          ? `此 SR 下 ${mapping.caseCount} 条用例及后续导入用例共享分类的执行类。`
          : "按当前项目版本和测试阶段维护分类，例如钱包、支付。更改分类执行类会影响所有使用该分类的 SR 的后续执行。"
      }
      className={cn(
        "ddt-association-dialog",
        ddtRequirementCategoriesDialogStyles["ddt-association-dialog"],
      )}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      {editing ? (
        <DdtCategoryEditor
          key={editing === "new" ? "new" : editing.id}
          category={editing === "new" ? null : editing}
          endpoint={endpoint}
          onBusy={setSaving}
          onCancel={() => {
            setEditing(null);
            void load();
          }}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : (
        <>
          <div
            className={cn(
              "ddt-association-toolbar",
              ddtRequirementCategoriesDialogStyles["ddt-association-toolbar"],
            )}
          >
            <form
              className={"search-field"}
              onSubmit={(event) => {
                event.preventDefault();
                setQuery(draft.trim());
              }}
            >
              <Input
                aria-label="搜索需求分类"
                placeholder="搜索分类名称"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={saving}
              />
              <Button
                type="submit"
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
                disabled={loading || saving}
              >
                搜索
              </Button>
            </form>
            {!mapping && canManage ? (
              <Button
                className={cn(
                  "button button-primary",
                  uiPatterns["button"],
                  uiPatterns["button-primary"],
                )}
                disabled={saving}
                onClick={() => setEditing("new")}
              >
                新建分类
              </Button>
            ) : null}
          </div>
          {error ? (
            <Notice
              tone="error"
              className={cn(
                "inline-notice error",
                uiPatterns["inline-notice"],
                uiPatterns["error"],
              )}
              role="alert"
            >
              {error}
              <Button
                className={cn(
                  "button button-secondary",
                  uiPatterns["button"],
                  uiPatterns["button-secondary"],
                )}
                disabled={saving || loading}
                onClick={() => void load()}
              >
                刷新分类
              </Button>
            </Notice>
          ) : null}
          <div
            className={cn(
              "ddt-association-class-list ddt-category-list",
              ddtRequirementCategoriesDialogStyles["ddt-association-class-list"],
              ddtRequirementCategoriesDialogStyles["ddt-category-list"],
            )}
            aria-label="需求分类列表"
            aria-busy={loading}
          >
            {page.items.map((category) => (
              <div
                className={cn(
                  "ddt-association-class-item",
                  ddtRequirementCategoriesDialogStyles["ddt-association-class-item"],
                )}
                key={category.id}
              >
                {mapping ? (
                  <label>
                    <Input
                      type="radio"
                      name="sr-category"
                      aria-label={category.name}
                      checked={selected === category.id}
                      disabled={
                        loading ||
                        saving ||
                        !category.executionClass?.enabled ||
                        category.executionClass.archived
                      }
                      onChange={() => setSelected(category.id)}
                    />
                    <CategoryLabel category={category} />
                  </label>
                ) : (
                  <>
                    <CategoryLabel category={category} />
                    {canManage ? (
                      <div
                        className={cn(
                          "ddt-sr-actions",
                          ddtRequirementCategoriesDialogStyles["ddt-sr-actions"],
                        )}
                      >
                        <Button
                          className={cn(
                            "button button-secondary",
                            uiPatterns["button"],
                            uiPatterns["button-secondary"],
                          )}
                          aria-label={`编辑分类 ${category.name}`}
                          disabled={saving}
                          onClick={() => setEditing(category)}
                        >
                          编辑
                        </Button>
                        <Button
                          className={cn("button button-ghost", uiPatterns["button"])}
                          aria-label={`删除分类 ${category.name}`}
                          disabled={saving}
                          onClick={() => void remove(category)}
                        >
                          删除
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </div>
          {!loading && !page.items.length ? (
            <p
              className={cn(
                "ddt-association-hint",
                ddtRequirementCategoriesDialogStyles["ddt-association-hint"],
              )}
            >
              {query
                ? "没有匹配的需求分类。"
                : "暂无需求分类。点击上方“新建分类”，为分类选择一个候选测试类。"}
            </p>
          ) : null}
          {page.nextCursor ? (
            <Button
              className={cn(
                "button button-secondary",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
              )}
              disabled={loading || saving}
              onClick={() => void load(page.nextCursor)}
            >
              加载更多分类
            </Button>
          ) : null}
          <footer
            className={cn(
              "ddt-association-footer",
              ddtRequirementCategoriesDialogStyles["ddt-association-footer"],
            )}
          >
            <span>{loading ? "正在读取分类…" : `已显示 ${page.items.length} 个分类`}</span>
            <Button
              className={cn(
                "button button-secondary",
                uiPatterns["button"],
                uiPatterns["button-secondary"],
              )}
              disabled={saving}
              onClick={onClose}
            >
              {mapping ? "取消" : "完成"}
            </Button>
            {mapping ? (
              <Button
                className={cn(
                  "button button-primary",
                  uiPatterns["button"],
                  uiPatterns["button-primary"],
                )}
                disabled={loading || saving || !selected}
                onClick={() => void assign()}
              >
                保存 SR 分类
              </Button>
            ) : null}
          </footer>
        </>
      )}
    </ActionDialog>
  );
}

function CategoryLabel({ category }: { category: DdtRequirementCategory }) {
  return (
    <span
      className={cn(
        "ddt-association-class-label",
        ddtRequirementCategoriesDialogStyles["ddt-association-class-label"],
      )}
    >
      <strong>{category.name}</strong>
      <code>{category.executionClass?.className ?? "执行类已删除，请重新配置"}</code>
      {category.executionClass &&
      (!category.executionClass.enabled || category.executionClass.archived) ? (
        <small>执行类已停用或归档</small>
      ) : null}
    </span>
  );
}

function DdtCategoryEditor({
  category,
  endpoint,
  onBusy,
  onCancel,
  onSaved,
}: {
  category: DdtRequirementCategory | null;
  endpoint: Endpoint;
  onBusy(busy: boolean): void;
  onCancel(): void;
  onSaved(): void;
}) {
  const [name, setName] = useState(category?.name ?? "");
  const [className, setClassName] = useState(category?.executionClass?.className ?? "");
  const [range, setRange] = useState<DdtExecutionClassRangePage>({ revision: 0, items: [] });
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const toast = useToast();
  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      try {
        const result = await requestDdtJson<DdtExecutionClassRangePage>(
          endpoint("execution-range", { query, limit: "60", ...(cursor ? { cursor } : {}) }),
          { signal: controller.signal, cache: "reload" },
        );
        if (!controller.signal.aborted)
          setRange((previous) =>
            cursor ? { ...result, items: [...previous.items, ...result.items] } : result,
          );
      } catch (failure) {
        if (!controller.signal.aborted) setError(message(failure));
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
      request.current?.abort();
    };
  }, [load]);
  const save = async () => {
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      await requestDdtJson(endpoint("requirement-categories"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(category ? { id: category.id } : {}),
          name,
          className,
          expectedRevision: category?.revision ?? 0,
        }),
      });
      clearBrowserSnapshots();
      toast.success(`已保存需求分类“${name.trim()}”。`);
      onSaved();
    } catch (failure) {
      setError(message(failure));
      toast.error(message(failure));
    } finally {
      setSaving(false);
      onBusy(false);
    }
  };
  return (
    <div
      className={cn(
        "ddt-category-editor",
        ddtRequirementCategoriesDialogStyles["ddt-category-editor"],
      )}
    >
      <label className={"field-label"}>
        分类名称
        <Input
          aria-label="分类名称"
          maxLength={160}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：钱包、支付"
          disabled={saving}
        />
      </label>
      <form
        className={"search-field"}
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <Input
          aria-label="搜索分类执行类"
          placeholder="搜索候选测试类"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={saving}
        />
        <Button
          type="submit"
          className={cn(
            "button button-secondary",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
          )}
          disabled={saving || loading}
        >
          搜索
        </Button>
      </form>
      <p
        className={cn(
          "ddt-association-hint",
          ddtRequirementCategoriesDialogStyles["ddt-association-hint"],
        )}
      >
        选择分类执行类。候选列表由“配置测试类范围”维护。
      </p>
      <div
        className={cn(
          "ddt-association-class-list ddt-category-list",
          ddtRequirementCategoriesDialogStyles["ddt-association-class-list"],
          ddtRequirementCategoriesDialogStyles["ddt-category-list"],
        )}
        aria-label="分类执行类"
      >
        {range.items.map((item) => (
          <div
            className={cn(
              "ddt-association-class-item",
              ddtRequirementCategoriesDialogStyles["ddt-association-class-item"],
            )}
            key={item.caseDefinitionId}
          >
            <label>
              <Input
                type="radio"
                name="category-class"
                aria-label={item.className}
                checked={className === item.className}
                disabled={loading || saving || !item.enabled || item.archived}
                onChange={() => setClassName(item.className)}
              />
              <span
                className={cn(
                  "ddt-association-class-label",
                  ddtRequirementCategoriesDialogStyles["ddt-association-class-label"],
                )}
              >
                <strong>{item.displayName}</strong>
                <code>{item.className}</code>
                {!item.enabled || item.archived ? <small>测试类已停用或归档</small> : null}
              </span>
            </label>
          </div>
        ))}
      </div>
      {!loading && !range.items.length ? (
        <EmptyState
          className={cn(
            "ddt-association-hint",
            ddtRequirementCategoriesDialogStyles["ddt-association-hint"],
          )}
        >
          没有匹配的候选测试类，请先在“配置测试类范围”中添加。
        </EmptyState>
      ) : null}
      {range.nextCursor ? (
        <Button
          className={cn(
            "button button-secondary",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
          )}
          disabled={loading || saving}
          onClick={() => void load(range.nextCursor)}
        >
          加载更多候选类
        </Button>
      ) : null}
      {error ? (
        <Notice
          tone="error"
          className={cn("inline-notice error", uiPatterns["inline-notice"], uiPatterns["error"])}
          role="alert"
        >
          {error}
        </Notice>
      ) : null}
      <footer
        className={cn(
          "ddt-association-footer",
          ddtRequirementCategoriesDialogStyles["ddt-association-footer"],
        )}
      >
        <span>{loading ? "正在读取测试类…" : `已选执行类：${className || "尚未选择"}`}</span>
        <Button
          className={cn(
            "button button-secondary",
            uiPatterns["button"],
            uiPatterns["button-secondary"],
          )}
          disabled={saving}
          onClick={onCancel}
        >
          返回分类列表
        </Button>
        <Button
          className={cn(
            "button button-primary",
            uiPatterns["button"],
            uiPatterns["button-primary"],
          )}
          disabled={loading || saving || !name.trim() || !className}
          onClick={() => void save()}
        >
          保存分类
        </Button>
      </footer>
    </div>
  );
}

const ddtRequirementCategoriesDialogStyles = {
  "ddt-association-class-item":
    "flex items-center gap-3 p-3 border-b border-solid border-border [&_>_.ddt-association-class-label]:flex-1 [&_label]:flex [&_label]:items-center [&_label]:gap-3 [&_label]:w-full [&_label]:cursor-pointer [&_strong]:text-sm [&_strong]:[overflow-wrap:anywhere] [&_.button]:shrink-0",
  "ddt-association-class-label":
    "flex flex-col gap-1 min-w-0 [&_code]:text-xs [&_code]:text-muted-foreground [&_code]:[overflow-wrap:anywhere]",
  "ddt-association-class-list": "max-h-[360px] overflow-y-auto",
  "ddt-association-dialog":
    "w-[min(960px,_calc(100vw_-_20px))] max-w-none [&_.search-field]:flex [&_.search-field]:items-center [&_.search-field]:gap-2 [&_.search-field]:min-w-0 [&_.search-field_>.ui-field-feedback]:flex-1 [&_.search-field_>.ui-field-feedback]:w-0 [&_.search-field_input]:w-full [&_.search-field_input]:min-w-0 [&_.inline-notice]:mb-3",
  "ddt-association-footer":
    "flex items-center gap-3 mt-4 [&_>_span]:flex-1 [&_>_span]:text-muted-foreground [&_>_span]:text-sm",
  "ddt-association-hint": "text-muted-foreground text-sm leading-[1.6] my-4 mx-0",
  "ddt-association-toolbar":
    "flex items-center gap-3 [&_.search-field]:flex-1 [&_.search-field]:flex [&_.search-field]:items-center [&_.search-field]:gap-2 [&_.search-field]:min-w-0 [&_.search-field_>.ui-field-feedback]:flex-1 [&_.search-field_>.ui-field-feedback]:w-0 [&_.search-field_input]:w-full [&_.search-field_input]:min-w-0",
  "ddt-category-editor":
    "grid gap-4 min-w-0 [&_.ddt-association-footer_>_span]:[overflow-wrap:anywhere] [&_.ddt-association-footer_>_span]:min-w-0",
  "ddt-category-list": "max-h-[min(42vh,_360px)] overflow-y-auto",
  "ddt-sr-actions": "flex items-center gap-1 [&_.button]:px-2",
} as const;
