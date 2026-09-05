package io.autoforge.jenkins.console;

import java.io.IOException;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.regex.Pattern;

public final class AutoForgeConsoleLog {
    private static final String PREFIX = "[AutoForge] ";
    private static final int MAXIMUM_TEXT_LENGTH = 500;
    private static final Pattern CONTROL_CHARACTERS = Pattern.compile("[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]");
    private static final Logger DIAGNOSTICS = Logger.getLogger(AutoForgeConsoleLog.class.getName());
    private final PrintStream output;
    private final String apiKey;

    public AutoForgeConsoleLog(PrintStream output, String apiKey) {
        this.output = output;
        this.apiKey = apiKey;
    }

    public void section(String title) {
        line("── " + title + " ────────────────────");
    }

    public void field(String label, String value) {
        line(label + "：" + value);
    }

    public void line(String message) {
        output.println(PREFIX + safeText(message));
    }

    public void link(String label, String url, String caption, String hint) {
        String visibleCaption = safeText(caption);
        try {
            String annotatedCaption = new ExternalLinkNote(url, visibleCaption.length()).encode() + visibleCaption;
            output.println(PREFIX + safeText(label) + "：" + annotatedCaption + "（" + safeText(hint) + "）");
        } catch (IOException | IllegalArgumentException failure) {
            // Presentation failure must not change an already-created batch or dependency publication.
            DIAGNOSTICS.log(Level.WARNING, "AutoForge console link could not be rendered", failure);
            field(label, visibleCaption + "（链接暂不可用，请在 AutoForge 中按编号查看）");
        }
    }

    public String safeText(String value) {
        String text = value == null ? "" : value;
        if (apiKey != null && !apiKey.isEmpty()) text = text.replace(apiKey, "[已隐藏]");
        // Keep remote messages on one line and prevent console-note/terminal-control injection.
        text = CONTROL_CHARACTERS.matcher(text).replaceAll(" ").strip();
        return text.length() <= MAXIMUM_TEXT_LENGTH ? text : text.substring(0, MAXIMUM_TEXT_LENGTH) + "…";
    }

    public static String duration(long seconds) {
        if (seconds == 0) return "0 秒";
        List<String> parts = new ArrayList<>();
        long days = seconds / 86_400;
        long hours = seconds % 86_400 / 3_600;
        long minutes = seconds % 3_600 / 60;
        long remainderSeconds = seconds % 60;
        if (days > 0) parts.add(days + " 天");
        if (hours > 0) parts.add(hours + " 小时");
        if (minutes > 0) parts.add(minutes + " 分");
        if (remainderSeconds > 0) parts.add(remainderSeconds + " 秒");
        return String.join(" ", parts);
    }

    public static String size(long bytes) {
        if (bytes < 1_024) return bytes + " 字节";
        if (bytes < 1_048_576) return String.format(Locale.ROOT, "%.1f KiB", bytes / 1_024.0);
        if (bytes < 1_073_741_824) return String.format(Locale.ROOT, "%.1f MiB", bytes / 1_048_576.0);
        return String.format(Locale.ROOT, "%.1f GiB", bytes / 1_073_741_824.0);
    }
}
