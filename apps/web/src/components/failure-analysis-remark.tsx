"use client";

import {
  FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES,
  FAILURE_ANALYSIS_REMARK_IMAGE_LIMIT,
  FAILURE_ANALYSIS_REMARK_IMAGES_MAXIMUM_BYTES,
  type FailureAnalysisClaimView,
} from "@autoforge/contracts";
import { ImagePlus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ClipboardEvent } from "react";

import { Button, Textarea } from "@/components/ui";

export type AnalysisImagePreview = {
  fileName: string;
  sizeBytes: number;
  src: string;
  alt: string;
};
type DraftImage = { file: File; url: string };

export function FailureAnalysisRemark({
  value,
  onChange,
  readOnly,
  disabled,
  claims,
  projectId,
  onFilesChange,
  onPreview,
  onError,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  disabled: boolean;
  claims: FailureAnalysisClaimView[];
  projectId: string;
  onFilesChange: (files: File[]) => void;
  onPreview: (image: AnalysisImagePreview, trigger: HTMLButtonElement) => void;
  onError: (message: string) => void;
}) {
  const inputId = useId();
  const [drafts, setDrafts] = useState<DraftImage[]>([]);
  const draftRef = useRef<DraftImage[]>([]);
  useEffect(
    () => () => {
      for (const image of draftRef.current) URL.revokeObjectURL(image.url);
    },
    [],
  );
  const savedImages = [
    ...new Map(
      claims.flatMap((claim) =>
        (claim.remarkImages ?? []).map(
          (image) =>
            [
              image.id,
              {
                ...image,
                src: `/api/v1/failure-analysis/claims/${encodeURIComponent(claim.id)}/evidence?${new URLSearchParams({ projectId, imageId: image.id })}`,
                alt: `备注图片大图：${image.fileName}`,
              },
            ] as const,
        ),
      ),
    ).values(),
  ];

  function updateDrafts(next: DraftImage[]) {
    draftRef.current = next;
    setDrafts(next);
    onFilesChange(next.map((image) => image.file));
  }

  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (readOnly || disabled) return;
    if (files.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
      onError("备注只支持粘贴 PNG、JPEG 或 WebP 图片。");
      return;
    }
    if (files.some((file) => file.size === 0 || file.size > FAILURE_ANALYSIS_IMAGE_MAXIMUM_BYTES)) {
      onError("图片不能为空，且单张不能超过 10 MiB。");
      return;
    }
    const allFiles = [...draftRef.current.map((image) => image.file), ...files];
    if (
      allFiles.length > FAILURE_ANALYSIS_REMARK_IMAGE_LIMIT ||
      allFiles.reduce((bytes, file) => bytes + file.size, 0) >
        FAILURE_ANALYSIS_REMARK_IMAGES_MAXIMUM_BYTES
    ) {
      onError("备注最多包含 8 张图片，合计不能超过 20 MiB。");
      return;
    }
    updateDrafts([
      ...draftRef.current,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
    onError("");
  }

  return (
    <div className="failure-analysis-field failure-analysis-remark" data-analysis-remark>
      <label htmlFor={inputId}>
        备注说明 <small>选填</small>
      </label>
      <Textarea
        id={inputId}
        disabled={disabled}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={pasteImages}
        placeholder="补充上下文、后续动作或其他说明；可直接粘贴图片"
        rows={3}
        maxLength={4000}
      />
      {!readOnly ? (
        <small className="failure-analysis-remark-hint">
          <ImagePlus size={16} aria-hidden="true" /> 在备注框按 Ctrl+V / ⌘+V 粘贴图片，随提交保存。
          PNG / JPEG / WebP，最多 8 张，单张 10 MiB，合计 20 MiB。
        </small>
      ) : null}
      {drafts.length > 0 || savedImages.length > 0 ? (
        <div className="failure-analysis-remark-images" aria-label="备注图片">
          {savedImages.map((image) => (
            <figure key={image.id}>
              <Button
                type="button"
                variant="secondary"
                aria-label={`查看备注图片 ${image.fileName}`}
                onClick={(event) => onPreview(image, event.currentTarget)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- authenticated analysis images use the browser session */}
                <img alt={`备注图片：${image.fileName}`} src={image.src} loading="lazy" />
              </Button>
              <figcaption>
                <span title={image.fileName}>{image.fileName}</span>
              </figcaption>
            </figure>
          ))}
          {drafts.map((image) => (
            <figure key={image.url}>
              <Button
                type="button"
                variant="secondary"
                aria-label={`查看备注图片 ${image.file.name}`}
                onClick={(event) =>
                  onPreview(
                    {
                      fileName: image.file.name,
                      sizeBytes: image.file.size,
                      src: image.url,
                      alt: `备注图片大图：${image.file.name}`,
                    },
                    event.currentTarget,
                  )
                }
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- local clipboard previews are revoked on removal and unmount */}
                <img alt={`备注图片：${image.file.name}`} src={image.url} />
              </Button>
              <figcaption>
                <span title={image.file.name}>{image.file.name}</span>
                <small>待提交</small>
              </figcaption>
              <Button
                type="button"
                variant="secondary"
                size="compact"
                disabled={disabled}
                aria-label={`删除备注图片 ${image.file.name}`}
                onClick={() => {
                  URL.revokeObjectURL(image.url);
                  updateDrafts(draftRef.current.filter((candidate) => candidate.url !== image.url));
                }}
              >
                <X size={14} /> 删除
              </Button>
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}
