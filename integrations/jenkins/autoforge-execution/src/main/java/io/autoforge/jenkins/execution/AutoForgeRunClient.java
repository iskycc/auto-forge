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
    private static final long TERMINATION_POLL_MILLIS = 5_000;

    private final URI baseUri;
    private final String apiKey;
    private final long timeoutSeconds;
    private final AutoForgeConsoleLog console;
    private final HttpClient httpClient;
    private final LongSupplier nanoTime;
    private final Sleeper sleeper;
    private final Sleeper terminationSleeper;
    private final AutoForgeRunCancellation cancellation;

    AutoForgeRunClient(String baseUrl, String apiKey, long timeoutSeconds, PrintStream logger) {
        this(baseUrl, apiKey, timeoutSeconds, logger, new AutoForgeRunCancellation());
    }

    AutoForgeRunClient(String baseUrl, String apiKey, long timeoutSeconds, PrintStream logger,
            AutoForgeRunCancellation cancellation) {
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
            cancellation::awaitNextPoll,
            Thread::sleep,
            cancellation);
    }

    AutoForgeRunClient(
            String baseUrl,
            String apiKey,
            long timeoutSeconds,
            PrintStream logger,
            HttpClient httpClient,
            LongSupplier nanoTime,
            Sleeper sleeper) {
        this(baseUrl, apiKey, timeoutSeconds, logger, httpClient, nanoTime, sleeper, sleeper,
            new AutoForgeRunCancellation());
    }

    AutoForgeRunClient(
            String baseUrl, String apiKey, long timeoutSeconds, PrintStream logger,
            HttpClient httpClient, LongSupplier nanoTime, Sleeper sleeper, Sleeper terminationSleeper,
            AutoForgeRunCancellation cancellation) {
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
        this.terminationSleeper = terminationSleeper;
        this.cancellation = cancellation;
    }

    Map<String, Object> runToCompletion(String suiteId) throws IOException, InterruptedException {
        if (cancellation.isRequested()) throw new InterruptedException("Pipeline stopped before batch creation");
        AutoForgeRunLog executionLog = new AutoForgeRunLog(console, nanoTime);
        JSONObject request = new JSONObject();
        request.put("suiteId", suiteId);
        JSONObject started;
        try {
            started = post("api/v1/jenkins/runs", request);
        } catch (IOException | InterruptedException failure) {
            if (cancellation.isRequested()) executionLog.creationUnconfirmed(suiteId);
            throw failure;
        }
        return awaitCompletion(started, suiteId, executionLog);
    }

    private Map<String, Object> awaitCompletion(JSONObject started, String suiteId, AutoForgeRunLog executionLog)
            throws IOException, InterruptedException {
        String progressApiUrl = requiredString(started, "progressApiUrl");
        String progressUrl = requiredString(started, "progressUrl");
        String resultUrl = optionalString(started, "resultUrl", progressUrl);
        AutoForgeResultLink resultLink = new AutoForgeResultLink(resultUrl,
            started.optString("resultUrl", "").isBlank()
                ? AutoForgeResultLink.Lifetime.TEMPORARY : AutoForgeResultLink.Lifetime.PERMANENT);
        int pollIntervalSeconds = positiveInt(
            started, "pollIntervalSeconds", DEFAULT_POLL_INTERVAL_SECONDS);
        long serverTimeoutSeconds = positiveLong(
            started,
            "completionTimeoutSeconds",
            MAXIMUM_COMPLETION_TIMEOUT_SECONDS,
            MAXIMUM_COMPLETION_TIMEOUT_SECONDS);
        long effectiveTimeoutSeconds = timeoutSeconds == 0 ? serverTimeoutSeconds : timeoutSeconds;
        long deadlineNanos = deadlineAfter(effectiveTimeoutSeconds);
        executionLog.started(suiteId, requiredString(started, "batchId"), resultLink,
            pollIntervalSeconds, effectiveTimeoutSeconds);

        String batchId = requiredString(started, "batchId");
        InterruptedException interruptedFailure = null;
        try {
            while (!cancellation.isRequested()) {
                JSONObject progress = get(URI.create(progressApiUrl));
                executionLog.progress(progress);
                if (isTerminal(progress, batchId)) {
                    executionLog.completed(progress, resultLink);
                    if (!"succeeded".equals(progress.getString("status"))) {
                        throw new AbortException(
                            "AutoForge " + AutoForgeRunLog.statusLabel(progress.getString("status"))
                                + "，最终失败 " + nonNegativeInt(progress, "finalFailed")
                                + " 项；请点击上方“" + resultLink.resultLabel() + "”查看详情。");
                    }
                    return result(progress, resultUrl);
                }
                if (!cancellation.isRequested()) {
                    sleepBeforeNextPoll(deadlineNanos, effectiveTimeoutSeconds, pollIntervalSeconds, resultLink, executionLog);
                }
            }
        } catch (InterruptedException interrupted) {
            interruptedFailure = interrupted;
            cancellation.request();
            // Cleanup uses a fresh, bounded wait and must be able to perform HTTP I/O.
            Thread.interrupted();
        } catch (IOException failure) {
            if (!cancellation.isRequested()) throw failure;
        }
        Map<String, Object> stoppedResult = terminateAndAwait(batchId, serverTimeoutSeconds, resultLink, executionLog);
        if (interruptedFailure != null) throw interruptedFailure;
        return stoppedResult;
    }

    private Map<String, Object> terminateAndAwait(String batchId, long maximumWaitSeconds,
            AutoForgeResultLink resultLink, AutoForgeRunLog executionLog) throws IOException, InterruptedException {
        long deadline = deadlineAfter(maximumWaitSeconds);
        String batchPath = "api/v1/run-batches/" + encodePathSegment(batchId);
        JSONObject request = new JSONObject();
        request.put("reason", "Jenkins Pipeline 已收到停止要求，终止后续执行并等待当前用例收尾。");
        boolean accepted = false;
        long retryMillis = TERMINATION_POLL_MILLIS;
        IOException lastFailure = null;
        executionLog.terminationRequested(maximumWaitSeconds);
        try {
            while (nanoTime.getAsLong() < deadline) {
                try {
                    if (!accepted) {
                        JSONObject response = post(batchPath + "/terminate", request);
                        if (!batchId.equals(requiredString(response, "batchId"))) {
                            throw new IllegalArgumentException("终止响应的执行批次与当前 Pipeline 不一致。");
                        }
                        accepted = true;
                        executionLog.terminationAccepted();
                    }
                    // Use the configured control plane and API key: the original progress token may expire during drain.
                    JSONObject progress = send(authenticatedRequest(resolve(batchPath + "/progress")).GET().build());
                    executionLog.progress(progress);
                    if (isTerminal(progress, batchId)) {
                        executionLog.completed(progress, resultLink);
                        return result(progress, resultLink.url());
                    }
                    retryMillis = TERMINATION_POLL_MILLIS;
                } catch (IOException failure) {
                    if (failure instanceof RequestFailure response && !response.retryable()) throw failure;
                    lastFailure = failure;
                    executionLog.terminationRetry(accepted);
                    retryMillis = Math.min(30_000, retryMillis * 2);
                }
                long remainingMillis = Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline - nanoTime.getAsLong()));
                terminationSleeper.sleep(Math.min(retryMillis, remainingMillis));
            }
            AbortException expired = new AbortException("AutoForge 终止等待已超过期限，尚未确认批次完全结束。");
            if (lastFailure != null) expired.initCause(lastFailure);
            throw expired;
        } catch (IOException | InterruptedException | RuntimeException failure) {
            executionLog.terminationUnconfirmed(resultLink,
                failure instanceof RequestFailure response ? response.statusCode : null);
            throw failure;
        }
    }

    private static boolean isTerminal(JSONObject progress, String batchId) {
        if (!batchId.equals(requiredString(progress, "batchId"))) {
            throw new IllegalArgumentException("进度响应的执行批次与当前 Pipeline 不一致。");
        }
        String status = requiredString(progress, "status");
        boolean terminal = "succeeded".equals(status) || "failed".equals(status) || "cancelled".equals(status);
        if (progress.getBoolean("active") == terminal) {
            throw new IllegalArgumentException("平台返回的执行状态与活跃标记不一致，无法确认终态。");
        }
        return terminal;
    }

    private static String encodePathSegment(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private Map<String, Object> result(JSONObject progress, String resultUrl) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("batchId", requiredString(progress, "batchId"));
        result.put("status", requiredString(progress, "status"));
        result.put("statusLabel", requiredString(progress, "statusLabel"));
        result.put("totalCases", progress.getInt("totalCases"));
        result.put("totalPassed", progress.getInt("totalPassed"));
        result.put("finalFailed", progress.getInt("finalFailed"));
        result.put("progressUrl", resultUrl);
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
            throw new RequestFailure(response.statusCode(), safeMessage(response.body()));
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
            AutoForgeResultLink resultLink,
            AutoForgeRunLog executionLog) throws InterruptedException, AbortException {
        long remainingNanos = deadlineNanos - nanoTime.getAsLong();
        if (remainingNanos <= 0) throw timeout(effectiveTimeoutSeconds, resultLink, executionLog);
        long remainingMillis = Math.max(1, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
        long pollMillis = TimeUnit.SECONDS.toMillis(pollIntervalSeconds);
        sleeper.sleep(Math.min(pollMillis, remainingMillis));
        if (!cancellation.isRequested() && nanoTime.getAsLong() >= deadlineNanos) {
            throw timeout(effectiveTimeoutSeconds, resultLink, executionLog);
        }
    }

    private static AbortException timeout(long timeoutSeconds, AutoForgeResultLink resultLink, AutoForgeRunLog executionLog) {
        executionLog.timedOut(timeoutSeconds, resultLink);
        return new AbortException(
            "AutoForge 等待超时（" + AutoForgeConsoleLog.duration(timeoutSeconds)
                + "）；平台中的批次未取消，请点击上方“执行详情”继续查看。");
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

    private static final class RequestFailure extends AbortException {
        @java.io.Serial private static final long serialVersionUID = 1L;
        private final int statusCode;

        RequestFailure(int statusCode, String message) {
            super("AutoForge 请求失败（HTTP " + statusCode + "）：" + message);
            this.statusCode = statusCode;
        }

        boolean retryable() {
            return statusCode == 408 || statusCode == 409 || statusCode == 429 || statusCode >= 500;
        }
    }
}
