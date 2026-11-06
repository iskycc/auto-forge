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

/** Perform both hashing and HTTP upload beside the workspace, never on the Controller filesystem. */
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
        Path relative;
        try { relative = Path.of(filePath); }
        catch (InvalidPathException cause) {
            AbortException failure = new AbortException("filePath 不是有效的工作区文件路径。");
            failure.initCause(cause);
            throw failure;
        }
        if (relative.isAbsolute() || filePath.chars().anyMatch(Character::isISOControl))
            throw new AbortException("filePath 必须是工作区内的相对文件路径。");
        Path root = workspace.toPath().toRealPath();
        Path candidate = root.resolve(relative).normalize();
        if (!candidate.startsWith(root)) throw new AbortException("filePath 不能超出当前工作区。");
        if (!Files.exists(candidate) || !Files.isRegularFile(candidate))
            throw new AbortException("依赖文件不存在或不是普通文件，请先完成构建并检查 filePath。");
        Path archive = candidate.toRealPath();
        if (!archive.startsWith(root)) throw new AbortException("依赖文件的符号链接指向了工作区外部。");
        return new AutoForgeDependencyClient(baseUrl, apiKey, listener.getLogger())
            .upload(projectId, version, archive, fileName, archiveFormat);
    }
}
