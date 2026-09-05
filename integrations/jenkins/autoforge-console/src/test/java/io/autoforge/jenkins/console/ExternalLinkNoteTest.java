package io.autoforge.jenkins.console;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import hudson.MarkupText;
import org.junit.jupiter.api.Test;

class ExternalLinkNoteTest {
    @Test
    void escapesLinkAttributesAndCaptionsWhileOpeningAnIsolatedTab() {
        String caption = "完整结果<script>";
        MarkupText markup = new MarkupText(caption);
        new ExternalLinkNote("https://autoforge.example/share?token='quoted'&round=2", caption.length())
            .annotate(null, markup, 0);

        String html = markup.toString(false);
        assertTrue(html.contains("target=\"_blank\""));
        assertTrue(html.contains("rel=\"noopener noreferrer\""));
        assertTrue(html.contains("&amp;round=2"));
        assertTrue(html.contains("&lt;script&gt;"));
        assertFalse(html.contains("token='quoted'"));
        assertFalse(html.contains("<script>"));
    }

    @Test
    void rejectsExecutableRelativeAndCredentialBearingLinks() {
        for (String url : new String[] {
                "javascript:alert(1)", "data:text/html,test", "//example.test/path",
                "/relative/path", "https://user:password@example.test/", "https://example.test/\nforged"}) {
            assertThrows(IllegalArgumentException.class, () -> new ExternalLinkNote(url, 4));
        }
    }
}
