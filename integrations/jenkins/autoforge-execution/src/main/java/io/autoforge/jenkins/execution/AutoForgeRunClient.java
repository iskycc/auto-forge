package io.autoforge.jenkins.execution;

import hudson.AbortException;
import io.autoforge.jenkins.console.AutoForgeConsoleLog;
import java.io.IOException;
import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import net.sf.json.JSONObject;

final class AutoForgeRunClient {
    static final long MAXIMUM_COMPLETION_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
    private static final int DEFAULT_POLL_INTERVAL_SECONDS = 30;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);

    private final URI baseUri;
    private final String apiKey;
    private final long timeoutSeconds;
    private final AutoForgeConsoleLog console;
    private final HttpClient httpClient;
    private final LongSupplier nanoTime;
    private final Sleeper sleeper;

    AutoForgeRunClient(String baseUrl, String apiKey, long timeoutSeconds, PrintStream logger) {
        this(
            baseUrl,
            apiKey,
            timeoutSeconds,
            logger,
            HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(15))
                .build(),
            System::nanoTime,
            Thread::sleep);
    }

    AutoForgeRunClient(
            String baseUrl,
            String apiKey,
            long timeoutSeconds,
            PrintStream logger,
            HttpClient httpClient,
            LongSupplier nanoTime,
            Sleeper sleeper) {
        this.baseUri = validatedBaseUri(baseUrl);
        if (apiKey == null || !apiKey.startsWith("af_api_")) {
            throw new IllegalArgumentException("apiKey 必须是以 af_api_ 开头的 AutoForge API 密钥。");
        }
        if (timeoutSeconds < 0 || timeoutSeconds > MAXIMUM_COMPLETION_TIMEOUT_SECONDS) {
            throw new IllegalArgumentException(
                "timeoutSeconds 必须为 0（采用平台建议值），或 1～" + MAXIMUM_COMPLETION_TIMEOUT_SECONDS + " 秒。");
        }
        this.apiKey = apiKey;
        this.timeoutSeconds = timeoutSeconds;
        this.console = new AutoForgeConsoleLog(logger, apiKey);
        this.httpClient = httpClient;
        this.nanoTime = nanoTime;
        this.sleeper = sleeper;
    }

    Map<String, Object> runToCompletion(String suiteId) throws IOException, InterruptedException {
        AutoForgeRunLog executionLog = new AutoForgeRunLog(console, nanoTime);
        JSONObject request = new JSONObject();
        request.put("suiteId", suiteId);
        JSONObject started = post("api/v1/jenkins/runs", request);
        try {
            return awaitCompletion(started, suiteId, executionLog);
        } catch (InterruptedException failure) {
            executionLog.interrupted();
            throw failure;
        }
    }

    private Map<String, Object> awaitCompletion(JSONObject started, String suiteId, AutoForgeRunLog executionLog)
            throws IOException, InterruptedException {
        String progressApiUrl = requiredString(started, "progressApiUrl");
        String progressUrl = requiredString(started, "progressUrl");
        String resultUrl = optionalString(started, "resultUrl", progressUrl);
        boolean permanentResultAvailable = !started.optString("resultUrl", "").isBlank();
        int pollIntervalSeconds = positiveInt(
            started, "pollIntervalSeconds", DEFAULT_POLL_INTERVAL_SECONDS);
        long serverTimeoutSeconds = positiveLong(
            started,
            "completionTimeoutSeconds",
            MAXIMUM_COMPLETION_TIMEOUT_SECONDS,
            MAXIMUM_COMPLETION_TIMEOUT_SECONDS);
        long effectiveTimeoutSeconds = timeoutSeconds == 0 ? serverTimeoutSeconds : timeoutSeconds;
        long deadlineNanos = deadlineAfter(effectiveTimeoutSeconds);
        executionLog.started(suiteId, requiredString(started, "batchId"), progressUrl,
            pollIntervalSeconds, effectiveTimeoutSeconds);

        while (true) {
            JSONObject progress = get(URI.create(progressApiUrl));
            executionLog.progress(progress);
            if (!progress.getBoolean("active")) {
                String status = requiredString(progress, "status");
                int finalFailed = nonNegativeInt(progress, "finalFailed");
                executionLog.completed(progress, resultUrl, permanentResultAvailable);
                if (!"succeeded".equals(status)) {
                    throw new AbortException(
                        "AutoForge " + AutoForgeRunLog.statusLabel(status) + "，最终失败 " + finalFailed
                            + " 项；请点击上方“" + (permanentResultAvailable ? "完整结果" : "执行结果") + "”查看详情。");
                }
                return result(progress, progressUrl, resultUrl);
            }
            sleepBeforeNextPoll(deadlineNanos, effectiveTimeoutSeconds, pollIntervalSeconds, progressUrl, executionLog);
        }
    }

    private Map<String, Object> result(JSONObject progress, String progressUrl, String resultUrl) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("batchId", requiredString(progress, "batchId"));
        result.put("status", requiredString(progress, "status"));
        result.put("statusLabel", requiredString(progress, "statusLabel"));
        result.put("totalCases", progress.getInt("totalCases"));
        result.put("totalPassed", progress.getInt("totalPassed"));
        result.put("finalFailed", progress.getInt("finalFailed"));
        result.put("progressUrl", progressUrl);
        result.put("resultUrl", resultUrl);
        return result;
    }

    private JSONObject post(String relativePath, JSONObject body) throws IOException, InterruptedException {
        HttpRequest request = authenticatedRequest(resolve(relativePath))
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build();
        return send(request);
    }

    private JSONObject get(URI uri) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(uri)
            .timeout(REQUEST_TIMEOUT)
            .header("accept", "application/json")
            .GET()
            .build();
        return send(request);
    }

    private HttpRequest.Builder authenticatedRequest(URI uri) {
        return HttpRequest.newBuilder(uri)
            .timeout(REQUEST_TIMEOUT)
            .header("accept", "application/json")
            .header("authorization", "Bearer " + apiKey);
    }

    private JSONObject send(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new AbortException("AutoForge 请求失败（HTTP " + response.statusCode() + "）：" + safeMessage(response.body()));
        }
        return JSONObject.fromObject(response.body());
    }

    private URI resolve(String relativePath) { return baseUri.resolve(relativePath); }

    private static URI validatedBaseUri(String baseUrl) {
        URI uri = URI.create(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null) {
            throw new IllegalArgumentException("baseUrl 必须是有效的 HTTP 或 HTTPS 地址。");
        }
        return uri;
    }

    private static String requiredString(JSONObject json, String key) {
        String value = json.optString(key, "");
        if (value.isBlank()) throw new IllegalArgumentException("AutoForge 响应缺少必要字段：" + key);
        return value;
    }

    private static String optionalString(JSONObject json, String key, String fallback) {
        String value = json.optString(key, "");
        return value.isBlank() ? fallback : value;
    }

    private static int positiveInt(JSONObject json, String key, int fallback) {
        int value = json.containsKey(key) ? json.optInt(key, -1) : fallback;
        if (value <= 0) throw new IllegalArgumentException("AutoForge 响应字段无效：" + key);
        return value;
    }

    private static long positiveLong(JSONObject json, String key, long fallback, long maximum) {
        long value = json.containsKey(key) ? json.optLong(key, -1) : fallback;
        if (value <= 0 || value > maximum) {
            throw new IllegalArgumentException("AutoForge 响应字段无效：" + key);
        }
        return value;
    }

    private static int nonNegativeInt(JSONObject json, String key) {
        int value = json.optInt(key, -1);
        if (value < 0) throw new IllegalArgumentException("AutoForge 响应字段无效：" + key);
        return value;
    }

    private long deadlineAfter(long durationSeconds) {
        long now = nanoTime.getAsLong();
        long durationNanos = TimeUnit.SECONDS.toNanos(durationSeconds);
        return Long.MAX_VALUE - now < durationNanos ? Long.MAX_VALUE : now + durationNanos;
    }

    private void sleepBeforeNextPoll(
            long deadlineNanos,
            long effectiveTimeoutSeconds,
            int pollIntervalSeconds,
            String progressUrl,
            AutoForgeRunLog executionLog) throws InterruptedException, AbortException {
        long remainingNanos = deadlineNanos - nanoTime.getAsLong();
        if (remainingNanos <= 0) throw timeout(effectiveTimeoutSeconds, progressUrl, executionLog);
        long remainingMillis = Math.max(1, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
        long pollMillis = TimeUnit.SECONDS.toMillis(pollIntervalSeconds);
        sleeper.sleep(Math.min(pollMillis, remainingMillis));
        if (nanoTime.getAsLong() >= deadlineNanos) {
            throw timeout(effectiveTimeoutSeconds, progressUrl, executionLog);
        }
    }

    private static AbortException timeout(long timeoutSeconds, String progressUrl, AutoForgeRunLog executionLog) {
        executionLog.timedOut(timeoutSeconds, progressUrl);
        return new AbortException(
            "AutoForge 等待超时（" + AutoForgeConsoleLog.duration(timeoutSeconds)
                + "）；平台中的批次未取消，请点击上方“实时进度”继续查看。");
    }

    private String safeMessage(String body) {
        try {
            JSONObject json = JSONObject.fromObject(body);
            JSONObject error = json.optJSONObject("error");
            String message = console.safeText(error == null ? "" : error.optString("message", ""));
            return message.isEmpty() ? "平台未提供具体原因，请检查服务状态与访问权限。" : message;
        } catch (RuntimeException ignored) {
            return "平台返回了无法识别的错误响应，请检查服务状态与反向代理配置。";
        }
    }

    @FunctionalInterface
    interface Sleeper {
        void sleep(long millis) throws InterruptedException;
    }
}
