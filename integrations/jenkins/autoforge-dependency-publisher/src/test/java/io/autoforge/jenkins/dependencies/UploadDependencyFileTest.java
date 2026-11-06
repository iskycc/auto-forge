package io.autoforge.jenkins.dependencies;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import hudson.AbortException;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class UploadDependencyFileTest {
    @TempDir Path temporary;

    @Test
    void acceptsAbsoluteAgentPathsBeforeTheWorkspaceHasBeenCreated() throws Exception {
        Path archive = Files.write(temporary.resolve("共享 构建.zip"), new byte[]{0x50, 0x4b, 3, 4});
        assertEquals(archive.toRealPath(), UploadDependencyFile.resolveArchive(
            temporary.resolve("not-created-workspace"), archive.toString()));
    }

    @Test
    void normalizesAnExplicitAbsolutePath() throws Exception {
        Path archive = Files.write(temporary.resolve("archive.zip"), new byte[]{0x50, 0x4b});
        String source = temporary.resolve("nested/../archive.zip").toString();
        assertEquals(archive.toRealPath(), UploadDependencyFile.resolveArchive(temporary, source));
    }

    @Test
    void retainsWorkspaceRelativePathsAndRejectsImplicitParentTraversal() throws Exception {
        Path workspace = Files.createDirectory(temporary.resolve("workspace"));
        Path archive = Files.write(workspace.resolve("archive.zip"), new byte[]{0x50, 0x4b});
        assertEquals(archive.toRealPath(), UploadDependencyFile.resolveArchive(workspace, "archive.zip"));
        assertTrue(assertThrows(AbortException.class,
            () -> UploadDependencyFile.resolveArchive(workspace, "../archive.zip"))
            .getMessage().contains("不能超出当前工作区"));
    }

    @Test
    void rejectsMissingFilesAndDirectoriesForAbsoluteSources() {
        for (Path invalid : new Path[]{temporary.resolve("missing.zip"), temporary})
            assertThrows(AbortException.class,
                () -> UploadDependencyFile.resolveArchive(temporary, invalid.toString()));
    }

    @Test
    void rejectsBlankAndControlCharacterPaths() {
        for (String invalid : new String[]{" ", "archive.zip\n", "archive\u0000.zip"})
            assertThrows(AbortException.class,
                () -> UploadDependencyFile.resolveArchive(temporary, invalid));
    }

    @Test
    void keepsRelativeSymlinksInsideTheWorkspaceAndAllowsAnExplicitAbsoluteSource() throws Exception {
        Assumptions.assumeTrue(File.separatorChar == '/');
        Path workspace = Files.createDirectory(temporary.resolve("workspace"));
        Path archive = Files.write(temporary.resolve("archive.zip"), new byte[]{0x50, 0x4b});
        Path link = Files.createSymbolicLink(workspace.resolve("linked.zip"), archive);
        assertTrue(assertThrows(AbortException.class,
            () -> UploadDependencyFile.resolveArchive(workspace, "linked.zip"))
            .getMessage().contains("符号链接"));
        assertEquals(archive.toRealPath(), UploadDependencyFile.resolveArchive(workspace, link.toString()));
    }
}
