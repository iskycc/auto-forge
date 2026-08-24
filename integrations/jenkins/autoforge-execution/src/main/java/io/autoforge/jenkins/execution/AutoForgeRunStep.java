package io.autoforge.jenkins.execution;

import hudson.AbortException;
import hudson.Extension;
import hudson.model.TaskListener;
import hudson.util.Secret;
import java.io.Serial;
import java.util.Map;
import java.util.Set;
import org.jenkinsci.plugins.workflow.steps.Step;
import org.jenkinsci.plugins.workflow.steps.StepContext;
import org.jenkinsci.plugins.workflow.steps.StepDescriptor;
import org.jenkinsci.plugins.workflow.steps.StepExecution;
import org.jenkinsci.plugins.workflow.steps.SynchronousNonBlockingStepExecution;
import org.kohsuke.stapler.DataBoundConstructor;
import org.kohsuke.stapler.DataBoundSetter;
import org.jenkinsci.Symbol;

public final class AutoForgeRunStep extends Step {
    private final String baseUrl;
    private final String suiteId;
    private final Secret apiKey;
    private long timeoutSeconds;

    @DataBoundConstructor
    public AutoForgeRunStep(String baseUrl, String suiteId, String apiKey) {
        this.baseUrl = baseUrl;
        this.suiteId = suiteId;
        this.apiKey = Secret.fromString(apiKey);
    }

    public String getBaseUrl() { return baseUrl; }
    public String getSuiteId() { return suiteId; }
    public Secret getApiKey() { return apiKey; }
    public long getTimeoutSeconds() { return timeoutSeconds; }

    /** Zero uses the server recommendation; an explicit value may only shorten the signed-link lifetime. */
    @DataBoundSetter
    public void setTimeoutSeconds(long timeoutSeconds) {
        if (timeoutSeconds < 0 || timeoutSeconds > AutoForgeRunClient.MAXIMUM_COMPLETION_TIMEOUT_SECONDS) {
            throw new IllegalArgumentException(
                "timeoutSeconds must be zero or between 1 and "
                    + AutoForgeRunClient.MAXIMUM_COMPLETION_TIMEOUT_SECONDS);
        }
        this.timeoutSeconds = timeoutSeconds;
    }

    @Override
    public StepExecution start(StepContext context) {
        return new Execution(this, context);
    }

    private static final class Execution extends SynchronousNonBlockingStepExecution<Map<String, Object>> {
        @Serial private static final long serialVersionUID = 1L;
        private final String baseUrl;
        private final String suiteId;
        private final Secret apiKey;
        private final long timeoutSeconds;

        Execution(AutoForgeRunStep step, StepContext context) {
            super(context);
            this.baseUrl = step.baseUrl;
            this.suiteId = step.suiteId;
            this.apiKey = step.apiKey;
            this.timeoutSeconds = step.timeoutSeconds;
        }

        @Override
        protected Map<String, Object> run() throws Exception {
            TaskListener listener = getContext().get(TaskListener.class);
            if (listener == null) throw new AbortException("Jenkins TaskListener is unavailable");
            return new AutoForgeRunClient(
                    baseUrl,
                    apiKey.getPlainText(),
                    timeoutSeconds,
                    listener.getLogger())
                .runToCompletion(suiteId);
        }
    }

    @Extension
    @Symbol("autoforgeRun")
    public static final class DescriptorImpl extends StepDescriptor {
        @Override public String getFunctionName() { return "autoforgeRun"; }
        @Override public String getDisplayName() { return "Run an AutoForge task and wait for completion"; }
        @Override public Set<? extends Class<?>> getRequiredContext() { return Set.of(TaskListener.class); }
    }
}
