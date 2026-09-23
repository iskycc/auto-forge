"use client";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";

import { DatabaseZap, FileArchive, Import } from "lucide-react";
import { LinkButton } from "@/components/ui/link-button";
import { Tabs } from "./ui/tabs";
import { TabContent } from "./ui/tab-content";
import { useState, type MouseEvent, type ReactNode } from "react";

type CaseManagementTab = "testng" | "ddt";

export function CaseManagementTabs({
  canImport,
  ddtContent,
  initialTab,
  scopeContent,
  testngContent,
}: {
  canImport: boolean;
  ddtContent: ReactNode;
  initialTab: CaseManagementTab;
  scopeContent: ReactNode;
  testngContent: ReactNode;
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<CaseManagementTab>>(
    () => new Set([initialTab]),
  );

  function activateTab(event: MouseEvent<HTMLAnchorElement>, tab: CaseManagementTab): void {
    event.stopPropagation();
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    changeTab(tab);
  }

  function changeTab(tab: CaseManagementTab): void {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setVisitedTabs((current) => new Set([...current, tab]));
  }

  return (
    <>
      <section className={cn(uiPatterns["page-hero"], "page-hero flex-nowrap")}>
        <div className="min-w-0 flex-1">
          <span className={cn("eyebrow", uiPatterns["eyebrow"])}>
            {activeTab === "ddt" ? "数据驱动测试" : "TestNG 资产"}
          </span>
          <h1>用例管理</h1>
          <p>在当前项目版本与测试阶段内管理 TestNG 测试类与 DDT 数据驱动用例。</p>
        </div>
        {canImport ? (
          <LinkButton
            variant="primary"
            className={cn(
              "button button-primary button-large",
              uiPatterns["button"],
              uiPatterns["button-primary"],
              uiPatterns["button-large"],
              "shrink-0",
              activeTab !== "testng" && "invisible",
            )}
            href="/cases/import"
          >
            <Import size={18} aria-hidden="true" /> 导入 JAR
          </LinkButton>
        ) : null}
      </section>

      <nav className="case-kind-tabs min-w-0" aria-label="用例类型">
        <Tabs
          label="用例类型"
          value={activeTab}
          onChange={changeTab}
          items={[
            {
              key: "testng",
              label: (
                <a
                  aria-current={activeTab === "testng" ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-2",
                    activeTab === "testng" && "active",
                  )}
                  href="/cases?tab=testng"
                  onClick={(event) => activateTab(event, "testng")}
                >
                  <FileArchive size={17} aria-hidden="true" /> TestNG 用例
                </a>
              ),
            },
            {
              key: "ddt",
              label: (
                <a
                  aria-current={activeTab === "ddt" ? "page" : undefined}
                  className={cn("inline-flex items-center gap-2", activeTab === "ddt" && "active")}
                  href="/cases?tab=ddt"
                  onClick={(event) => activateTab(event, "ddt")}
                >
                  <DatabaseZap size={17} aria-hidden="true" /> DDT 管理
                </a>
              ),
            },
          ]}
        />
      </nav>

      <TabContent activeKey={activeTab} className="gap-5">
        {activeTab === "testng" ? scopeContent : null}

        <section aria-label="TestNG 用例" hidden={activeTab !== "testng"} id="testng-case-panel">
          {visitedTabs.has("testng") ? testngContent : null}
        </section>
        <section aria-label="DDT 管理" hidden={activeTab !== "ddt"} id="ddt-case-panel">
          {visitedTabs.has("ddt") ? ddtContent : null}
        </section>
      </TabContent>
    </>
  );
}
