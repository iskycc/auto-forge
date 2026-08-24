package io.autoforge.jenkins.dependencies;

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

class AutoForgePublishDependenciesPipelineE2ETest {
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
        server.createContext("/api/v1/jenkins/dependencies", exchange -> respond(exchange, 200, """
            {"projectId":"project-e2e","projectVersionId":"version-e2e","version":"1.0.0",
             "assetId":"asset-pipeline-e2e","replaced":true}
            """));
        server.start();

        WorkflowJob job = jenkins.createProject(WorkflowJob.class, "autoforge-dependency-pipeline-e2e");
        job.setDefinition(new CpsFlowDefinition("""
            autoforgePublishDependencies baseUrl: '%s', apiKey: 'af_api_pipeline-e2e',
              projectId: 'project-e2e', version: '1.0.0',
              dependencyUrl: 'https://jenkins.example/job/1/artifact/dependencies.zip',
              sha256: '%s', sizeBytes: 4096
            """.formatted(baseUrl, "a".repeat(64)), true));

        WorkflowRun run = jenkins.buildAndAssertSuccess(job);
        jenkins.assertLogContains("AutoForge: dependency archive replaced", run);
        jenkins.assertLogContains("asset-pipeline-e2e", run);
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
