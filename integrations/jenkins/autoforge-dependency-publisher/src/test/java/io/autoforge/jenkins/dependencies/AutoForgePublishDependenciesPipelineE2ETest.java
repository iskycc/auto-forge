package io.autoforge.jenkins.dependencies;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.StringWriter;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.net.URLDecoder;
import java.util.concurrent.atomic.AtomicReference;
import hudson.FilePath;
import hudson.model.Result;
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

    @Test @WithJenkins
    void uploadsTheRemoteAgentsWorkspaceFileThroughTheInstalledPipelineStep(JenkinsRule jenkins) throws Exception {
        uploadFromRemoteAgent(jenkins, UploadPath.WORKSPACE_RELATIVE);
    }

    @Test @WithJenkins
    void uploadsAnAbsoluteFileOutsideTheRemoteAgentsWorkspace(JenkinsRule jenkins) throws Exception {
        uploadFromRemoteAgent(jenkins, UploadPath.AGENT_ABSOLUTE);
    }

    private enum UploadPath { WORKSPACE_RELATIVE, AGENT_ABSOLUTE }

    private void uploadFromRemoteAgent(JenkinsRule jenkins, UploadPath mode) throws Exception {
        var agent = jenkins.createOnlineSlave();
        agent.setLabelString("dependency-upload-agent");
        WorkflowJob job = jenkins.createProject(WorkflowJob.class, "remote-dependency-upload");
        FilePath workspace = agent.getWorkspaceFor(job);
        org.junit.jupiter.api.Assertions.assertNotNull(workspace);
        assertTrue(workspace.isRemote());
        FilePath archive = mode == UploadPath.WORKSPACE_RELATIVE
            ? workspace.child("target/构建依赖.zip")
            : agent.getRootPath().child("shared-builds/构建 依赖.zip");
        archive.getParent().mkdirs();
        if (mode == UploadPath.AGENT_ABSOLUTE) assertTrue(!archive.getRemote().startsWith(workspace.getRemote()));
        byte[] bytes = new byte[]{0x50, 0x4b, 3, 4, 1, 2, 3, 4};
        archive.copyFrom(new ByteArrayInputStream(bytes));
        String sourcePath = mode == UploadPath.WORKSPACE_RELATIVE ? "target/构建依赖.zip" : archive.getRemote();
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        AtomicReference<byte[]> received = new AtomicReference<>();
        server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/api/v1/jenkins/dependencies/upload", exchange -> {
            received.set(exchange.getRequestBody().readAllBytes());
            assertEquals(String.valueOf(bytes.length), exchange.getRequestHeaders().getFirst("content-length"));
            assertEquals(digest, exchange.getRequestHeaders().getFirst("x-autoforge-sha256"));
            assertEquals(archive.getName(), URLDecoder.decode(exchange.getRequestHeaders().getFirst("x-autoforge-file-name"), StandardCharsets.UTF_8));
            respond(exchange, 201, """
                {"projectId":"project-e2e","projectVersionId":"version-e2e","version":"1.0.0","assetId":"uploaded-on-agent"}
                """);
        });
        server.start();
        job.setDefinition(new CpsFlowDefinition("""
            node('dependency-upload-agent') {
              autoforgePublishDependencies baseUrl: 'http://127.0.0.1:%s', apiKey: 'af_api_remote-e2e',
                projectId: 'project-e2e', version: '1.0.0', filePath: '%s'
            }
            """.formatted(server.getAddress().getPort(), sourcePath.replace("\\", "\\\\").replace("'", "\\'")), true));
        WorkflowRun run = jenkins.buildAndAssertSuccess(job);
        org.junit.jupiter.api.Assertions.assertArrayEquals(bytes, received.get());
        jenkins.assertLogContains("依赖发布完成", run);
        jenkins.assertLogContains("uploaded-on-agent", run);
        jenkins.assertLogNotContains("af_api_remote-e2e", run);
    }

    @Test @WithJenkins
    void rejectsWorkspaceEscapesBeforeSendingAnUpload(JenkinsRule jenkins) throws Exception {
        var agent = jenkins.createOnlineSlave();
        agent.setLabelString("dependency-safety-agent");
        WorkflowJob job = jenkins.createProject(WorkflowJob.class, "reject-outside-workspace");
        agent.getWorkspaceFor(job).mkdirs();
        job.setDefinition(new CpsFlowDefinition("""
            node('dependency-safety-agent') {
              autoforgePublishDependencies baseUrl: 'http://127.0.0.1:1', apiKey: 'af_api_invalid-path',
                projectId: 'project-e2e', version: '1.0.0', filePath: '../outside.zip'
            }
            """, true));
        WorkflowRun run = jenkins.buildAndAssertStatus(Result.FAILURE, job);
        jenkins.assertLogContains("不能超出当前工作区", run);
        jenkins.assertLogNotContains("af_api_invalid-path", run);
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
