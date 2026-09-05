package io.autoforge.jenkins.execution;

import io.autoforge.jenkins.console.AutoForgeConsoleLog;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import net.sf.json.JSONObject;

final class AutoForgeRunLog {
    private static final long PROGRESS_REMINDER_NANOS = TimeUnit.SECONDS.toNanos(60);
    private final AutoForgeConsoleLog console;
    private final LongSupplier nanoTime;
    private final long startedNanos;
    private String lastProgress;
    private long lastProgressNanos;
    private boolean suiteNamePrinted;

    AutoForgeRunLog(AutoForgeConsoleLog console, LongSupplier nanoTime) {
        this.console = console;
        this.nanoTime = nanoTime;
        this.startedNanos = nanoTime.getAsLong();
    }

    void started(String suiteId, String batchId, String progressUrl, int pollSeconds, long timeoutSeconds) {
        console.section("开始执行");
        console.field("任务编号", suiteId);
        console.field("执行批次", batchId);
        console.field("等待设置", "每 " + AutoForgeConsoleLog.duration(pollSeconds) + "检查进度，最多等待 "
            + AutoForgeConsoleLog.duration(timeoutSeconds));
        console.link("查看进度", progressUrl, "实时进度", "7 天内有效，在新标签页打开");
    }

    void progress(JSONObject progress) {
        String suiteName = progress.optString("suiteName", "");
        if (!suiteNamePrinted && !suiteName.isBlank()) {
            console.field("任务名称", suiteName);
            suiteNamePrinted = true;
        }
        String summary = String.format(Locale.ROOT,
            "%s | 第 %d/%d 轮 | 本轮完成 %d/%d（通过 %d，失败 %d）| 累计通过 %d/%d",
            statusLabel(progress.getString("status")),
            progress.getInt("currentRound"), progress.getInt("maximumRounds"),
            progress.getInt("currentRoundCompleted"), progress.getInt("currentRoundTotal"),
            progress.getInt("currentRoundPassed"), progress.getInt("currentRoundFailed"),
            progress.getInt("totalPassed"), progress.getInt("totalCases"));
        long now = nanoTime.getAsLong();
        if (summary.equals(lastProgress) && now - lastProgressNanos < PROGRESS_REMINDER_NANOS) return;
        console.field("执行进度", summary + " | 已等待 " + elapsed());
        lastProgress = summary;
        lastProgressNanos = now;
    }

    void completed(JSONObject progress, String resultUrl, boolean permanent) {
        int totalCases = progress.getInt("totalCases");
        int passed = progress.getInt("totalPassed");
        int failed = progress.getInt("finalFailed");
        String status = progress.getString("status");
        String passRate = totalCases == 0 ? "—" : String.format(Locale.ROOT, "%.1f%%", 100.0 * passed / totalCases);
        console.section(statusLabel(status));
        console.field("用例汇总", "总计 " + totalCases + " | 通过 " + passed + " | 最终失败 " + failed
            + " | 通过率 " + passRate);
        console.field("等待耗时", elapsed());
        console.link("查看结果", resultUrl, permanent ? "完整结果" : "执行结果",
            permanent ? "永久有效，在新标签页打开" : "7 天内有效，在新标签页打开");
        if ("succeeded".equals(status) && failed > 0) {
            console.field("结果说明", "执行流程已完成，仍有 " + failed + " 项用例失败，请查看结果定位原因。");
        }
    }

    void timedOut(long timeoutSeconds, String progressUrl) {
        console.section("等待超时");
        console.field("等待上限", AutoForgeConsoleLog.duration(timeoutSeconds));
        console.field("后续处理", "Jenkins 已停止等待，AutoForge 中的批次未取消，可继续查看实时进度。");
        console.link("查看进度", progressUrl, "实时进度", "7 天内有效，在新标签页打开");
    }

    void interrupted() {
        console.section("等待中断");
        console.field("后续处理", "Jenkins 等待已中断，AutoForge 中的批次未取消，可通过上方实时进度继续查看。");
    }

    static String statusLabel(String status) {
        return switch (status) {
            case "queued" -> "排队中";
            case "dispatching" -> "分配中";
            case "scheduled" -> "已分配";
            case "running" -> "执行中";
            case "succeeded" -> "执行完成";
            case "failed" -> "执行异常";
            case "cancelled" -> "执行中断";
            default -> "未知状态";
        };
    }

    private String elapsed() {
        return AutoForgeConsoleLog.duration(Math.max(0, TimeUnit.NANOSECONDS.toSeconds(nanoTime.getAsLong() - startedNanos)));
    }
}
