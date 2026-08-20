package io.autoforge.jenkins.dependencies;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
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
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/api/v1/jenkins/dependencies", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
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
        assertTrue(requestBody.get().contains("\"version\":\"1.8.0\""));
        assertTrue(requestBody.get().contains("\"sha256\":\"" + "a".repeat(64) + "\""));
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
