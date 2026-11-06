package io.autoforge.jenkins.dependencies;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import hudson.AbortException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.io.TempDir;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class AutoForgeDependencyClientTest {
    private HttpServer server;
    @TempDir Path temporary;

    @Test
    void streamsTheLocalFileAndComputesDigestSizeAndUtf8FilenameWithoutArtifactUrls() throws Exception {
        byte[] bytes = new byte[]{0x50, 0x4b, 3, 4, 9, 8, 7};
        Path archive = temporary.resolve("依赖 包.zip");
        Files.write(archive, bytes);
        AtomicReference<byte[]> uploaded = new AtomicReference<>();
        AtomicReference<String> digest = new AtomicReference<>();
        AtomicReference<String> name = new AtomicReference<>();
        AtomicReference<String> length = new AtomicReference<>();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/api/v1/jenkins/dependencies/upload", exchange -> {
            uploaded.set(exchange.getRequestBody().readAllBytes());
            digest.set(exchange.getRequestHeaders().getFirst("x-autoforge-sha256"));
            name.set(java.net.URLDecoder.decode(exchange.getRequestHeaders().getFirst("x-autoforge-file-name"), StandardCharsets.UTF_8));
            length.set(exchange.getRequestHeaders().getFirst("content-length"));
            assertEquals("Bearer af_api_unit-test", exchange.getRequestHeaders().getFirst("authorization"));
            respond(exchange, 201, """
                {"projectId":"project-1","projectVersionId":"version-1","version":"中文版本","assetId":"asset-upload"}
                """);
        });
        server.start();
        Map<String, Object> result = new AutoForgeDependencyClient("http://127.0.0.1:" + server.getAddress().getPort(), "af_api_unit-test", new PrintStream(new ByteArrayOutputStream()))
            .upload("project-1", "中文版本", archive, null, null);
        org.junit.jupiter.api.Assertions.assertArrayEquals(bytes, uploaded.get());
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)), digest.get());
        assertEquals("依赖 包.zip", name.get());
        assertEquals(String.valueOf(bytes.length), length.get());
        assertEquals("asset-upload", result.get("assetId"));
        assertEquals((long) bytes.length, result.get("sizeBytes"));
    }

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    @Test
    void infersGzipFormatAndEncodesTheTargetVersion() throws Exception {
        Path archive = temporary.resolve("依赖.tgz");
        Files.write(archive, new byte[]{0x1f, (byte) 0x8b, 1, 2});
        AtomicReference<String> query = new AtomicReference<>();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/api/v1/jenkins/dependencies/upload", exchange -> {
            query.set(exchange.getRequestURI().getRawQuery());
            exchange.getRequestBody().readAllBytes();
            respond(exchange, 201, """
                {"projectId":"project-1","projectVersionId":"version-1","version":"钱包 & 回归","assetId":"gzip-asset"}
                """);
        });
        server.start();
        var result = new AutoForgeDependencyClient("http://127.0.0.1:" + server.getAddress().getPort(),
                "af_api_unit-test", new PrintStream(new ByteArrayOutputStream()))
            .upload("project-1", "钱包 & 回归", archive, null, null);
        assertTrue(query.get().contains("archiveFormat=tar.gz"));
        assertTrue(query.get().contains("%26"));
        assertEquals("gzip-asset", result.get("assetId"));
    }

    @Test
    void rejectsInvalidOrEmptyArchivesBeforeConnecting() throws Exception {
        var client = new AutoForgeDependencyClient("http://127.0.0.1:1", "af_api_unit-test",
            new PrintStream(new ByteArrayOutputStream()));
        Path empty = temporary.resolve("empty.zip");
        Files.write(empty, new byte[0]);
        assertTrue(assertThrows(AbortException.class,
            () -> client.upload("project-1", "version", empty, null, null)).getMessage().contains("为空"));
        assertThrows(AbortException.class,
            () -> client.upload("project-1", "version", empty, "invalid.txt", null));
        assertThrows(AbortException.class,
            () -> client.upload("project-1", "version", empty, "../outside.zip", null));
    }

    @Test
    void exposesUploadRejectionWithoutLeakingTheCredential() throws Exception {
        Path archive = temporary.resolve("dependencies.zip");
        Files.write(archive, new byte[]{0x50, 0x4b, 3, 4});
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/api/v1/jenkins/dependencies/upload", exchange -> {
            exchange.getRequestBody().readAllBytes();
            respond(exchange, 403, """
                {"error":{"message":"没有管理项目权限 af_api_unit-test"}}
                """);
        });
        server.start();
        var client = new AutoForgeDependencyClient("http://127.0.0.1:" + server.getAddress().getPort(),
            "af_api_unit-test", new PrintStream(new ByteArrayOutputStream()));
        var failure = assertThrows(AbortException.class,
            () -> client.upload("project-1", "version", archive, null, null));
        assertTrue(failure.getMessage().contains("HTTP 403"));
        assertTrue(failure.getMessage().contains("没有管理项目权限"));
        assertTrue(!failure.getMessage().contains("af_api_unit-test"));
    }

    @Test
    void publishesVersionScopedArchiveMetadata() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        AtomicReference<String> protocol = new AtomicReference<>();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/api/v1/jenkins/dependencies", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            protocol.set(exchange.getProtocol());
            respond(exchange, 200, """
                {"projectId":"project-1","projectVersionId":"version-1",
                 "version":"1.8.0","assetId":"asset-2","replaced":true}
                """);
        });
        server.start();
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();

        Map<String, Object> result = new AutoForgeDependencyClient(
                baseUrl, "af_api_unit-test", new PrintStream(new ByteArrayOutputStream()))
            .replace(
                "project-1",
                "1.8.0",
                "https://jenkins.internal/dependencies.zip",
                "dependencies.zip",
                "a".repeat(64),
                4096,
                "zip");

        assertEquals("asset-2", result.get("assetId"));
        assertEquals("HTTP/1.1", protocol.get());
        assertTrue(requestBody.get().contains("\"version\":\"1.8.0\""));
        assertTrue(requestBody.get().contains("\"sha256\":\"" + "a".repeat(64) + "\""));
    }

    @Test
    void exposesTheBoundedServerErrorMessage() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/api/v1/jenkins/dependencies", exchange -> respond(exchange, 400, """
            {"error":{"code":"ARCHIVE_FORMAT_MISMATCH",
             "message":"文件名扩展名必须与压缩格式一致。"}}
            """));
        server.start();

        AbortException failure = assertThrows(
            AbortException.class,
            () -> new AutoForgeDependencyClient(
                    "http://127.0.0.1:" + server.getAddress().getPort(),
                    "af_api_unit-test",
                    new PrintStream(output, true, StandardCharsets.UTF_8))
                .replace(
                    "project-1",
                    "1.8.0",
                    "https://jenkins.internal/dependencies.zip",
                    "dependencies.zip",
                    "a".repeat(64),
                    4096,
                    "zip"));

        assertTrue(failure.getMessage().contains("文件名扩展名必须与压缩格式一致"));
        assertTrue(output.toString(StandardCharsets.UTF_8).contains("文件名扩展名必须与压缩格式一致"));
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
