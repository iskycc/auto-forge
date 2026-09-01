"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";

import { LoadingGlyph } from "./loading-state";
import { Button } from "./ui";

export function NavigationSubmitButton({
  children,
  pendingLabel = "正在加载…",
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const form = buttonRef.current?.form;
    if (!form) return;
    // GET filter forms may hand control to the browser immediately. Flush the
    // visual state before navigation so even a slow server response never
    // leaves the user looking at an apparently inert button.
    const handleSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      flushSync(() => setPending(true));
      const target = new URL(form.action || window.location.href);
      const parameters = new URLSearchParams();
      for (const [name, value] of new FormData(form)) {
        parameters.append(name, typeof value === "string" ? value : value.name);
      }
      target.search = parameters.toString();
      window.requestAnimationFrame(() =>
        router.push(`${target.pathname}${target.search}${target.hash}`),
      );
    };
    const handlePageShow = () => setPending(false);
    form.addEventListener("submit", handleSubmit);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      form.removeEventListener("submit", handleSubmit);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [router]);

  return (
    <Button {...props} aria-busy={pending} disabled={pending || props.disabled} ref={buttonRef}>
      {pending ? <LoadingGlyph compact /> : null}
      {pending ? pendingLabel : children}
    </Button>
  );
}
