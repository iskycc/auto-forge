package io.autoforge.jenkins.dependencies;

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

final class AutoForgeDependencyClient {
    private final URI endpoint;
    private final String apiKey;
    private final PrintStream logger;
    private final HttpClient httpClient;

    AutoForgeDependencyClient(String baseUrl, String apiKey, PrintStream logger) {
        URI baseUri = URI.create(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
        if (!("http".equals(baseUri.getScheme()) || "https".equals(baseUri.getScheme())) || baseUri.getHost() == null) {
            throw new IllegalArgumentException("baseUrl must be an HTTP or HTTPS URL");
        }
        if (apiKey == null || !apiKey.startsWith("af_api_")) {
            throw new IllegalArgumentException("apiKey must be an AutoForge API key");
        }
        this.endpoint = baseUri.resolve("api/v1/jenkins/dependencies");
        this.apiKey = apiKey;
        this.logger = logger;
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    }

    Map<String, Object> replace(
            String projectId,
            String version,
            String dependencyUrl,
            String fileName,
            String sha256,
            long sizeBytes,
            String archiveFormat) throws IOException, InterruptedException {
        validateDigest(sha256);
        if (sizeBytes <= 0) throw new IllegalArgumentException("sizeBytes must be positive");
        if (!("zip".equals(archiveFormat) || "tar.gz".equals(archiveFormat))) {
            throw new IllegalArgumentException("archiveFormat must be zip or tar.gz");
        }
        JSONObject archive = new JSONObject();
        archive.put("url", dependencyUrl);
        archive.put("fileName", fileName);
        archive.put("sha256", sha256);
        archive.put("sizeBytes", sizeBytes);
        archive.put("archiveFormat", archiveFormat);
        JSONObject body = new JSONObject();
        body.put("projectId", projectId);
        body.put("version", version);
        body.put("dependencyArchive", archive);
        HttpRequest request = HttpRequest.newBuilder(endpoint)
            .timeout(Duration.ofSeconds(30))
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .header("authorization", "Bearer " + apiKey)
            .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8))
            .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            logger.printf("AutoForge: dependency publication rejected with HTTP %d%n", response.statusCode());
            throw new AbortException("AutoForge dependency API rejected the request");
        }
        JSONObject json = JSONObject.fromObject(response.body());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("projectId", requiredString(json, "projectId"));
        result.put("projectVersionId", requiredString(json, "projectVersionId"));
        result.put("version", requiredString(json, "version"));
        result.put("assetId", requiredString(json, "assetId"));
        return result;
    }

    private static void validateDigest(String sha256) {
        if (sha256 == null || !sha256.matches("^[a-f0-9]{64}$")) {
            throw new IllegalArgumentException("sha256 must be a lowercase SHA-256 digest");
        }
    }

    private static String requiredString(JSONObject json, String key) {
        String value = json.optString(key, "");
        if (value.isBlank()) throw new IllegalArgumentException("AutoForge response is missing " + key);
        return value;
    }
}
