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
import net.sf.json.JSONObject;

final class AutoForgeRunClient {
    private final URI baseUri;
    private final String apiKey;
    private final int pollIntervalSeconds;
    private final PrintStream logger;
    private final HttpClient httpClient;

    AutoForgeRunClient(String baseUrl, String apiKey, int pollIntervalSeconds, PrintStream logger) {
        this(baseUrl, apiKey, pollIntervalSeconds, logger,
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build());
    }

    AutoForgeRunClient(
            String baseUrl,
            String apiKey,
            int pollIntervalSeconds,
            PrintStream logger,
            HttpClient httpClient) {
        this.baseUri = validatedBaseUri(baseUrl);
        if (apiKey == null || !apiKey.startsWith("af_api_")) {
            throw new IllegalArgumentException("apiKey must be an AutoForge API key");
        }
        if (pollIntervalSeconds <= 0) {
            throw new IllegalArgumentException("pollIntervalSeconds must be positive");
        }
        this.apiKey = apiKey;
        this.pollIntervalSeconds = pollIntervalSeconds;
        this.logger = logger;
        this.httpClient = httpClient;
    }

    Map<String, Object> runToCompletion(String suiteId) throws IOException, InterruptedException {
        JSONObject request = new JSONObject();
        request.put("suiteId", suiteId);
        JSONObject started = post("api/v1/jenkins/runs", request);
        String progressApiUrl = requiredString(started, "progressApiUrl");
        String progressUrl = requiredString(started, "progressUrl");
        logger.printf("AutoForge: task started | progress %s%n", progressUrl);

        while (true) {
            JSONObject progress = get(URI.create(progressApiUrl));
            printProgress(progress, progressUrl);
            if (!progress.getBoolean("active")) {
                String statusLabel = requiredString(progress, "statusLabel");
                if (!"执行完成".equals(statusLabel)) {
                    throw new AbortException("AutoForge task ended with " + statusLabel + ": " + progressUrl);
                }
                return result(progress, progressUrl);
            }
            Thread.sleep(Duration.ofSeconds(pollIntervalSeconds).toMillis());
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
            .timeout(Duration.ofSeconds(30))
            .header("accept", "application/json")
            .GET()
            .build();
        return send(request);
    }

    private HttpRequest.Builder authenticatedRequest(URI uri) {
        return HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(30))
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

    private static String safeMessage(String body) {
        try {
            JSONObject json = JSONObject.fromObject(body);
            JSONObject error = json.optJSONObject("error");
            return error == null ? "request failed" : error.optString("message", "request failed");
        } catch (RuntimeException ignored) {
            return "request failed";
        }
    }
}
