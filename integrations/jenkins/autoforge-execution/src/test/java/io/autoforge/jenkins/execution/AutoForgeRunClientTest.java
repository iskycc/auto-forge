package io.autoforge.jenkins.execution;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
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

class AutoForgeRunClientTest {
    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    @Test
    void waitsForTerminalProgressAndPrintsTheExternalLink() throws Exception {
        AtomicReference<String> authorization = new AtomicReference<>();
        AtomicReference<String> progressAuthorization = new AtomicReference<>();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> {
            authorization.set(exchange.getRequestHeaders().getFirst("authorization"));
            respond(exchange, 201, """
                {"batchId":"batch-1","progressUrl":"%sprogress/batch-1?access_token=read-only",
                 "progressApiUrl":"%sapi/v1/run-batches/batch-1/progress?access_token=read-only"}
                """.formatted(baseUrl, baseUrl));
        });
        server.createContext("/api/v1/run-batches/batch-1/progress", exchange -> {
            progressAuthorization.set(exchange.getRequestHeaders().getFirst("authorization"));
            respond(exchange, 200, """
                {"batchId":"batch-1","status":"failed","statusLabel":"执行完成","active":false,
                 "currentRound":2,"maximumRounds":2,"totalCases":10,"currentRoundTotal":2,"currentRoundCompleted":2,
                 "currentRoundPassed":1,"currentRoundFailed":1,"totalPassed":9,"finalFailed":1}
                """);
        });
        server.start();
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        Map<String, Object> result = new AutoForgeRunClient(
                baseUrl, "af_api_unit-test", 30, new PrintStream(output, true, StandardCharsets.UTF_8))
            .runToCompletion("suite-1");

        assertEquals("Bearer af_api_unit-test", authorization.get());
        assertNull(progressAuthorization.get());
        assertEquals("batch-1", result.get("batchId"));
        String log = output.toString(StandardCharsets.UTF_8);
        assertTrue(log.contains("第 2/2 轮"));
        assertTrue(log.contains("累计通过 9/10"));
        assertTrue(log.contains("access_token=read-only"));
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
