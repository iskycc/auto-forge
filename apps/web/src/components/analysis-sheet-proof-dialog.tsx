"use client";

import { Alert, Image, Upload } from "antd";
import type { FailureAnalysisClaimView } from "@autoforge/contracts";
import { useState } from "react";
import { Button } from "./ui";
import { Dialog } from "./ui/dialog";
import { readApiErrorMessage } from "@/lib/client-api";

export function AnalysisSheetProofDialog({
  claim,
  endpoint,
  editable,
  onUpdated,
  onClose,
}: {
  claim: FailureAnalysisClaimView;
  endpoint: string;
  editable: boolean;
  onUpdated: (claim: FailureAnalysisClaimView) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function upload(file: File) {
    if (pending || !editable) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      !file.size ||
      file.size > 10 * 1024 * 1024
    ) {
      setError("请上传不超过 10 MiB 的 PNG、JPEG 或 WebP 图片。");
      return;
    }
    setPending(true);
    setError("");
    try {
      const query = new URLSearchParams({
        analysisId: claim.id,
        fileName: file.name || "rerun-proof.png",
      });
      const response = await fetch(`${endpoint}/proof?${query}`, {
        method: "POST",
        headers: { "content-type": file.type },
        body: file,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error((await readApiErrorMessage(response, "上传证明失败。"))!);
      const payload = (await response.json()) as { items: FailureAnalysisClaimView[] };
      if (payload.items[0]) onUpdated(payload.items[0]);
      setNotice("本用例证明已保存；分析结论仍需在表格中提交。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传证明失败。");
    } finally {
      setPending(false);
    }
  }
  async function lookup() {
    if (pending || !editable) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`${endpoint}/rerun-proofs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ analysisIds: [claim.id] }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error((await readApiErrorMessage(response, "查找重跑证明失败。"))!);
      const result = (await response.json()) as { items: { status: string }[] };
      setNotice(
        result.items[0]?.status === "found"
          ? "已找到本用例的成功重跑记录，提交时会再次校验并关联。"
          : "没有找到成功重跑记录，请上传或粘贴本用例的通过截图。",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "查找重跑证明失败。");
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      title="分析证明"
      onClose={onClose}
      closeDisabled={pending}
      className="w-[min(720px,calc(100vw-48px))]"
    >
      <section
        className="grid min-w-0 gap-4 p-6"
        onPaste={(event) => {
          if (!editable || pending) return;
          const file = [...event.clipboardData.items]
            .find((item) => item.kind === "file" && item.type.startsWith("image/"))
            ?.getAsFile();
          if (file) {
            event.preventDefault();
            void upload(file);
          }
        }}
      >
        <div className="flex min-w-0 items-center justify-between gap-4">
          <h2 className="m-0 text-lg font-semibold">分析证明</h2>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            关闭
          </Button>
        </div>
        <p className="m-0 truncate text-muted-foreground" title={claim.caseName}>
          {claim.caseName}
        </p>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {notice ? <Alert type="info" showIcon title={notice} /> : null}
        {claim.screenshot ? (
          <Image
            alt="本用例的重跑通过证明"
            src={`${endpoint}/evidence?${new URLSearchParams({ analysisId: claim.id })}`}
            className="max-h-80 object-contain"
          />
        ) : (
          <Alert
            type="info"
            title="此用例尚未上传截图证明"
            description="重跑通过会优先核对成功重跑记录；查不到时需要单独提供本用例通过截图。"
          />
        )}
        {claim.remarkImages?.map((image) => (
          <Image
            key={image.id}
            alt={image.fileName}
            src={`${endpoint}/evidence?${new URLSearchParams({ analysisId: claim.id, imageId: image.id })}`}
            className="max-h-64 object-contain"
          />
        ))}
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void lookup()} disabled={pending}>
              查找成功重跑
            </Button>
            <Upload
              accept="image/png,image/jpeg,image/webp"
              showUploadList={false}
              beforeUpload={(file) => {
                void upload(file);
                return false;
              }}
            >
              <Button type="button" variant="secondary" disabled={pending} loading={pending}>
                上传本用例截图
              </Button>
            </Upload>
            <span className="text-xs text-muted-foreground">
              也可在此窗口按 Ctrl+V 粘贴截图；每例单独校验。
            </span>
          </div>
        ) : null}
      </section>
    </Dialog>
  );
}
