package io.autoforge.jenkins.execution;

import hudson.AbortException;
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
    private final PrintStream logger;
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
            throw new IllegalArgumentException("apiKey must be an AutoForge API key");
        }
        if (timeoutSeconds < 0 || timeoutSeconds > MAXIMUM_COMPLETION_TIMEOUT_SECONDS) {
            throw new IllegalArgumentException(
                "timeoutSeconds must be zero or between 1 and " + MAXIMUM_COMPLETION_TIMEOUT_SECONDS);
        }
        this.apiKey = apiKey;
        this.timeoutSeconds = timeoutSeconds;
        this.logger = logger;
        this.httpClient = httpClient;
        this.nanoTime = nanoTime;
        this.sleeper = sleeper;
    }

    Map<String, Object> runToCompletion(String suiteId) throws IOException, InterruptedException {
        JSONObject request = new JSONObject();
        request.put("suiteId", suiteId);
        JSONObject started = post("api/v1/jenkins/runs", request);
        String progressApiUrl = requiredString(started, "progressApiUrl");
        String progressUrl = requiredString(started, "progressUrl");
        int pollIntervalSeconds = positiveInt(
            started, "pollIntervalSeconds", DEFAULT_POLL_INTERVAL_SECONDS);
        long serverTimeoutSeconds = positiveLong(
            started,
            "completionTimeoutSeconds",
            MAXIMUM_COMPLETION_TIMEOUT_SECONDS,
            MAXIMUM_COMPLETION_TIMEOUT_SECONDS);
        long effectiveTimeoutSeconds = timeoutSeconds == 0 ? serverTimeoutSeconds : timeoutSeconds;
        long deadlineNanos = deadlineAfter(effectiveTimeoutSeconds);
        logger.printf("AutoForge: task started | progress %s%n", progressUrl);

        while (true) {
            JSONObject progress = get(URI.create(progressApiUrl));
            printProgress(progress, progressUrl);
            if (!progress.getBoolean("active")) {
                String status = requiredString(progress, "status");
                String statusLabel = requiredString(progress, "statusLabel");
                int finalFailed = nonNegativeInt(progress, "finalFailed");
                if (!"succeeded".equals(status)) {
                    throw new AbortException(
                        "AutoForge task ended with status " + status + " (" + statusLabel
                            + ", final failed " + finalFailed + "): " + progressUrl);
                }
                return result(progress, progressUrl);
            }
            sleepBeforeNextPoll(deadlineNanos, effectiveTimeoutSeconds, pollIntervalSeconds, progressUrl);
        }
    }

    private void printProgress(JSONObject progress, String progressUrl) {
        logger.printf(
            "AutoForge: 第 %d/%d 轮 | 本轮 %d/%d 已结束（通过 %d，失败 %d）| 累计通过 %d/%d | %s | %s%n",
            progress.getInt("currentRound"),
            progress.getInt("maximumRounds"),
            progress.getInt("currentRoundCompleted"),
            progress.getInt("currentRoundTotal"),
            progress.getInt("currentRoundPassed"),
            progress.getInt("currentRoundFailed"),
            progress.getInt("totalPassed"),
            progress.getInt("totalCases"),
            requiredString(progress, "statusLabel"),
            progressUrl);
    }

    private Map<String, Object> result(JSONObject progress, String progressUrl) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("batchId", requiredString(progress, "batchId"));
        result.put("status", requiredString(progress, "status"));
        result.put("statusLabel", requiredString(progress, "statusLabel"));
        result.put("totalCases", progress.getInt("totalCases"));
        result.put("totalPassed", progress.getInt("totalPassed"));
        result.put("finalFailed", progress.getInt("finalFailed"));
        result.put("progressUrl", progressUrl);
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
            throw new AbortException("AutoForge API returned HTTP " + response.statusCode() + ": " + safeMessage(response.body()));
        }
        return JSONObject.fromObject(response.body());
    }

    private URI resolve(String relativePath) { return baseUri.resolve(relativePath); }

    private static URI validatedBaseUri(String baseUrl) {
        URI uri = URI.create(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null) {
            throw new IllegalArgumentException("baseUrl must be an HTTP or HTTPS URL");
        }
        return uri;
    }

    private static String requiredString(JSONObject json, String key) {
        String value = json.optString(key, "");
        if (value.isBlank()) throw new IllegalArgumentException("AutoForge response is missing " + key);
        return value;
    }

    private static int positiveInt(JSONObject json, String key, int fallback) {
        int value = json.containsKey(key) ? json.optInt(key, -1) : fallback;
        if (value <= 0) throw new IllegalArgumentException("AutoForge response has invalid " + key);
        return value;
    }

    private static long positiveLong(JSONObject json, String key, long fallback, long maximum) {
        long value = json.containsKey(key) ? json.optLong(key, -1) : fallback;
        if (value <= 0 || value > maximum) {
            throw new IllegalArgumentException("AutoForge response has invalid " + key);
        }
        return value;
    }

    private static int nonNegativeInt(JSONObject json, String key) {
        int value = json.optInt(key, -1);
        if (value < 0) throw new IllegalArgumentException("AutoForge response has invalid " + key);
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
            String progressUrl) throws InterruptedException, AbortException {
        long remainingNanos = deadlineNanos - nanoTime.getAsLong();
        if (remainingNanos <= 0) throw timeout(effectiveTimeoutSeconds, progressUrl);
        long remainingMillis = Math.max(1, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
        long pollMillis = TimeUnit.SECONDS.toMillis(pollIntervalSeconds);
        sleeper.sleep(Math.min(pollMillis, remainingMillis));
        if (nanoTime.getAsLong() >= deadlineNanos) {
            throw timeout(effectiveTimeoutSeconds, progressUrl);
        }
    }

    private static AbortException timeout(long timeoutSeconds, String progressUrl) {
        return new AbortException(
            "AutoForge task did not reach a terminal state within " + timeoutSeconds
                + " seconds: " + progressUrl);
    }

    private static String safeMessage(String body) {
        try {
            JSONObject json = JSONObject.fromObject(body);
            JSONObject error = json.optJSONObject("error");
            return boundedMessage(
                error == null ? "request failed" : error.optString("message", "request failed"));
        } catch (RuntimeException ignored) {
            return "request failed";
        }
    }

    private static String boundedMessage(String value) {
        String message = value == null ? "" : value.trim();
        if (message.isEmpty()) return "request failed";
        return message.length() <= 500 ? message : message.substring(0, 500) + "…";
    }

    @FunctionalInterface
    interface Sleeper {
        void sleep(long millis) throws InterruptedException;
    }
}
