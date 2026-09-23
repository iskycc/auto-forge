"use client";
import { cn } from "@/lib/utils";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import { useRef } from "react";
import { Tabs } from "./ui/tabs";

export type SectionTab = {
  href: string;
  label: string;
  active: boolean;
};

export function SectionTabs({ label, tabs }: { label: string; tabs: SectionTab[] }) {
  const navigationRef = useRef<HTMLElement>(null);
  return (
    <nav ref={navigationRef} className="section-tabs min-w-0" aria-label={label}>
      <Tabs
        label={label}
        value={tabs.find((tab) => tab.active)?.href ?? tabs[0]?.href ?? ""}
        items={tabs.map((tab) => ({
          key: tab.href,
          label: (
            <Link
              className="inline-flex items-center"
              onClick={(event) => event.stopPropagation()}
              aria-current={tab.active ? "page" : undefined}
              href={tab.href}
              scroll={false}
            >
              <SectionTabLabel label={tab.label} />
            </Link>
          ),
        }))}
        onChange={(href) => {
          // Keyboard activation follows the same Link and unsaved-form guard as a mouse click.
          const links = navigationRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]");
          Array.from(links ?? [])
            .find((link) => link.getAttribute("href") === href)
            ?.click();
        }}
      />
    </nav>
  );
}

/** Next 路由仍在服务端取数时给出即时反馈，避免点击后看起来像界面卡死。 */
function SectionTabLabel({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          sectionTabsStyles["section-tab-pending"],
          `section-tab-pending${pending ? " visible" : ""}`,
        )}
      />
    </>
  );
}

const sectionTabsStyles = {
  "section-tab-pending":
    "inline-block size-1.5 shrink-0 ml-2 rounded-full bg-current opacity-0 transition-opacity duration-150 motion-reduce:transition-none [&.visible]:opacity-75 [&.visible]:animate-pulse [&.visible]:motion-reduce:animate-none",
} as const;
