"use client";

import { useState } from "react";
import type { DdtCaseData } from "@autoforge/domain";
import { Button } from "./ui";

const PREVIEW_CHARACTERS = 8_192;

export function DdtCellValuePreview({ value }: { value: DdtCaseData[string] }) {
  const [visibleLength, setVisibleLength] = useState(PREVIEW_CHARACTERS);
  const text =
    value === null
      ? "空值"
      : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value);
  return (
    <>
      <pre tabIndex={0}>{text === "" ? "空字符串" : text.slice(0, visibleLength)}</pre>
      {text.length > visibleLength ? (
        <Button
          size="compact"
          onClick={() => setVisibleLength((length) => length + PREVIEW_CHARACTERS)}
        >
          显示更多内容（已显示 {visibleLength} / {text.length} 字符）
        </Button>
      ) : null}
    </>
  );
}
