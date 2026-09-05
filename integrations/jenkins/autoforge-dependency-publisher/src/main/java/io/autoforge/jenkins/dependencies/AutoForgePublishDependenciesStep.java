package io.autoforge.jenkins.dependencies;

import hudson.AbortException;
import hudson.Extension;
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
    private final String dependencyUrl;
    private String fileName;
    private final String sha256;
    private final long sizeBytes;
    private String archiveFormat;

    @DataBoundConstructor
    public AutoForgePublishDependenciesStep(
            String baseUrl,
            String apiKey,
            String projectId,
            String version,
            String dependencyUrl,
            String sha256,
            long sizeBytes) {
        this.baseUrl = baseUrl;
        this.apiKey = Secret.fromString(apiKey);
        this.projectId = projectId;
        this.version = version;
        this.dependencyUrl = dependencyUrl;
        this.fileName = "autoforge-dependencies.zip";
        this.sha256 = sha256;
        this.sizeBytes = sizeBytes;
        this.archiveFormat = "zip";
    }

    public String getBaseUrl() { return baseUrl; }
    public Secret getApiKey() { return apiKey; }
    public String getProjectId() { return projectId; }
    public String getVersion() { return version; }
    public String getDependencyUrl() { return dependencyUrl; }
    public String getFileName() { return fileName; }
    public String getSha256() { return sha256; }
    public long getSizeBytes() { return sizeBytes; }
    public String getArchiveFormat() { return archiveFormat; }

    /** Optional for tar.gz/tgz artifacts; ZIP is the default used by the minimal example. */
    @DataBoundSetter
    public void setFileName(String fileName) {
        if (fileName == null || fileName.isBlank()) {
            throw new IllegalArgumentException("fileName 不能为空。");
        }
        this.fileName = fileName;
    }

    /** Optional for tar.gz/tgz artifacts; ZIP is the default used by the minimal example. */
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
            this.fileName = step.fileName;
            this.sha256 = step.sha256;
            this.sizeBytes = step.sizeBytes;
            this.archiveFormat = step.archiveFormat;
        }

        @Override
        protected Map<String, Object> run() throws Exception {
            TaskListener listener = getContext().get(TaskListener.class);
            if (listener == null) throw new AbortException("无法获取 Jenkins 构建日志输出通道。");
            return new AutoForgeDependencyClient(
                    baseUrl, apiKey.getPlainText(), listener.getLogger())
                .replace(
                    projectId,
                    version,
                    dependencyUrl,
                    fileName,
                    sha256,
                    sizeBytes,
                    archiveFormat);
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
