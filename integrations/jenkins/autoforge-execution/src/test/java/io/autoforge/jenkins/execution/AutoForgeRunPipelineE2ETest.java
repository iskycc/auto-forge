package io.autoforge.jenkins.execution;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import hudson.model.Result;
import java.io.IOException;
import java.io.StringWriter;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition;
import org.jenkinsci.plugins.workflow.job.WorkflowJob;
import org.jenkinsci.plugins.workflow.job.WorkflowRun;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.jvnet.hudson.test.JenkinsRule;
import org.jvnet.hudson.test.junit.jupiter.WithJenkins;

class AutoForgeRunPipelineE2ETest {
    private HttpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    @Test
    @WithJenkins
    void runsTheInstalledPipelineDslAgainstTheAutoForgeContract(JenkinsRule jenkins) throws Exception {
        // Check the loaded version so transitive test dependencies cannot hide a baseline regression.
        assertEquals(
            System.getProperty("workflow-step-api.version", "700.v6e45cb_a_5a_a_21"),
            jenkins.jenkins.getPluginManager().getPlugin("workflow-step-api").getVersion());
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-pipeline-e2e","progressUrl":"%sprogress/batch-pipeline-e2e?access_token=read-only",
             "resultUrl":"%sshare/run/permanent-pipeline-e2e",
             "progressApiUrl":"%sapi/v1/run-batches/batch-pipeline-e2e/progress?access_token=read-only",
             "pollIntervalSeconds":30,"completionTimeoutSeconds":604800}
            """.formatted(baseUrl, baseUrl, baseUrl)));
        server.createContext("/api/v1/run-batches/batch-pipeline-e2e/progress", exchange ->
            respond(exchange, 200, """
                {"batchId":"batch-pipeline-e2e","status":"succeeded","statusLabel":"执行完成",
                 "active":false,"currentRound":1,"maximumRounds":1,"totalCases":3,
                 "currentRoundTotal":3,"currentRoundCompleted":3,"currentRoundPassed":3,
                 "currentRoundFailed":0,"totalPassed":3,"finalFailed":0}
                """));
        server.start();

        WorkflowJob job = jenkins.createProject(WorkflowJob.class, "autoforge-run-pipeline-e2e");
        job.setDefinition(new CpsFlowDefinition("""
            autoforgeRun baseUrl: '%s', apiKey: 'af_api_pipeline-e2e',
              suiteId: 'suite-e2e', timeoutSeconds: 120
            """.formatted(baseUrl), true));

        WorkflowRun run = jenkins.buildAndAssertSuccess(job);
        jenkins.assertLogContains("[AutoForge] ── 开始执行", run);
        jenkins.assertLogContains("累计通过 3/3", run);
        jenkins.assertLogContains("batch-pipeline-e2e", run);
        jenkins.assertLogContains("完整结果", run);
        jenkins.assertLogNotContains("access_token=", run);
        jenkins.assertLogNotContains("share/run/permanent-pipeline-e2e", run);

        StringWriter console = new StringWriter();
        run.getLogText().writeHtmlTo(0, console);
        String html = console.toString();
        String detailLink = "href='" + baseUrl + "share/run/permanent-pipeline-e2e'";
        assertEquals(2, html.split(java.util.regex.Pattern.quote(detailLink), -1).length - 1);
        assertFalse(html.contains("href='" + baseUrl + "progress/"));
        assertTrue(html.contains("target=\"_blank\""));
        assertTrue(html.contains("rel=\"noopener noreferrer\""));
        assertTrue(html.contains(">完整结果</a>"));
        assertTrue(html.contains(">执行详情</a>"));
        assertFalse(html.contains("af_api_pipeline-e2e"));
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }

    @Test
    @WithJenkins
    void keepsTheSameDetailLinkWhenJenkinsStopsWaiting(JenkinsRule jenkins) throws Exception {
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-timeout","progressUrl":"%sprogress/batch-timeout?access_token=read-only",
             "resultUrl":"%sshare/run/permanent-timeout",
             "progressApiUrl":"%sapi/v1/run-batches/batch-timeout/progress",
             "pollIntervalSeconds":30,"completionTimeoutSeconds":604800}
            """.formatted(baseUrl, baseUrl, baseUrl)));
        server.createContext("/api/v1/run-batches/batch-timeout/progress", exchange -> respond(exchange, 200, """
            {"batchId":"batch-timeout","status":"running","statusLabel":"执行中",
             "active":true,"currentRound":1,"maximumRounds":1,"totalCases":3,
             "currentRoundTotal":3,"currentRoundCompleted":0,"currentRoundPassed":0,
             "currentRoundFailed":0,"totalPassed":0,"finalFailed":0}
            """));
        server.start();
        WorkflowJob job = jenkins.createProject(WorkflowJob.class, "autoforge-run-timeout");
        job.setDefinition(new CpsFlowDefinition("""
            autoforgeRun baseUrl: '%s', apiKey: 'af_api_pipeline-timeout',
              suiteId: 'suite-e2e', timeoutSeconds: 1
            """.formatted(baseUrl), true));

        WorkflowRun run = jenkins.assertBuildStatus(Result.FAILURE, job.scheduleBuild2(0));
        jenkins.assertLogContains("等待超时", run);
        jenkins.assertLogContains("批次未取消", run);
        StringWriter console = new StringWriter();
        run.getLogText().writeHtmlTo(0, console);
        String html = console.toString();
        String detailLink = "href='" + baseUrl + "share/run/permanent-timeout'";
        assertEquals(2, html.split(java.util.regex.Pattern.quote(detailLink), -1).length - 1);
        assertFalse(html.contains("href='" + baseUrl + "progress/"));
        assertFalse(html.contains("7 天内有效"));
    }

    @Test
    @WithJenkins
    void waitsForRemoteTerminationAndPrintsTheReportBeforeAborting(JenkinsRule jenkins) throws Exception {
        CountDownLatch initialProgress = new CountDownLatch(1);
        CountDownLatch terminationRequested = new CountDownLatch(1);
        CountDownLatch drainingProgress = new CountDownLatch(1);
        AtomicBoolean drained = new AtomicBoolean();
        AtomicInteger terminationRequests = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-stop","progressUrl":"%sshare/run/final-stop",
             "resultUrl":"%sshare/run/final-stop", "progressApiUrl":"%sapi/v1/run-batches/batch-stop/progress",
             "pollIntervalSeconds":1,"completionTimeoutSeconds":120}
            """.formatted(baseUrl, baseUrl, baseUrl)));
        server.createContext("/api/v1/run-batches/batch-stop/terminate", exchange -> {
            assertEquals("POST", exchange.getRequestMethod());
            assertEquals("Bearer af_api_pipeline-stop", exchange.getRequestHeaders().getFirst("authorization"));
            terminationRequests.incrementAndGet();
            respond(exchange, 200, "{\"batchId\":\"batch-stop\",\"cancelledRuns\":1,\"terminating\":true}");
            terminationRequested.countDown();
        });
        server.createContext("/api/v1/run-batches/batch-stop/progress", exchange -> {
            boolean terminal = drained.get();
            respond(exchange, 200, """
                {"batchId":"batch-stop","status":"%s","active":%s,
                 "currentRound":1,"maximumRounds":1,"totalCases":3,
                 "currentRoundTotal":3,"currentRoundCompleted":%d,"currentRoundPassed":1,
                 "currentRoundFailed":0,"totalPassed":1,"finalFailed":0}
                """.formatted(terminal ? "cancelled" : "running", !terminal, terminal ? 3 : 1));
            initialProgress.countDown();
            if (terminationRequests.get() > 0 && !terminal) drainingProgress.countDown();
        });
        server.start();
        WorkflowJob job = jenkins.createProject(WorkflowJob.class, "autoforge-stop");
        job.setDefinition(new CpsFlowDefinition("""
            try {
              autoforgeRun baseUrl: '%s', apiKey: 'af_api_pipeline-stop', suiteId: 'suite-stop'
            } finally {
              currentBuild.description = 'PIPELINE_FINALLY'
            }
            """.formatted(baseUrl), true));
        var build = job.scheduleBuild2(0);
        WorkflowRun run = build.waitForStart();
        try {
            assertTrue(initialProgress.await(15, TimeUnit.SECONDS));
            run.doStop();
            assertTrue(terminationRequested.await(10, TimeUnit.SECONDS), "Stop must terminate the remote batch");
            assertTrue(drainingProgress.await(10, TimeUnit.SECONDS));
            assertTrue(run.isBuilding(), "Jenkins must wait for remote work to drain");
            assertNull(run.getDescription(), "Pipeline finally must wait for the remote report");
            jenkins.assertLogNotContains("完整结果", run);
            run.getExecution().interrupt(Result.ABORTED);
        } finally {
            drained.set(true);
        }
        jenkins.assertBuildStatus(Result.ABORTED, build.get(20, TimeUnit.SECONDS));
        assertEquals(1, terminationRequests.get(), "Repeated stop signals must reuse the termination request");
        jenkins.assertLogContains("完整结果", run);
        jenkins.assertLogContains("总计 3 | 通过 1 | 最终失败 0", run);
        StringWriter console = new StringWriter();
        run.getLogText().writeHtmlTo(0, console);
        String html = console.toString();
        assertTrue(html.contains("href='" + baseUrl + "share/run/final-stop'"));
        assertEquals("PIPELINE_FINALLY", run.getDescription());
        assertFalse(html.contains("af_api_pipeline-stop"));
    }

    @Test
    @WithJenkins
    void retainsTheBatchReceiptWhenStoppedDuringCreation(JenkinsRule jenkins) throws Exception {
        CountDownLatch creating = new CountDownLatch(1);
        CountDownLatch returnReceipt = new CountDownLatch(1);
        AtomicInteger creations = new AtomicInteger();
        AtomicInteger terminations = new AtomicInteger();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> {
            creations.incrementAndGet();
            creating.countDown();
            try {
                if (!returnReceipt.await(15, TimeUnit.SECONDS)) throw new IOException("Timed out waiting to return batch receipt");
            } catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted fixture batch creation", failure);
            }
            respond(exchange, 201, """
                {"batchId":"batch-creating","progressUrl":"%sshare/run/creating",
                 "resultUrl":"%sshare/run/creating","progressApiUrl":"%sapi/v1/run-batches/batch-creating/progress",
                 "pollIntervalSeconds":1,"completionTimeoutSeconds":120}
                """.formatted(baseUrl, baseUrl, baseUrl));
        });
        server.createContext("/api/v1/run-batches/batch-creating/terminate", exchange -> {
            terminations.incrementAndGet();
            respond(exchange, 200, "{\"batchId\":\"batch-creating\",\"terminating\":false}");
        });
        server.createContext("/api/v1/run-batches/batch-creating/progress", exchange -> respond(exchange, 200, """
            {"batchId":"batch-creating","status":"succeeded","active":false,
             "currentRound":1,"maximumRounds":1,"totalCases":1,"totalPassed":1,"finalFailed":0,
             "currentRoundTotal":1,"currentRoundCompleted":1,"currentRoundPassed":1,"currentRoundFailed":0}
            """));
        server.start();
        WorkflowJob job = jenkins.createProject(WorkflowJob.class, "stop-during-creation");
        job.setDefinition(new CpsFlowDefinition("""
            autoforgeRun baseUrl: '%s', apiKey: 'af_api_pipeline-stop', suiteId: 'suite-stop'
            """.formatted(baseUrl), true));
        var build = job.scheduleBuild2(0);
        WorkflowRun run = build.waitForStart();
        try {
            assertTrue(creating.await(15, TimeUnit.SECONDS));
            // Await delivery to the actual StepExecution, not just queuing the UI stop request.
            for (var execution : run.getExecution().getCurrentExecutions(false).get(5, TimeUnit.SECONDS)) {
                execution.stop(new org.jenkinsci.plugins.workflow.steps.FlowInterruptedException(Result.ABORTED, true));
            }
        } finally {
            returnReceipt.countDown();
        }
        jenkins.assertBuildStatus(Result.ABORTED, build.get(20, TimeUnit.SECONDS));
        assertEquals(1, creations.get());
        assertEquals(1, terminations.get());
        jenkins.assertLogContains("完整结果", run);
        jenkins.assertLogContains("总计 1 | 通过 1", run);
    }
}
