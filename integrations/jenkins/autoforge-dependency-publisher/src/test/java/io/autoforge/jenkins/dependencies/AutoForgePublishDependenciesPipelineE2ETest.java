package io.autoforge.jenkins.dependencies;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.StringWriter;
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
        jenkins.assertLogContains("[AutoForge] ── 依赖发布完成", run);
        jenkins.assertLogContains("4.0 KiB", run);
        jenkins.assertLogContains("asset-pipeline-e2e", run);
        jenkins.assertLogContains("下载依赖包", run);
        jenkins.assertLogNotContains("https://jenkins.example", run);
        StringWriter console = new StringWriter();
        run.getLogText().writeHtmlTo(0, console);
        String html = console.toString();
        assertTrue(html.contains("href='https://jenkins.example/job/1/artifact/dependencies.zip'"));
        assertTrue(html.contains("target=\"_blank\""));
        assertTrue(html.contains("rel=\"noopener noreferrer\""));
        assertTrue(html.contains(">下载依赖包</a>"));
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] content = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", "application/json");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
        exchange.close();
    }
}
