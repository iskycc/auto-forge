"use client";

import { useEffect, useRef } from "react";
import { Button } from "./ui";

export function DialogDiscardPrompt({
  onContinue,
  onDiscard,
}: {
  onContinue: () => void;
  onDiscard: () => void;
}) {
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    continueRef.current?.focus();
  }, []);
  return (
    <div className="draft-discard-prompt" role="alert">
      <strong>放弃未保存的修改？</strong>
      <p>关闭后，本次填写的内容将丢失。</p>
      <Button ref={continueRef} type="button" onClick={onContinue}>
        继续编辑
      </Button>
      <Button type="button" variant="danger" onClick={onDiscard}>
        放弃修改并关闭
      </Button>
    </div>
  );
}
