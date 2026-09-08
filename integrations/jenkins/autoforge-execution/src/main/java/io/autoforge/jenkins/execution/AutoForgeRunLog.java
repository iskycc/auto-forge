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
    private Long lastTerminationRetryNanos;

    AutoForgeRunLog(AutoForgeConsoleLog console, LongSupplier nanoTime) {
        this.console = console;
        this.nanoTime = nanoTime;
        this.startedNanos = nanoTime.getAsLong();
    }

    void started(String suiteId, String batchId, AutoForgeResultLink resultLink, int pollSeconds, long timeoutSeconds) {
        console.section("开始执行");
        console.field("任务编号", suiteId);
        console.field("执行批次", batchId);
        console.field("等待设置", "每 " + AutoForgeConsoleLog.duration(pollSeconds) + "检查进度，最多等待 "
            + AutoForgeConsoleLog.duration(timeoutSeconds));
        console.link("查看进度", resultLink.url(), "执行详情", resultLink.validityHint());
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

    void completed(JSONObject progress, AutoForgeResultLink resultLink) {
        int totalCases = progress.getInt("totalCases");
        int passed = progress.getInt("totalPassed");
        int failed = progress.getInt("finalFailed");
        String status = progress.getString("status");
        String passRate = totalCases == 0 ? "—" : String.format(Locale.ROOT, "%.1f%%", 100.0 * passed / totalCases);
        console.section(statusLabel(status));
        console.field("用例汇总", "总计 " + totalCases + " | 通过 " + passed + " | 最终失败 " + failed
            + " | 通过率 " + passRate);
        console.field("等待耗时", elapsed());
        if ("cancelled".equals(status)) {
            console.field("终止汇总", "已取消/未执行 " + Math.max(0, totalCases - passed - failed) + " 项");
        }
        console.link("查看结果", resultLink.url(), resultLink.resultLabel(), resultLink.validityHint());
        if ("succeeded".equals(status) && failed > 0) {
            console.field("结果说明", "执行流程已完成，仍有 " + failed + " 项用例失败，请查看结果定位原因。");
        }
    }

    void timedOut(long timeoutSeconds, AutoForgeResultLink resultLink) {
        console.section("等待超时");
        console.field("等待上限", AutoForgeConsoleLog.duration(timeoutSeconds));
        console.field("后续处理", "Jenkins 已停止等待，AutoForge 中的批次未取消，可继续查看执行详情。");
        console.link("查看进度", resultLink.url(), "执行详情", resultLink.validityHint());
    }

    void terminationRequested(long maximumWaitSeconds) {
        console.section("请求终止");
        console.field("停止要求", "Jenkins 已请求停止，正在通知 AutoForge 终止当前批次。");
        console.field("收尾等待", "最多等待 " + AutoForgeConsoleLog.duration(maximumWaitSeconds)
            + "，确认终态后输出最终执行报告。");
    }

    void creationUnconfirmed(String suiteId) {
        console.section("创建结果未确认");
        console.field("任务编号", suiteId);
        console.field("后续处理", "停止时未获得批次创建回执，平台可能已经创建批次；请到 AutoForge 执行历史确认并终止。"
            + "插件不会重复创建任务。");
    }

    void terminationAccepted() {
        console.field("终止进度", "平台已接受终止请求；正在等待已领取用例完成并上传结果，尚未确认完全结束。");
    }

    void terminationRetry(boolean accepted) {
        long now = nanoTime.getAsLong();
        if (lastTerminationRetryNanos != null && now - lastTerminationRetryNanos < PROGRESS_REMINDER_NANOS) return;
        console.field("终止重试", accepted
            ? "暂时无法读取收尾进度，将继续重试；尚未确认完全结束。"
            : "暂时无法确认终止请求是否送达，将重试同一批次的终止请求。");
        lastTerminationRetryNanos = now;
    }

    void terminationUnconfirmed(AutoForgeResultLink resultLink, Integer statusCode) {
        console.section("终止未确认");
        console.field("后续处理", "未能确认 AutoForge 批次完全结束，请从执行详情检查平台状态并按需手动终止。");
        if (statusCode != null) {
            console.field("请求错误", "HTTP " + statusCode + "；请检查平台接口和 API Key 的 run.cancel、run.read 权限。");
        }
        console.link("查看报告", resultLink.url(), "执行详情", resultLink.validityHint());
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
