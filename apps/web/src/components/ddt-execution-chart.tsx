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
    <article className="card ddt-chart-card ddt-execution-chart" aria-label="DDT 近 7 日执行统计">
      <header>
        <div>
          <strong>近 7 日执行</strong>
          <span>按执行创建日期（UTC）· 重试不重复计数</span>
        </div>
        <b className="ddt-execution-total">
          {execution ? total.toLocaleString() : "—"}
          <small> 次</small>
        </b>
      </header>
      {execution ? (
        <>
          <div className="ddt-execution-legend" aria-label="执行结果汇总">
            {counts.map(({ key, label, count }) => (
              <span key={key}>
                <i className={`ddt-outcome-${key}`} />
                {label} <b>{count.toLocaleString()}</b>
              </span>
            ))}
          </div>
          <div className="ddt-execution-bars" aria-label="近 7 日 DDT 执行柱形图">
            {timeline.map((day) => {
              const description = `${day.date}：共 ${day.total} 次，${outcomes.map(([key, label]) => `${label} ${day[key]}`).join("，")}`;
              return (
                <div
                  key={day.date}
                  className="ddt-execution-day"
                  aria-label={description}
                  title={description}
                >
                  <b>{day.total.toLocaleString()}</b>
                  <div className="ddt-execution-track">
                    <div
                      className="ddt-execution-stack"
                      style={{ height: `${(day.total / maximum) * 100}%` }}
                    >
                      {outcomes.map(([key]) => (
                        <i
                          key={key}
                          className={`ddt-outcome-${key}`}
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
          {total === 0 ? <p className="ddt-execution-empty">近 7 日暂无 DDT 执行记录</p> : null}
          <p className="ddt-execution-updated">
            统计更新于{" "}
            <time dateTime={execution.generatedAt} title={execution.generatedAt}>
              {formatPlatformDateTime(execution.generatedAt)}
            </time>
          </p>
        </>
      ) : (
        <p className="ddt-chart-empty">后台正在准备执行统计</p>
      )}
    </article>
  );
}
