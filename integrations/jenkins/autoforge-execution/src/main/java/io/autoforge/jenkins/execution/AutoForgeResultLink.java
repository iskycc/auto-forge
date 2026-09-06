package io.autoforge.jenkins.execution;

record AutoForgeResultLink(String url, Lifetime lifetime) {
    enum Lifetime { PERMANENT, TEMPORARY }

    String resultLabel() {
        return lifetime == Lifetime.PERMANENT ? "完整结果" : "执行结果";
    }

    String validityHint() {
        return lifetime == Lifetime.PERMANENT
            ? "永久有效，在新标签页打开"
            : "7 天内有效，在新标签页打开";
    }
}
