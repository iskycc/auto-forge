"use client";

import { DatabaseZap, FileArchive, Import } from "lucide-react";
import Link from "next/link";
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
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (tab === activeTab) return;
    setActiveTab(tab);
    setVisitedTabs((current) => new Set([...current, tab]));
  }

  return (
    <>
      <section className="page-hero">
        <div>
          <span className="eyebrow">{activeTab === "ddt" ? "数据驱动测试" : "TestNG 资产"}</span>
          <h1>用例管理</h1>
          <p>
            {activeTab === "ddt"
              ? "在当前项目版本与测试阶段内管理动态字段用例、用户旅程、模板和导入来源。"
              : "一个 TestNG 测试类对应一个用例定义，测试方法作为可执行项保存在版本快照中。"}
          </p>
        </div>
        {canImport && activeTab === "testng" ? (
          <Link className="button button-primary button-large" href="/cases/import">
            <Import size={18} aria-hidden="true" /> 导入 JAR
          </Link>
        ) : null}
      </section>

      <nav className="case-kind-tabs" aria-label="用例类型">
        <a
          aria-current={activeTab === "testng" ? "page" : undefined}
          className={activeTab === "testng" ? "active" : ""}
          href="/cases?tab=testng"
          onClick={(event) => activateTab(event, "testng")}
        >
          <FileArchive size={17} aria-hidden="true" /> TestNG 用例
        </a>
        <a
          aria-current={activeTab === "ddt" ? "page" : undefined}
          className={activeTab === "ddt" ? "active" : ""}
          href="/cases?tab=ddt"
          onClick={(event) => activateTab(event, "ddt")}
        >
          <DatabaseZap size={17} aria-hidden="true" /> DDT 管理
        </a>
      </nav>

      {scopeContent}

      <section aria-label="TestNG 用例" hidden={activeTab !== "testng"} id="testng-case-panel">
        {visitedTabs.has("testng") ? testngContent : null}
      </section>
      <section aria-label="DDT 管理" hidden={activeTab !== "ddt"} id="ddt-case-panel">
        {visitedTabs.has("ddt") ? ddtContent : null}
      </section>
    </>
  );
}
