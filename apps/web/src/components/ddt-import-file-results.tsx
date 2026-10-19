"use client";

import { useEffect, useState } from "react";
import {
  DDT_IMPORT_FILES_PAGE_SIZE,
  ddtImportFilePageSchema,
  type DdtImportFilePage,
} from "@autoforge/contracts";
import { readApiError } from "@/lib/client-api";
import { ddtImportStatusLabel } from "@/lib/ddt-import-status";
import { Button } from "./ui/button";
import { Disclosure } from "./ui/disclosure";
import { Notice } from "./ui/notice";

export function DdtImportFileResults(props: { filesUrl: string; updatedAt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure header={<>逐文件结果</>} open={open} onOpenChange={setOpen}>
      {open ? <ImportFilePage {...props} /> : null}
    </Disclosure>
  );
}

function ImportFilePage({ filesUrl, updatedAt }: { filesUrl: string; updatedAt: string }) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [result, setResult] = useState<DdtImportFilePage>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const cursor = cursors.at(-1);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const url = new URL(filesUrl, window.location.origin);
    url.searchParams.set("limit", String(DDT_IMPORT_FILES_PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);
    void (async () => {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      const failure = await readApiError(response, "无法读取文件清单，请重试。");
      if (failure) throw failure;
      const page = ddtImportFilePageSchema.parse(await response.json());
      if (active) {
        setResult(page);
        setError("");
      }
    })()
      .catch((failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : "无法读取文件清单，请重试。");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [filesUrl, updatedAt, cursor, retry]);

  function changePage(next: Array<string | undefined>) {
    setResult(undefined);
    setBusy(true);
    setError("");
    setCursors(next);
  }

  function retryRead() {
    setBusy(true);
    setError("");
    setRetry((value) => value + 1);
  }

  return (
    <div className="grid min-w-0 gap-3" aria-busy={busy}>
      {error ? (
        <Notice tone="error" role="alert">
          {error}{" "}
          <Button type="button" variant="outline" size="sm" onClick={retryRead}>
            重试
          </Button>
        </Notice>
      ) : null}
      {!result && busy ? (
        <div role="status" className="py-3 text-muted-foreground">
          正在读取文件清单…
        </div>
      ) : null}
      {result ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              共 {result.totalCount} 个文件 · 第 {cursors.length} 页 · 每页{" "}
              {DDT_IMPORT_FILES_PAGE_SIZE} 个
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || cursors.length === 1}
                onClick={() => changePage(cursors.slice(0, -1))}
              >
                上一页
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !result.nextCursor}
                onClick={() => changePage([...cursors, result.nextCursor])}
              >
                下一页
              </Button>
            </div>
          </div>
          <div
            className="max-h-96 min-w-0 overflow-y-auto overscroll-contain"
            role="region"
            aria-label="导入文件结果"
            tabIndex={0}
          >
            {result.items.length ? (
              result.items.map((file) => (
                <div
                  className="ddt-file-row grid grid-cols-[minmax(0,1fr)_70px_80px] gap-2 border-b border-border py-2 text-sm last:border-b-0"
                  key={file.id}
                >
                  <strong className="min-w-0 break-all font-medium">
                    {file.archiveEntryName ?? file.fileName}
                  </strong>
                  <span className="text-muted-foreground">{file.rowCount} 行</span>
                  <span>{ddtImportStatusLabel(file.status)}</span>
                  {file.errorSummary ? (
                    <small className="col-span-full break-all text-destructive">
                      {file.errorSummary}
                    </small>
                  ) : null}
                </div>
              ))
            ) : (
              <div className="py-3 text-muted-foreground">暂无文件结果。</div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
