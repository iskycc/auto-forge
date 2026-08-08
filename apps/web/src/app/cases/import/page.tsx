import type { Metadata } from "next";

import { JarImporter } from "@/components/jar-importer";
import { getPlatformServices } from "@/lib/services";

export const metadata: Metadata = { title: "导入 TestNG JAR" };
export const dynamic = "force-dynamic";

export default function ImportJarPage() {
  const { config } = getPlatformServices();
  return (
    <div className="page-stack narrow-page">
      <section className="page-hero">
        <div>
          <span className="eyebrow">用例来源</span>
          <h1>导入 TestNG JAR</h1>
          <p>静态读取 class 注解，预览测试类和方法后再写入用例库。</p>
        </div>
      </section>
      <JarImporter maxJarBytes={config.maxJarBytes} />
    </div>
  );
}
