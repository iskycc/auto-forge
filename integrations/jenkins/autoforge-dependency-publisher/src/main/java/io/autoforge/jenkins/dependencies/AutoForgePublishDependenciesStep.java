package io.autoforge.jenkins.dependencies;

import hudson.AbortException;
import hudson.Extension;
import hudson.FilePath;
import io.autoforge.jenkins.console.AutoForgeConsoleLog;
import hudson.model.TaskListener;
import hudson.util.Secret;
import java.io.Serial;
import java.util.Map;
import java.util.Set;
import org.jenkinsci.Symbol;
import org.jenkinsci.plugins.workflow.steps.Step;
import org.jenkinsci.plugins.workflow.steps.StepContext;
import org.jenkinsci.plugins.workflow.steps.StepDescriptor;
import org.jenkinsci.plugins.workflow.steps.StepExecution;
import org.jenkinsci.plugins.workflow.steps.SynchronousNonBlockingStepExecution;
import org.kohsuke.stapler.DataBoundConstructor;
import org.kohsuke.stapler.DataBoundSetter;

public final class AutoForgePublishDependenciesStep extends Step {
    private final String baseUrl;
    private final Secret apiKey;
    private final String projectId;
    private final String version;
    private String dependencyUrl;
    private String filePath;
    private String fileName;
    private String sha256;
    private long sizeBytes;
    private String archiveFormat;

    @DataBoundConstructor
    public AutoForgePublishDependenciesStep(
            String baseUrl,
            String apiKey,
            String projectId,
            String version) {
        this.baseUrl = baseUrl;
        this.apiKey = Secret.fromString(apiKey);
        this.projectId = projectId;
        this.version = version;
    }

    public String getBaseUrl() { return baseUrl; }
    public Secret getApiKey() { return apiKey; }
    public String getProjectId() { return projectId; }
    public String getVersion() { return version; }
    public String getDependencyUrl() { return dependencyUrl; }
    public String getFilePath() { return filePath; }
    public String getFileName() { return fileName; }
    public String getSha256() { return sha256; }
    public long getSizeBytes() { return sizeBytes; }
    public String getArchiveFormat() { return archiveFormat; }

    @DataBoundSetter public void setFilePath(String filePath) {
        if (filePath == null || filePath.isBlank()) throw new IllegalArgumentException("filePath 不能为空。");
        this.filePath = filePath;
    }

    // Keep saved URL-based Pipelines working; new integrations use filePath only.
    @Deprecated @DataBoundSetter public void setDependencyUrl(String value) { this.dependencyUrl = value; }
    @Deprecated @DataBoundSetter public void setSha256(String value) { this.sha256 = value; }
    @Deprecated @DataBoundSetter public void setSizeBytes(long value) { this.sizeBytes = value; }

    /** Optional override; local file metadata is detected automatically. */
    @DataBoundSetter
    public void setFileName(String fileName) {
        if (fileName == null || fileName.isBlank()) {
            throw new IllegalArgumentException("fileName 不能为空。");
        }
        this.fileName = fileName;
    }

    /** Optional override; local file metadata is detected automatically. */
    @DataBoundSetter
    public void setArchiveFormat(String archiveFormat) {
        if (!"zip".equals(archiveFormat) && !"tar.gz".equals(archiveFormat)) {
            throw new IllegalArgumentException("archiveFormat 只支持 zip 或 tar.gz。");
        }
        this.archiveFormat = archiveFormat;
    }

    @Override
    public StepExecution start(StepContext context) {
        return new Execution(this, context);
    }

    private static final class Execution extends SynchronousNonBlockingStepExecution<Map<String, Object>> {
        @Serial private static final long serialVersionUID = 1L;
        private final String baseUrl;
        private final Secret apiKey;
        private final String projectId;
        private final String version;
        private final String dependencyUrl;
        private final String filePath;
        private final String fileName;
        private final String sha256;
        private final long sizeBytes;
        private final String archiveFormat;

        Execution(AutoForgePublishDependenciesStep step, StepContext context) {
            super(context);
            this.baseUrl = step.baseUrl;
            this.apiKey = step.apiKey;
            this.projectId = step.projectId;
            this.version = step.version;
            this.dependencyUrl = step.dependencyUrl;
            this.filePath = step.filePath;
            this.fileName = step.fileName;
            this.sha256 = step.sha256;
            this.sizeBytes = step.sizeBytes;
            this.archiveFormat = step.archiveFormat;
        }

        @Override
        protected Map<String, Object> run() throws Exception {
            TaskListener listener = getContext().get(TaskListener.class);
            if (listener == null) throw new AbortException("无法获取 Jenkins 构建日志输出通道。");
            if (filePath != null) {
                if (dependencyUrl != null) throw new AbortException("filePath 与旧 dependencyUrl 不能同时填写，请使用本地文件路径。");
                FilePath workspace = getContext().get(FilePath.class);
                if (workspace == null) throw new AbortException("直接上传依赖需要 Jenkins Agent 工作区，请在 node 或 Declarative Pipeline 的 agent 步骤中使用。");
                Map<String, Object> result = workspace.act(new UploadDependencyFile(
                    baseUrl, apiKey.getPlainText(), projectId, version, filePath, fileName, archiveFormat, listener));
                AutoForgeConsoleLog console = new AutoForgeConsoleLog(listener.getLogger(), apiKey.getPlainText());
                console.section("依赖发布完成");
                console.field("项目版本", String.valueOf(result.get("version")));
                console.field("资产编号", String.valueOf(result.get("assetId")));
                console.field("发布说明", "依赖已上传到平台托管存储，后续新建批次使用最新依赖。");
                return result;
            }
            if (dependencyUrl == null) throw new AbortException("请通过 filePath 指定 Jenkins Agent 工作区内已经构建好的依赖压缩包。");
            return new AutoForgeDependencyClient(
                    baseUrl, apiKey.getPlainText(), listener.getLogger())
                .replace(
                    projectId,
                    version,
                    dependencyUrl,
                    fileName == null ? "autoforge-dependencies.zip" : fileName,
                    sha256,
                    sizeBytes,
                    archiveFormat == null ? "zip" : archiveFormat);
        }
    }

    @Extension
    @Symbol("autoforgePublishDependencies")
    public static final class DescriptorImpl extends StepDescriptor {
        @Override public String getFunctionName() { return "autoforgePublishDependencies"; }
        @Override public String getDisplayName() { return "更新 AutoForge 项目版本依赖"; }
        @Override public Set<? extends Class<?>> getRequiredContext() { return Set.of(TaskListener.class); }
    }
}
