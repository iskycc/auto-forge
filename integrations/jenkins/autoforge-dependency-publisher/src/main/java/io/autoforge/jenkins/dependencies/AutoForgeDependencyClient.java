package io.autoforge.jenkins.dependencies;

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
import net.sf.json.JSONObject;

final class AutoForgeDependencyClient {
    private final URI endpoint;
    private final String apiKey;
    private final AutoForgeConsoleLog console;
    private final HttpClient httpClient;

    AutoForgeDependencyClient(String baseUrl, String apiKey, PrintStream logger) {
        URI baseUri = URI.create(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
        if (!("http".equals(baseUri.getScheme()) || "https".equals(baseUri.getScheme())) || baseUri.getHost() == null) {
            throw new IllegalArgumentException("baseUrl 必须是有效的 HTTP 或 HTTPS 地址。");
        }
        if (apiKey == null || !apiKey.startsWith("af_api_")) {
            throw new IllegalArgumentException("apiKey 必须是以 af_api_ 开头的 AutoForge API 密钥。");
        }
        this.endpoint = baseUri.resolve("api/v1/jenkins/dependencies");
        this.apiKey = apiKey;
        this.console = new AutoForgeConsoleLog(logger, apiKey);
        this.httpClient = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(15))
            .build();
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
        if (sizeBytes <= 0) throw new IllegalArgumentException("sizeBytes 必须是大于 0 的实际文件字节数。");
        if (!("zip".equals(archiveFormat) || "tar.gz".equals(archiveFormat))) {
            throw new IllegalArgumentException("archiveFormat 只支持 zip 或 tar.gz。");
        }
        console.section("发布依赖");
        console.field("目标项目", projectId);
        console.field("项目版本", version);
        console.field("依赖文件", fileName + "（" + AutoForgeConsoleLog.size(sizeBytes) + "）");
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
            String message = safeMessage(response.body());
            console.section("依赖发布失败");
            console.field("失败原因", "HTTP " + response.statusCode() + " · " + message);
            throw new AbortException(
                "AutoForge 依赖发布失败（HTTP " + response.statusCode() + "）：" + message);
        }
        JSONObject json = JSONObject.fromObject(response.body());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("projectId", requiredString(json, "projectId"));
        result.put("projectVersionId", requiredString(json, "projectVersionId"));
        result.put("version", requiredString(json, "version"));
        result.put("assetId", requiredString(json, "assetId"));
        console.section("依赖发布完成");
        console.field("项目版本", requiredString(json, "version"));
        console.field("资产编号", requiredString(json, "assetId"));
        console.link("依赖下载", dependencyUrl, "下载依赖包", "在新标签页打开");
        console.field("发布说明", "当前版本已更新为本次依赖，后续新建批次将使用最新配置。");
        return result;
    }

    private static void validateDigest(String sha256) {
        if (sha256 == null || !sha256.matches("^[a-f0-9]{64}$")) {
            throw new IllegalArgumentException("sha256 必须是 64 位小写十六进制 SHA-256 摘要。");
        }
    }

    private static String requiredString(JSONObject json, String key) {
        String value = json.optString(key, "");
        if (value.isBlank()) throw new IllegalArgumentException("AutoForge 响应缺少必要字段：" + key);
        return value;
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
}
