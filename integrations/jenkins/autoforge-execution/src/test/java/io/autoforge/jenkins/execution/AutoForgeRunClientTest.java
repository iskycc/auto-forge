package io.autoforge.jenkins.execution;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import hudson.AbortException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
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
    void followsServerPollingAndUsesMachineStatusOverLocalizedLabels() throws Exception {
        AtomicReference<String> authorization = new AtomicReference<>();
        AtomicReference<String> progressAuthorization = new AtomicReference<>();
        AtomicReference<String> protocol = new AtomicReference<>();
        AtomicInteger progressRequests = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> {
            authorization.set(exchange.getRequestHeaders().getFirst("authorization"));
            protocol.set(exchange.getProtocol());
            respond(exchange, 201, """
                {"batchId":"batch-1","progressUrl":"%sprogress/batch-1?access_token=read-only",
                 "progressApiUrl":"%sapi/v1/run-batches/batch-1/progress?access_token=read-only",
                 "pollIntervalSeconds":7,"completionTimeoutSeconds":120}
                """.formatted(baseUrl, baseUrl));
        });
        server.createContext("/api/v1/run-batches/batch-1/progress", exchange -> {
            progressAuthorization.set(exchange.getRequestHeaders().getFirst("authorization"));
            boolean active = progressRequests.getAndIncrement() == 0;
            respond(exchange, 200, progress(active, active ? "running" : "succeeded", "Completed", 1));
        });
        server.start();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AtomicLong nowNanos = new AtomicLong();
        AtomicLong sleptMillis = new AtomicLong();

        Map<String, Object> result = client(
                baseUrl,
                0,
                output,
                nowNanos,
                millis -> {
                    sleptMillis.addAndGet(millis);
                    nowNanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(millis));
                })
            .runToCompletion("suite-1");

        assertEquals("HTTP/1.1", protocol.get());
        assertEquals("Bearer af_api_unit-test", authorization.get());
        assertNull(progressAuthorization.get());
        assertEquals(7_000, sleptMillis.get());
        assertEquals("batch-1", result.get("batchId"));
        assertEquals("succeeded", result.get("status"));
        assertEquals(1, result.get("finalFailed"));
        String log = output.toString(StandardCharsets.UTF_8);
        assertTrue(log.contains("第 2/2 轮"));
        assertTrue(log.contains("累计通过 9/10"));
        assertTrue(log.contains("access_token=read-only"));
    }

    @Test
    void stopsPollingAtTheConfiguredTotalTimeout() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-timeout","progressUrl":"%sprogress/batch-timeout?access_token=read-only",
             "progressApiUrl":"%sapi/v1/run-batches/batch-timeout/progress?access_token=read-only",
             "pollIntervalSeconds":30,"completionTimeoutSeconds":120}
            """.formatted(baseUrl, baseUrl)));
        server.createContext("/api/v1/run-batches/batch-timeout/progress", exchange ->
            respond(exchange, 200, progress(true, "running", "Running", 0)));
        server.start();
        AtomicLong nowNanos = new AtomicLong();

        AbortException failure = assertThrows(
            AbortException.class,
            () -> client(
                    baseUrl,
                    5,
                    new ByteArrayOutputStream(),
                    nowNanos,
                    millis -> nowNanos.addAndGet(TimeUnit.MILLISECONDS.toNanos(millis)))
                .runToCompletion("suite-timeout"));

        assertTrue(failure.getMessage().contains("within 5 seconds"));
        assertTrue(failure.getMessage().contains("progress/batch-timeout"));
    }

    @Test
    void rejectsAbnormalTerminalMachineStatusRegardlessOfTheLabel() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-failed","progressUrl":"%sprogress/batch-failed?access_token=read-only",
             "progressApiUrl":"%sapi/v1/run-batches/batch-failed/progress?access_token=read-only",
             "pollIntervalSeconds":30,"completionTimeoutSeconds":120}
            """.formatted(baseUrl, baseUrl)));
        server.createContext("/api/v1/run-batches/batch-failed/progress", exchange ->
            respond(exchange, 200, progress(false, "failed", "Finished", 0)));
        server.start();

        AbortException failure = assertThrows(
            AbortException.class,
            () -> client(
                    baseUrl,
                    0,
                    new ByteArrayOutputStream(),
                    new AtomicLong(),
                    millis -> {})
                .runToCompletion("suite-failed"));

        assertTrue(failure.getMessage().contains("status failed"));
        assertTrue(failure.getMessage().contains("Finished"));
    }

    private static AutoForgeRunClient client(
            String baseUrl,
            long timeoutSeconds,
            ByteArrayOutputStream output,
            AtomicLong nowNanos,
            AutoForgeRunClient.Sleeper sleeper) {
        return new AutoForgeRunClient(
            baseUrl,
            "af_api_unit-test",
            timeoutSeconds,
            new PrintStream(output, true, StandardCharsets.UTF_8),
            HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build(),
            nowNanos::get,
            sleeper);
    }

    private static String progress(boolean active, String status, String statusLabel, int finalFailed) {
        return """
            {"batchId":"batch-1","status":"%s","statusLabel":"%s","active":%s,
             "currentRound":2,"maximumRounds":2,"totalCases":10,"currentRoundTotal":2,
             "currentRoundCompleted":2,"currentRoundPassed":1,"currentRoundFailed":1,
             "totalPassed":9,"finalFailed":%d}
            """.formatted(status, statusLabel, active, finalFailed);
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
