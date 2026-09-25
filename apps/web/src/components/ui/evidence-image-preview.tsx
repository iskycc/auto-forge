"use client";

import { Image, Space, Typography } from "antd";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "./button";

type EvidenceImage = { src: string; alt: string; fileName: string };

/** Ant Image owns focus, pan, zoom and keyboard handling; URLs retain browser authentication. */
export function EvidenceImagePreview({
  image,
  onClose,
}: {
  image: EvidenceImage;
  onClose(): void;
}) {
  return (
    <Image
      src={image.src}
      alt={image.alt}
      styles={{ root: { display: "none" } }}
      preview={{
        open: true,
        onOpenChange: (open) => {
          if (!open) onClose();
        },
        zIndex: 1400,
        minScale: 0.5,
        maxScale: 3,
        scaleStep: 0.25,
        closeIcon: (
          <span aria-label="关闭图片预览">
            <X aria-hidden="true" />
          </span>
        ),
        actionsRender: (_, { actions, transform }) => (
          <Space
            className="max-w-full rounded-xl border border-border bg-card p-2 text-foreground shadow-lg"
            wrap
          >
            <Typography.Text ellipsis className="max-w-64" title={image.fileName}>
              {image.fileName}
            </Typography.Text>
            <Button
              aria-label="缩小图片"
              disabled={transform.scale <= 0.5}
              onClick={actions.onZoomOut}
            >
              <Minus size={16} />
            </Button>
            <Typography.Text aria-label="当前图片缩放比例">
              {Math.round(transform.scale * 100)}%
            </Typography.Text>
            <Button
              aria-label="放大图片"
              disabled={transform.scale >= 3}
              onClick={actions.onZoomIn}
            >
              <Plus size={16} />
            </Button>
            <Button aria-label="还原图片" onClick={actions.onReset}>
              <RotateCcw size={16} />
            </Button>
          </Space>
        ),
      }}
    />
  );
}
