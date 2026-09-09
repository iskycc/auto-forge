"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { LoadingGlyph } from "./loading-state";
import { Button, Select } from "./ui";

export type BatchComparisonOption = {
  id: string;
  label: string;
};

export function BatchComparisonForm({
  initialLeftBatchId,
  initialRightBatchId,
  options,
}: {
  initialLeftBatchId: string;
  initialRightBatchId: string;
  options: BatchComparisonOption[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParameters = useSearchParams();
  const [leftBatchId, setLeftBatchId] = useState(initialLeftBatchId);
  const [rightBatchId, setRightBatchId] = useState(initialRightBatchId);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const unchanged =
      searchParameters.get("leftBatchId") === leftBatchId &&
      searchParameters.get("rightBatchId") === rightBatchId;
    const nextParameters = new URLSearchParams(searchParameters.toString());
    nextParameters.set("leftBatchId", leftBatchId);
    nextParameters.set("rightBatchId", rightBatchId);
    startTransition(() => {
      if (unchanged) {
        router.refresh();
        return;
      }
      router.replace(`${pathname}?${nextParameters.toString()}`, { scroll: false });
    });
  }

  return (
    <form className="batch-comparison-form" method="get" onSubmit={submit}>
      <Select
        aria-label="选择基准批次"
        name="leftBatchId"
        onChange={(event) => setLeftBatchId(event.target.value)}
        required
        value={leftBatchId}
      >
        <option value="">选择基准批次</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label="选择对比批次"
        name="rightBatchId"
        onChange={(event) => setRightBatchId(event.target.value)}
        required
        value={rightBatchId}
      >
        <option value="">选择对比批次</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      <Button className="button button-secondary" disabled={pending} type="submit">
        {pending ? <LoadingGlyph compact /> : null}
        {pending ? "正在生成批次对比…" : "开始对比"}
      </Button>
    </form>
  );
}
