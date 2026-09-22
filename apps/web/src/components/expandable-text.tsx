"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";

export function ExpandableText({ text, label = "内容" }: { text: string; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setTruncated(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <span className="expandable-text" data-expanded={expanded}>
      <span ref={textRef} title={text}>
        {text}
      </span>
      {truncated || expanded ? (
        <Button
          type="button"
          variant="ghost"
          size="compact"
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"}${label}`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开全文"}
        </Button>
      ) : null}
    </span>
  );
}
