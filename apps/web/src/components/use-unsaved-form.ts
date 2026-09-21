"use client";
import { useEffect, useState } from "react";
import { useConfirm } from "./ui-feedback";

/** Keep sensitive drafts in the mounted form only, and confirm deliberate navigation. */
export function useUnsavedForm() {
  const [dirty, setDirty] = useState(false);
  const confirm = useConfirm();
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    let asking = false;
    const navigate = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const target = new URL(anchor.href, location.href);
      if (target.pathname === location.pathname && target.search === location.search) return;
      event.preventDefault();
      event.stopPropagation();
      if (asking) return;
      asking = true;
      void confirm({
        title: "放弃未保存的配置？",
        description: "离开后，本次修改将丢失。",
        confirmLabel: "放弃并离开",
        tone: "danger",
      }).then((accepted) => {
        asking = false;
        if (accepted) {
          window.removeEventListener("beforeunload", unload);
          location.assign(anchor.href);
        }
      });
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty, confirm]);
  return { dirty, markDirty: () => setDirty(true), markSaved: () => setDirty(false) };
}
