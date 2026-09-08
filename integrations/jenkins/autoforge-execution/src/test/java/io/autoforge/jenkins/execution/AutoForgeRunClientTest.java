package io.autoforge.jenkins.execution;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import hudson.AbortException;
import hudson.console.ConsoleNote;
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
import java.util.function.IntFunction;
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
                 "resultUrl":"%sshare/run/permanent-result",
                 "progressApiUrl":"%sapi/v1/run-batches/batch-1/progress?access_token=read-only",
                 "pollIntervalSeconds":7,"completionTimeoutSeconds":120}
                """.formatted(baseUrl, baseUrl, baseUrl));
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
        assertEquals(baseUrl + "share/run/permanent-result", result.get("resultUrl"));
        assertEquals(result.get("resultUrl"), result.get("progressUrl"));
        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertTrue(log.contains("开始执行"));
        assertTrue(log.contains("执行详情（永久有效"));
        assertFalse(log.contains("7 天内有效"));
        assertTrue(log.contains("第 2/2 轮"));
        assertTrue(log.contains("累计通过 9/10"));
        assertTrue(log.contains("最终失败 1"));
        assertTrue(log.contains("90.0%"));
        assertTrue(log.contains("完整结果"));
        assertTrue(log.contains("仍有 1 项用例失败"));
        assertFalse(log.contains("http://"));
        assertFalse(log.contains("access_token="));
        assertFalse(log.contains("Completed"));
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
            respond(exchange, 200, progress(true, "running", "Running", 0).replace("batch-1", "batch-timeout")));
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

        assertTrue(failure.getMessage().contains("等待超时（5 秒）"));
        assertTrue(failure.getMessage().contains("未取消"));
        assertFalse(failure.getMessage().contains("http://"));
    }

    @Test
    void rejectsAbnormalTerminalMachineStatusRegardlessOfTheLabel() throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-failed","progressUrl":"%sprogress/batch-failed?access_token=read-only",
             "resultUrl":"%sshare/run/permanent-failed",
             "progressApiUrl":"%sapi/v1/run-batches/batch-failed/progress?access_token=read-only",
             "pollIntervalSeconds":30,"completionTimeoutSeconds":120}
            """.formatted(baseUrl, baseUrl, baseUrl)));
        server.createContext("/api/v1/run-batches/batch-failed/progress", exchange ->
            respond(exchange, 200, progress(false, "failed", "Finished", 0).replace("batch-1", "batch-failed")));
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

        assertTrue(failure.getMessage().contains("执行异常"));
        assertTrue(failure.getMessage().contains("完整结果"));
        assertFalse(failure.getMessage().contains("Finished"));
        assertFalse(failure.getMessage().contains("http://"));
    }

    @Test
    void printsChangesAndMinuteRemindersWhileKeepingEveryScheduledPoll() throws Exception {
        AtomicInteger progressRequests = new AtomicInteger();
        String baseUrl = startRunServer(progressRequests, true, poll -> {
            String response = progress(poll < 11, poll < 11 ? "running" : "succeeded", "Running", 1);
            return poll < 4 ? response.replace("\"totalPassed\":9", "\"totalPassed\":8") : response;
        });
        AtomicLong now = new AtomicLong();
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        client(baseUrl, 0, output, now, millis -> now.addAndGet(TimeUnit.MILLISECONDS.toNanos(millis)))
            .runToCompletion("suite-1");

        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertEquals(12, progressRequests.get());
        assertEquals(110, TimeUnit.NANOSECONDS.toSeconds(now.get()));
        assertEquals(4, log.lines().filter(line -> line.contains("执行进度：")).count());
        assertTrue(log.contains("已等待 1 分 40 秒"));
    }

    @Test
    void labelsLegacyResultLinksAsTemporaryWithoutChangingReturnedUrls() throws Exception {
        String baseUrl = startRunServer(new AtomicInteger(), false,
            poll -> progress(false, "succeeded", "Completed", 0));
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        Map<String, Object> result = client(baseUrl, 0, output, new AtomicLong(), millis -> {})
            .runToCompletion("suite-1");

        assertEquals(baseUrl + "progress/batch-1?access_token=read-only", result.get("resultUrl"));
        assertEquals(result.get("resultUrl"), result.get("progressUrl"));
        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertTrue(log.contains("执行详情（7 天内有效"));
        assertTrue(log.contains("执行结果（7 天内有效"));
        assertFalse(log.contains("永久有效"));
        assertFalse(log.contains("http://"));
    }

    @Test
    void terminatesTheRemoteBatchBeforePropagatingInterruptedWaiting() throws Exception {
        AtomicInteger progressRequests = new AtomicInteger();
        AtomicInteger terminationRequests = new AtomicInteger();
        String baseUrl = startRunServer(progressRequests, true,
            poll -> progress(poll == 0, poll == 0 ? "running" : "cancelled", "Stopped", 0));
        server.createContext("/api/v1/run-batches/batch-1/terminate", exchange -> {
            terminationRequests.incrementAndGet();
            respond(exchange, 200, "{\"batchId\":\"batch-1\",\"terminating\":true}");
        });
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        assertThrows(InterruptedException.class, () -> client(baseUrl, 0, output, new AtomicLong(), millis -> {
            throw new InterruptedException("Pipeline stopped");
        }).runToCompletion("suite-1"));

        assertEquals(1, terminationRequests.get());
        assertEquals(2, progressRequests.get());
        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertTrue(log.contains("请求终止"));
        assertTrue(log.contains("完整结果"));
        assertFalse(log.contains("批次未取消"));
    }

    @Test
    void retriesUncertainTerminationAndWaitsForAuthoritativeTerminalProgress() throws Exception {
        AtomicInteger progressRequests = new AtomicInteger();
        AtomicInteger terminationRequests = new AtomicInteger();
        String baseUrl = startRunServer(progressRequests, true, poll ->
            progress(poll < 2, poll < 2 ? "running" : "cancelled", "Stopped", 0));
        server.createContext("/api/v1/run-batches/batch-1/terminate", exchange -> {
            assertEquals("POST", exchange.getRequestMethod());
            assertEquals("Bearer af_api_unit-test", exchange.getRequestHeaders().getFirst("authorization"));
            assertTrue(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8).contains("Jenkins Pipeline"));
            if (terminationRequests.incrementAndGet() == 1) {
                respond(exchange, 503, "{\"error\":{\"message\":\"temporarily unavailable\"}}");
            } else {
                // A successful request, even one reporting no pending work, is not terminal progress.
                respond(exchange, 200, "{\"batchId\":\"batch-1\",\"terminating\":false}");
            }
        });
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AtomicLong clock = new AtomicLong();
        AutoForgeRunCancellation cancellation = new AutoForgeRunCancellation();
        Map<String, Object> result = stoppingClient(baseUrl, output, clock, cancellation).runToCompletion("suite-1");

        assertEquals(2, terminationRequests.get());
        assertEquals(3, progressRequests.get());
        assertEquals("cancelled", result.get("status"));
        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertTrue(log.contains("终止重试"));
        assertTrue(log.contains("完整结果"));
        assertFalse(log.contains("af_api_unit-test"));
    }

    @Test
    void reportsMissingTerminationPermissionWithoutClaimingTheBatchStopped() throws Exception {
        String baseUrl = startRunServer(new AtomicInteger(), true,
            poll -> progress(true, "running", "Running", 0));
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/api/v1/run-batches/batch-1/terminate", exchange -> {
            requests.incrementAndGet();
            respond(exchange, 403, "{\"error\":{\"message\":\"permission denied\"}}");
        });
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AbortException failure = assertThrows(AbortException.class, () ->
            stoppingClient(baseUrl, output, new AtomicLong(), new AutoForgeRunCancellation()).runToCompletion("suite-1"));
        assertTrue(failure.getMessage().contains("403"));
        assertEquals(1, requests.get());
        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertTrue(log.contains("终止未确认"));
        assertTrue(log.contains("run.cancel、run.read"));
        assertTrue(log.contains("查看报告"));
        assertFalse(log.contains("完整结果"));
    }

    @Test
    void retriesProgressAfterTerminationWithoutResubmittingAnAcceptedRequest() throws Exception {
        AtomicInteger progressRequests = new AtomicInteger();
        AtomicInteger terminationRequests = new AtomicInteger();
        String baseUrl = startRunServer(new AtomicInteger(), true,
            poll -> progress(true, "running", "Running", 0));
        server.removeContext("/api/v1/run-batches/batch-1/progress");
        server.createContext("/api/v1/run-batches/batch-1/progress", exchange -> {
            int poll = progressRequests.incrementAndGet();
            if (poll == 1) {
                respond(exchange, 200, progress(true, "running", "Running", 0));
                return;
            }
            assertEquals("Bearer af_api_unit-test", exchange.getRequestHeaders().getFirst("authorization"));
            assertNull(exchange.getRequestURI().getQuery(), "Drain must not depend on an expiring progress token");
            if (poll == 2) respond(exchange, 502, "{\"error\":{\"message\":\"temporary outage\"}}");
            else respond(exchange, 200, progress(false, "failed", "Failed", 1));
        });
        server.createContext("/api/v1/run-batches/batch-1/terminate", exchange -> {
            terminationRequests.incrementAndGet();
            respond(exchange, 200, "{\"batchId\":\"batch-1\",\"terminating\":true}");
        });
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        Map<String, Object> result = stoppingClient(baseUrl, output, new AtomicLong(),
            new AutoForgeRunCancellation()).runToCompletion("suite-1");
        assertEquals(1, terminationRequests.get());
        assertEquals(3, progressRequests.get());
        assertEquals("failed", result.get("status"));
        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertTrue(log.contains("终止重试"));
        assertTrue(log.contains("完整结果"));
    }

    @Test
    void rejectsMismatchedTerminalReports() throws Exception {
        String baseUrl = startRunServer(new AtomicInteger(), true,
            poll -> poll == 0 ? progress(true, "running", "Running", 0)
                : progress(false, "cancelled", "Stopped", 0).replace("batch-1", "another-batch"));
        server.createContext("/api/v1/run-batches/batch-1/terminate", exchange ->
            respond(exchange, 200, "{\"batchId\":\"batch-1\",\"terminating\":true}"));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertThrows(IllegalArgumentException.class, () -> stoppingClient(baseUrl, output,
            new AtomicLong(), new AutoForgeRunCancellation()).runToCompletion("suite-1"));
        String log = ConsoleNote.removeNotes(output.toString(StandardCharsets.UTF_8));
        assertTrue(log.contains("终止未确认"));
        assertFalse(log.contains("完整结果"));
    }

    @Test
    void boundsDrainWaitingIndependentlyOfTheNormalExecutionTimeout() throws Exception {
        String baseUrl = startRunServer(new AtomicInteger(), true,
            poll -> progress(true, "running", "Running", 0));
        AtomicInteger requests = new AtomicInteger();
        server.createContext("/api/v1/run-batches/batch-1/terminate", exchange -> {
            requests.incrementAndGet();
            respond(exchange, 200, "{\"batchId\":\"batch-1\",\"terminating\":true}");
        });
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AtomicLong clock = new AtomicLong();
        assertThrows(AbortException.class, () -> stoppingClient(baseUrl, output, clock,
            new AutoForgeRunCancellation()).runToCompletion("suite-1"));
        assertEquals(1, requests.get());
        assertEquals(TimeUnit.SECONDS.toNanos(120), clock.get());
        assertTrue(output.toString(StandardCharsets.UTF_8).contains("终止未确认"));
    }

    @Test
    void doesNotCreateABatchWhenStopWasAlreadyRequested() {
        AutoForgeRunCancellation cancellation = new AutoForgeRunCancellation();
        cancellation.request();
        assertThrows(InterruptedException.class, () -> stoppingClient("http://127.0.0.1:1/",
            new ByteArrayOutputStream(), new AtomicLong(), cancellation).runToCompletion("suite-1"));
    }

    private static AutoForgeRunClient stoppingClient(String baseUrl, ByteArrayOutputStream output,
            AtomicLong clock, AutoForgeRunCancellation cancellation) {
        return new AutoForgeRunClient(baseUrl, "af_api_unit-test", 0,
            new PrintStream(output, true, StandardCharsets.UTF_8),
            HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build(), clock::get,
            millis -> cancellation.request(), millis -> clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(millis)),
            cancellation);
    }

    private String startRunServer(AtomicInteger progressRequests, boolean permanentResult, IntFunction<String> response)
            throws IOException {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        String resultField = permanentResult ? "\"resultUrl\":\"" + baseUrl + "share/run/permanent-result\"," : "";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-1","progressUrl":"%sprogress/batch-1?access_token=read-only",
             %s"progressApiUrl":"%sapi/v1/run-batches/batch-1/progress",
             "pollIntervalSeconds":10,"completionTimeoutSeconds":120}
            """.formatted(baseUrl, resultField, baseUrl)));
        server.createContext("/api/v1/run-batches/batch-1/progress", exchange ->
            respond(exchange, 200, response.apply(progressRequests.getAndIncrement())));
        server.start();
        return baseUrl;
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
