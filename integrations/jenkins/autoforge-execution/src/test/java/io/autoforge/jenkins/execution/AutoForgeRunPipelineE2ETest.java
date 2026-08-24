package io.autoforge.jenkins.execution;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
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
        server = HttpServer.create(new InetSocketAddress(0), 0);
        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
        server.createContext("/api/v1/jenkins/runs", exchange -> respond(exchange, 201, """
            {"batchId":"batch-pipeline-e2e","progressUrl":"%sprogress/batch-pipeline-e2e?access_token=read-only",
             "progressApiUrl":"%sapi/v1/run-batches/batch-pipeline-e2e/progress?access_token=read-only",
             "pollIntervalSeconds":30,"completionTimeoutSeconds":604800}
            """.formatted(baseUrl, baseUrl)));
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
        jenkins.assertLogContains("AutoForge: task started", run);
        jenkins.assertLogContains("累计通过 3/3", run);
        jenkins.assertLogContains("batch-pipeline-e2e", run);
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
