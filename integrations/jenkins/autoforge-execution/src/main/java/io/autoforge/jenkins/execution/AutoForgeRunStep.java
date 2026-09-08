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
                "timeoutSeconds 必须为 0（采用平台建议值），或 1～"
                    + AutoForgeRunClient.MAXIMUM_COMPLETION_TIMEOUT_SECONDS + " 秒。");
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
        private final AutoForgeRunCancellation cancellation = new AutoForgeRunCancellation();
        private volatile Throwable cancellationCause;

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
            if (listener == null) throw new AbortException("无法获取 Jenkins 构建日志输出通道。");
            try {
                Map<String, Object> result = new AutoForgeRunClient(
                    baseUrl,
                    apiKey.getPlainText(),
                    timeoutSeconds,
                    listener.getLogger(),
                    cancellation).runToCompletion(suiteId);
                throwIfStopped();
                return result;
            } catch (Exception failure) {
                Throwable stopped = cancellationCause;
                if (stopped != null && stopped != failure) {
                    stopped.addSuppressed(failure);
                    throwIfStopped();
                }
                throw failure;
            }
        }

        @Override
        public synchronized void stop(Throwable cause) {
            if (cancellationCause == null) cancellationCause = cause;
            // The superclass would fail the Pipeline immediately and interrupt HTTP creation.
            // Leave its worker alive until the remote terminal report has been printed.
            cancellation.request();
        }

        private void throwIfStopped() throws Exception {
            Throwable cause = cancellationCause;
            if (cause instanceof Exception failure) throw failure;
            if (cause instanceof Error failure) throw failure;
            if (cause != null) throw new Exception("Jenkins Pipeline 已请求停止。", cause);
        }
    }

    @Extension
    @Symbol("autoforgeRun")
    public static final class DescriptorImpl extends StepDescriptor {
        @Override public String getFunctionName() { return "autoforgeRun"; }
        @Override public String getDisplayName() { return "执行 AutoForge 用例任务并等待完成"; }
        @Override public Set<? extends Class<?>> getRequiredContext() { return Set.of(TaskListener.class); }
    }
}
