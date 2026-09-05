package io.autoforge.jenkins.console;

import hudson.console.HyperlinkNote;
import java.io.Serial;
import java.net.URI;

/** Controller-signed console markup; no browser scripts or global markup settings are needed. */
public final class ExternalLinkNote extends HyperlinkNote {
    @Serial private static final long serialVersionUID = 1L;

    public ExternalLinkNote(String url, int length) {
        super(validatedUrl(url), length);
    }

    @Override
    protected String extraAttributes() {
        return " target=\"_blank\" rel=\"noopener noreferrer\" title=\"在新标签页打开\"";
    }

    private static String validatedUrl(String url) {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException failure) {
            throw new IllegalArgumentException("控制台链接必须是有效的 HTTP 或 HTTPS 地址。", failure);
        }
        if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                || uri.getHost() == null || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("控制台链接必须使用 HTTP 或 HTTPS，且不能包含用户名或密码。");
        }
        return uri.toASCIIString();
    }
}
