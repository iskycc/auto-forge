import { LoadingStateMessage } from "@/components/ui/loading-state-message";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { uiPatterns } from "@/components/ui/patterns";
import type { DdtExecutionStatistics } from "@autoforge/contracts";
import { formatPlatformDateTime } from "@/lib/platform-date-time";

const outcomes = [
  ["passed", "通过"],
  ["failed", "不通过"],
  ["cancelled", "已终止"],
  ["pending", "未完成"],
] as const;

export function DdtExecutionChart({
  execution,
}: {
  execution: DdtExecutionStatistics | undefined;
}) {
  const timeline = execution?.timeline ?? [];
  const total = timeline.reduce((sum, day) => sum + day.total, 0);
  const maximum = Math.max(...timeline.map((day) => day.total), 1);
  const counts = outcomes.map(([key, label]) => ({
    key,
    label,
    count: timeline.reduce((sum, day) => sum + day[key], 0),
  }));

  return (
    <Card
      as="article"
      className={cn(
        "card ddt-chart-card ddt-execution-chart",
        uiPatterns["card"],
        ddtExecutionChartStyles["ddt-chart-card"],
        ddtExecutionChartStyles["ddt-execution-chart"],
      )}
      aria-label="DDT 近 7 日执行统计"
    >
      <header>
        <div>
          <strong>近 7 日执行</strong>
          <span>按执行创建日期（UTC）· 重试不重复计数</span>
        </div>
        <b className={cn("ddt-execution-total", ddtExecutionChartStyles["ddt-execution-total"])}>
          {execution ? total.toLocaleString() : "—"}
          <small> 次</small>
        </b>
      </header>
      {execution ? (
        <>
          <div
            className={cn("ddt-execution-legend", ddtExecutionChartStyles["ddt-execution-legend"])}
            aria-label="执行结果汇总"
          >
            {counts.map(({ key, label, count }) => (
              <span key={key}>
                <i
                  className={cn(
                    ddtExecutionChartStyles["ddt-outcome"],
                    `ddt-outcome ddt-outcome-${key}`,
                  )}
                />
                {label} <b>{count.toLocaleString()}</b>
              </span>
            ))}
          </div>
          <div
            className={cn("ddt-execution-bars", ddtExecutionChartStyles["ddt-execution-bars"])}
            aria-label="近 7 日 DDT 执行柱形图"
          >
            {timeline.map((day) => {
              const description = `${day.date}：共 ${day.total} 次，${outcomes.map(([key, label]) => `${label} ${day[key]}`).join("，")}`;
              return (
                <div
                  key={day.date}
                  className={cn("ddt-execution-day", ddtExecutionChartStyles["ddt-execution-day"])}
                  aria-label={description}
                  title={description}
                >
                  <b>{day.total.toLocaleString()}</b>
                  <div
                    className={cn(
                      "ddt-execution-track",
                      ddtExecutionChartStyles["ddt-execution-track"],
                    )}
                  >
                    <div
                      className={cn(
                        "ddt-execution-stack",
                        ddtExecutionChartStyles["ddt-execution-stack"],
                      )}
                      style={{ height: `${(day.total / maximum) * 100}%` }}
                    >
                      {outcomes.map(([key]) => (
                        <i
                          key={key}
                          className={cn(
                            ddtExecutionChartStyles["ddt-outcome"],
                            `ddt-outcome ddt-outcome-${key}`,
                          )}
                          style={{ flexGrow: day[key] }}
                        />
                      ))}
                    </div>
                  </div>
                  <small>{day.date.slice(5)}</small>
                </div>
              );
            })}
          </div>
          {total === 0 ? (
            <EmptyState
              className={cn("ddt-execution-empty", ddtExecutionChartStyles["ddt-execution-empty"])}
            >
              近 7 日暂无 DDT 执行记录
            </EmptyState>
          ) : null}
          <p
            className={cn(
              "ddt-execution-updated",
              ddtExecutionChartStyles["ddt-execution-updated"],
            )}
          >
            统计更新于{" "}
            <time dateTime={execution.generatedAt} title={execution.generatedAt}>
              {formatPlatformDateTime(execution.generatedAt)}
            </time>
          </p>
        </>
      ) : (
        <LoadingStateMessage
          className={cn("ddt-chart-empty", ddtExecutionChartStyles["ddt-chart-empty"])}
        >
          后台正在准备执行统计
        </LoadingStateMessage>
      )}
    </Card>
  );
}

const ddtExecutionChartStyles = {
  "ddt-chart-card":
    "[&_header]:flex [&_header]:items-center [&_header_>_div]:grid [&_header_>_div]:min-w-0 [&_header_>_div]:gap-[3px] [&_header_>_div]:mr-auto [&_header_span]:text-muted-foreground [&_header_span]:text-xs min-w-0 p-5",
  "ddt-chart-empty": "m-auto text-muted-foreground",
  "ddt-execution-bars": "grid grid-cols-7 gap-3 mt-4",
  "ddt-execution-chart": "[&_header]:flex-wrap [&_header]:gap-3",
  "ddt-execution-day":
    "grid min-w-0 gap-2 text-center text-xs tabular-nums [&_>_b]:[overflow-wrap:anywhere] [&_small]:text-muted-foreground [&_small]:text-xs",
  "ddt-execution-empty": "text-muted-foreground text-xs [margin:12px_0_0]",
  "ddt-execution-legend":
    "flex flex-wrap gap-[8px_16px] mt-4 text-xs text-muted-foreground [&_>_span]:inline-flex [&_>_span]:items-center [&_>_span]:gap-1 [&_i]:w-2 [&_i]:h-2 [&_i]:rounded-full",
  "ddt-execution-stack":
    "flex [flex-direction:column-reverse] w-[70%] overflow-hidden rounded-lg [&_i]:[flex-basis:0]",
  "ddt-execution-total":
    "text-2xl tabular-nums [&_small]:text-xs [&_small]:font-normal [&_small]:text-muted-foreground",
  "ddt-execution-track":
    "flex items-end justify-center h-[128px] border-b border-solid border-border",
  "ddt-execution-updated": "text-muted-foreground text-xs [margin:12px_0_0]",
  "ddt-outcome":
    "[&.ddt-outcome-passed]:bg-success [&.ddt-outcome-failed]:bg-destructive [&.ddt-outcome-cancelled]:bg-muted-foreground [&.ddt-outcome-pending]:bg-info",
} as const;
