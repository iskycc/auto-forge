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

public final class AutoForgePublishDependenciesStep extends Step {
    private final String baseUrl;
    private final Secret apiKey;
    private final String projectId;
    private final String version;
    private final String dependencyUrl;
    private final String fileName;
    private final String sha256;
    private final long sizeBytes;
    private final String archiveFormat;

    @DataBoundConstructor
    public AutoForgePublishDependenciesStep(
            String baseUrl,
            String apiKey,
            String projectId,
            String version,
            String dependencyUrl,
            String fileName,
            String sha256,
            long sizeBytes,
            String archiveFormat) {
        this.baseUrl = baseUrl;
        this.apiKey = Secret.fromString(apiKey);
        this.projectId = projectId;
        this.version = version;
        this.dependencyUrl = dependencyUrl;
        this.fileName = fileName;
        this.sha256 = sha256;
        this.sizeBytes = sizeBytes;
        this.archiveFormat = archiveFormat;
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
            if (listener == null) throw new AbortException("Jenkins TaskListener is unavailable");
            Map<String, Object> result = new AutoForgeDependencyClient(
                    baseUrl, apiKey.getPlainText(), listener.getLogger())
                .replace(
                    projectId,
                    version,
                    dependencyUrl,
                    fileName,
                    sha256,
                    sizeBytes,
                    archiveFormat);
            listener.getLogger().printf(
                "AutoForge: dependency archive replaced | project %s | version %s | asset %s%n",
                projectId,
                version,
                result.get("assetId"));
            return result;
        }
    }

    @Extension
    @Symbol("autoforgePublishDependencies")
    public static final class DescriptorImpl extends StepDescriptor {
        @Override public String getFunctionName() { return "autoforgePublishDependencies"; }
        @Override public String getDisplayName() { return "Replace AutoForge version dependencies"; }
        @Override public Set<? extends Class<?>> getRequiredContext() { return Set.of(TaskListener.class); }
    }
}
