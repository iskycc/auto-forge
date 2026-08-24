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
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class AutoForgeDependencyClientTest {
    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
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
