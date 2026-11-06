package io.autoforge.jenkins.dependencies;

import hudson.AbortException;
import hudson.model.TaskListener;
import hudson.remoting.VirtualChannel;
import java.io.File;
import java.io.IOException;
import java.io.Serial;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.InvalidPathException;
import java.util.Map;
import jenkins.MasterToSlaveFileCallable;

/** Resolve the source and perform hashing and upload on the selected Jenkins Agent. */
final class UploadDependencyFile extends MasterToSlaveFileCallable<Map<String, Object>> {
    @Serial private static final long serialVersionUID = 1L;
    private final String baseUrl;
    private final String apiKey;
    private final String projectId;
    private final String version;
    private final String filePath;
    private final String fileName;
    private final String archiveFormat;
    private final TaskListener listener;

    UploadDependencyFile(String baseUrl, String apiKey, String projectId, String version,
            String filePath, String fileName, String archiveFormat, TaskListener listener) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.projectId = projectId;
        this.version = version;
        this.filePath = filePath;
        this.fileName = fileName;
        this.archiveFormat = archiveFormat;
        this.listener = listener;
    }

    @Override public Map<String, Object> invoke(File workspace, VirtualChannel channel) throws IOException, InterruptedException {
        Path archive = resolveArchive(workspace.toPath(), filePath);
        return new AutoForgeDependencyClient(baseUrl, apiKey, listener.getLogger())
            .upload(projectId, version, archive, fileName, archiveFormat);
    }

    static Path resolveArchive(Path workspace, String filePath) throws IOException {
        Path requested;
        try { requested = Path.of(filePath); }
        catch (InvalidPathException cause) {
            AbortException failure = new AbortException("filePath 不是有效的 Jenkins Agent 文件路径。");
            failure.initCause(cause);
            throw failure;
        }
        if (filePath.isBlank() || filePath.chars().anyMatch(Character::isISOControl))
            throw new AbortException("filePath 不能为空或包含控制字符。");
        // Absolute paths are an explicit Agent-local source, independent of workspace creation.
        if (requested.isAbsolute()) return readableArchive(requested.normalize());
        Path root = workspace.toRealPath();
        Path candidate = root.resolve(requested).normalize();
        if (!candidate.startsWith(root)) throw new AbortException("filePath 不能超出当前工作区。");
        Path archive = readableArchive(candidate);
        if (!archive.startsWith(root)) throw new AbortException("依赖文件的符号链接指向了工作区外部。");
        return archive;
    }

    private static Path readableArchive(Path candidate) throws IOException {
        if (!Files.isRegularFile(candidate))
            throw new AbortException("依赖文件不存在或不是普通文件，请检查当前 Jenkins Agent 上的 filePath。");
        if (!Files.isReadable(candidate))
            throw new AbortException("Jenkins Agent 运行账号没有读取依赖文件的权限，请检查 filePath 和文件权限。");
        return candidate.toRealPath();
    }
}
