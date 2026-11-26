"use client";

import { Button, Empty, Flex, Statistic, Typography } from "antd";
import { BarsOutlined } from "@ant-design/icons";
import type { SystemDiagnostic } from "@autoforge/contracts";
import { useState } from "react";
import { ActionDialog } from "./action-dialog";
import { SystemAiAnalysisRuntime } from "./system-ai-analysis-runtime";
import { DiagnosticDeadLetters } from "./system-diagnostic-dead-letters";
import { Card } from "./ui/card";
import styles from "./system-diagnostics.styles";

type DiagnosticQueuesProps = {
  diagnostic: SystemDiagnostic;
  canManage: boolean;
  redriving: boolean;
  loading: boolean;
  redriveDeadLetters(): Promise<void>;
};

export function DiagnosticQueues(props: DiagnosticQueuesProps) {
  const [open, setOpen] = useState(false);
  const { diagnostic } = props;

  return (
    <Card as="section" className={styles.panel} aria-label="队列概况">
      <div className="grid grid-cols-2 gap-4">
        <section className={styles.queueSummary} aria-label="队列快照">
          <div className={styles.panelHeading}>
            <BarsOutlined aria-hidden />
            <h3>队列快照</h3>
          </div>
          <QueueMetrics depth={diagnostic.queueDepth} />
          <Button type="link" className="mt-auto !min-h-8 !px-0" onClick={() => setOpen(true)}>
            查看队列详情
          </Button>
        </section>
        <SystemAiAnalysisRuntime />
      </div>
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title="队列详情"
        description="队列消息快照。死信列表最多展示 20 条，每次最多重新投递 100 条。"
        className="w-[min(880px,calc(100vw-3rem))]"
      >
        <Flex vertical gap="middle">
          <QueueMetrics depth={diagnostic.queueDepth} />
          <Typography.Text type="secondary">
            更新于{" "}
            <time dateTime={diagnostic.generatedAt} title={`UTC ${diagnostic.generatedAt}`}>
              {new Date(diagnostic.generatedAt).toLocaleString("zh-CN")}
            </time>
          </Typography.Text>
          {diagnostic.deadLetters.length ? (
            <DiagnosticDeadLetters {...props} />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={diagnostic.queueDepth ? "暂无死信任务" : "当前无可用的死信快照"}
            />
          )}
        </Flex>
      </ActionDialog>
    </Card>
  );
}

function QueueMetrics({ depth }: { depth: SystemDiagnostic["queueDepth"] }) {
  return (
    <div className={styles.queueStats}>
      <Statistic title="可投递" value={depth?.available ?? "—"} />
      <Statistic title="已租约" value={depth?.leased ?? "—"} />
      <Statistic title="死信" value={depth?.deadLetter ?? "—"} />
    </div>
  );
}
