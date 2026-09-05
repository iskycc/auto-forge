package io.autoforge.jenkins.console;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class AutoForgeConsoleLogTest {
    @Test
    void keepsRemoteTextOnOneLineAndRedactsCredentialsBeforeTruncation() {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AutoForgeConsoleLog console = new AutoForgeConsoleLog(
            new PrintStream(output, true, StandardCharsets.UTF_8), "af_api_secret");

        console.field("失败原因", "af_api_secret\r\n伪造日志\u001b[8m\u202e" + "长".repeat(600));

        String log = output.toString(StandardCharsets.UTF_8);
        assertTrue(log.startsWith("[AutoForge] 失败原因：[已隐藏]"));
        assertTrue(log.endsWith("…" + System.lineSeparator()));
        assertEquals(1, log.lines().count());
        assertFalse(log.contains("af_api_secret"));
        assertFalse(log.contains("\u001b"));
        assertFalse(log.contains("\u202e"));
    }

    @Test
    void keepsTheResultReadableWhenAnUnsafeLinkCannotBeRendered() {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AutoForgeConsoleLog console = new AutoForgeConsoleLog(
            new PrintStream(output, true, StandardCharsets.UTF_8), "af_api_secret");

        console.link("查看结果", "javascript:alert(1)", "完整结果", "在新标签页打开");
        console.field("执行批次", "batch-1");

        String log = output.toString(StandardCharsets.UTF_8);
        assertTrue(log.contains("链接暂不可用"));
        assertTrue(log.contains("batch-1"));
        assertFalse(log.contains("javascript:"));
    }
}
