package control

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// batchesDirectoryName 是 work/ 下批次共享目录的固定子目录名。
const batchesDirectoryName = "batches"

const maximumCachedBatchIDs = 1_024

// batchRegistry 跟踪本机正在执行的批次共享目录：同一批次（batchId）的
// test-jar / dependency-jar / jar-bundle / jdk-archive 输入只下载解压一次，
// 同批次并发 attempt 通过硬链接或受控目录链接共享；批次进入终态且本机没有在途
// attempt 后删除共享目录。
type batchRegistry struct {
	mutex     sync.Mutex
	entries   map[string]*batchEntry
	root      string // <数据目录>/work/batches
	removeAll func(string) error
}

// batchEntry 串行化同一批次的输入下载与运行时物化，并记录本机在途 attempt 数。
type batchEntry struct {
	mutex          sync.Mutex
	activeAttempts int
	closed         bool
}

func newBatchRegistry(dataDirectory string) *batchRegistry {
	return &batchRegistry{
		entries:   make(map[string]*batchEntry),
		root:      filepath.Join(dataDirectory, "work", batchesDirectoryName),
		removeAll: os.RemoveAll,
	}
}

// validBatchID 要求 batchId 是安全的单一路径段：拒绝路径分隔符、`..` 等
// 任何可能越出 batches/ 根目录的取值。
func validBatchID(batchID string) bool {
	return localIdentifierPattern.MatchString(batchID) &&
		!strings.ContainsAny(batchID, `/\`) &&
		filepath.IsLocal(batchID) && batchID != ".."
}

// acquire 在 attempt 开始时注册批次引用；batchID 为空表示不启用批次共享。
func (registry *batchRegistry) acquire(batchID string) error {
	if batchID == "" {
		return nil
	}
	if !validBatchID(batchID) {
		return fmt.Errorf("batch identifier %q is not a safe path segment", batchID)
	}
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	entry, exists := registry.entries[batchID]
	if !exists {
		entry = &batchEntry{}
		registry.entries[batchID] = entry
	}
	entry.activeAttempts++
	return nil
}

// restoreIdle 恢复 Agent 重启前已原子发布的批次目录。目录先作为空闲缓存注册，
// reconcile 完成后由 heartbeat/claim 向控制面确认是否仍可能继续派发该批次。
func (registry *batchRegistry) restoreIdle(batchID string) error {
	if !validBatchID(batchID) {
		return fmt.Errorf("batch identifier %q is not a safe path segment", batchID)
	}
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	if _, exists := registry.entries[batchID]; !exists {
		registry.entries[batchID] = &batchEntry{}
	}
	return nil
}

// release 在 attempt 收尾时注销批次引用。batchClosed 表示控制面已确认批次进入
// 终态；此时若本机没有其他在途 attempt，则删除批次共享目录。删除失败只记录诊断，
// 不影响 attempt 的终态上报。
func (registry *batchRegistry) release(batchID string, batchClosed bool, diagnostics io.Writer) {
	if batchID == "" {
		return
	}
	registry.mutex.Lock()
	entry, exists := registry.entries[batchID]
	if !exists {
		registry.mutex.Unlock()
		return
	}
	if entry.activeAttempts > 0 {
		entry.activeAttempts--
	}
	entry.closed = entry.closed || batchClosed
	remove := entry.closed && entry.activeAttempts == 0
	if remove {
		delete(registry.entries, batchID)
	}
	registry.mutex.Unlock()
	if !remove {
		return
	}
	// 删除发生在注册表锁之外：批次已终态，控制面不会再为该批次派发新 attempt；
	// 即使极端竞争下新 attempt 恰好注册，重新下载也只是退化为未共享的旧行为。
	if err := registry.removeAll(registry.directory(batchID)); err != nil {
		registry.rememberFailedRemoval(batchID)
		if diagnostics != nil {
			fmt.Fprintf(diagnostics, "remove closed batch workspace %s: %v\n", batchID, err)
		}
	}
}

// idleBatchIDs 返回本机已无在途 attempt、但尚未收到控制面回收确认的批次。
// heartbeat/claim 会把这些 ID 带回控制面，使重启、排空及多 Runner 场景都能
// 在批次不再可能派发到本机后及时回收共享目录。
func (registry *batchRegistry) idleBatchIDs() []string {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	batchIDs := make([]string, 0, len(registry.entries))
	for batchID, entry := range registry.entries {
		if entry.activeAttempts == 0 && !entry.closed {
			batchIDs = append(batchIDs, batchID)
		}
	}
	sort.Strings(batchIDs)
	if len(batchIDs) > maximumCachedBatchIDs {
		batchIDs = batchIDs[:maximumCachedBatchIDs]
	}
	return batchIDs
}

// close 应用控制面通过 heartbeat/claim 返回的回收确认。若极端竞态下同批次
// 又有本地 attempt，closed 标记会保留，最后一个 attempt 收尾时再删除目录。
func (registry *batchRegistry) close(batchID string, diagnostics io.Writer) {
	registry.mutex.Lock()
	entry, exists := registry.entries[batchID]
	if !exists {
		registry.mutex.Unlock()
		return
	}
	entry.closed = true
	remove := entry.activeAttempts == 0
	if remove {
		delete(registry.entries, batchID)
	}
	registry.mutex.Unlock()
	if !remove {
		return
	}
	if err := registry.removeAll(registry.directory(batchID)); err != nil {
		registry.rememberFailedRemoval(batchID)
		if diagnostics != nil {
			fmt.Fprintf(diagnostics, "remove closed batch workspace %s: %v\n", batchID, err)
		}
	}
}

// rememberFailedRemoval 让删除失败的目录重新进入 cachedBatchIds 握手，控制面下一次
// 返回 closedBatchIds 时会再次尝试。若极端竞态下已有新 attempt，则保留 closed，
// 等该 attempt 收尾时重试删除。
func (registry *batchRegistry) rememberFailedRemoval(batchID string) {
	registry.mutex.Lock()
	defer registry.mutex.Unlock()
	if entry, exists := registry.entries[batchID]; exists {
		entry.closed = true
		return
	}
	registry.entries[batchID] = &batchEntry{}
}

// directory 返回批次共享目录；调用方必须已通过 acquire 校验 batchID。
func (registry *batchRegistry) directory(batchID string) string {
	return filepath.Join(registry.root, batchID)
}

// ensureBatchInputs 持批次锁确保共享目录中的输入齐备：已存在的输入流式重算
// SHA-256，匹配则跳过下载，不匹配或缺失则重新下载；Adapter 依赖与可选 JDK
// 只物化一次到批次运行时。调用前必须已 acquire 该批次。
func (registry *batchRegistry) ensureBatchInputs(
	ctx context.Context,
	client *Client,
	identity Identity,
	claimed ClaimedAssignment,
	inputs []ExecutionInput,
	useAdapter bool,
) (string, error) {
	batchID := claimed.Assignment.ExecutionSpec.BatchID
	registry.mutex.Lock()
	entry, exists := registry.entries[batchID]
	registry.mutex.Unlock()
	if !exists {
		return "", fmt.Errorf("batch %s has no active attempt registration", batchID)
	}
	entry.mutex.Lock()
	defer entry.mutex.Unlock()
	batchDir := registry.directory(batchID)
	if err := os.MkdirAll(batchDir, 0o700); err != nil {
		return "", fmt.Errorf("create batch workspace: %w", err)
	}
	for _, input := range inputs {
		matches, err := existingInputMatches(batchDir, input)
		if err != nil {
			return "", err
		}
		if matches {
			continue
		}
		// 下载仍复用单输入实现：临时文件 + fsync + 原子 rename + 配额/校验值验证。
		if err := downloadAttemptInput(ctx, client, identity, claimed, input, batchDir); err != nil {
			return "", fmt.Errorf("download shared batch input %s: %w", input.InputID, err)
		}
	}
	if useAdapter {
		if err := ensureBatchCotestRuntime(batchDir, inputs, claimed.Assignment.ExecutionSpec.ResourceLimits); err != nil {
			return "", err
		}
	} else if err := ensureBatchJDK(batchDir, inputs, claimed.Assignment.ExecutionSpec.ResourceLimits); err != nil {
		return "", err
	}
	return batchDir, nil
}

// prepareSharedBatchWorkspace 持批次锁确保共享目录输入齐备，再把输入硬链接到
// attempt 工作目录原有的 TargetPath；Adapter 模式的 test-jars 使用真实目录和
// 文件级硬链接，避免 Java 目录遍历跳过符号链接根目录；可选 JDK 以符号链接复用。
func (supervisor *attemptSupervisor) prepareSharedBatchWorkspace(
	ctx context.Context,
	claimed ClaimedAssignment,
	inputs []ExecutionInput,
	workspace string,
	useAdapter bool,
) error {
	batchDir, err := supervisor.batches.ensureBatchInputs(
		ctx,
		supervisor.client,
		supervisor.currentIdentity(),
		claimed,
		inputs,
		useAdapter,
	)
	if err != nil {
		return err
	}
	if err := linkBatchInputsIntoWorkspace(batchDir, workspace, inputs); err != nil {
		return err
	}
	if useAdapter {
		return linkSharedCotestRuntime(batchDir, workspace, inputs)
	}
	return nil
}

// ensureBatchCotestRuntime 在批次锁内一次性生成 Adapter 使用的 test-jars 与可选
// JDK。先在临时目录完成所有复制/解压，再原子发布 runtime/cotest，崩溃留下的
// 半成品不会被后续 attempt 当成可用运行时。
func ensureBatchCotestRuntime(batchDir string, inputs []ExecutionInput, limits ResourceLimits) error {
	target := filepath.Join(batchDir, "runtime", "cotest")
	if cotestRuntimeReady(target, inputs) {
		return nil
	}
	budget, err := newCotestArchiveBudget(inputs, limits.DiskBytes, limits.FileCount)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("prepare shared CoTest runtime directory: %w", err)
	}
	staging, err := os.MkdirTemp(filepath.Dir(target), ".cotest-staging-")
	if err != nil {
		return fmt.Errorf("create shared CoTest staging directory: %w", err)
	}
	defer os.RemoveAll(staging)
	if err := materializeCotestJars(batchDir, filepath.Join(staging, "test-jars"), inputs, budget); err != nil {
		return err
	}
	if err := materializeCotestJDK(batchDir, filepath.Join(staging, "jdk"), inputs, budget); err != nil {
		return err
	}
	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("reset shared CoTest runtime: %w", err)
	}
	if err := os.Rename(staging, target); err != nil {
		return fmt.Errorf("publish shared CoTest runtime: %w", err)
	}
	return nil
}

func cotestRuntimeReady(target string, inputs []ExecutionInput) bool {
	if info, err := os.Stat(filepath.Join(target, "test-jars")); err != nil || !info.IsDir() {
		return false
	}
	for _, input := range inputs {
		if input.Kind != "jdk-archive" {
			continue
		}
		info, err := os.Stat(filepath.Join(target, "jdk", "bin", "java"))
		return err == nil && info.Mode().IsRegular()
	}
	return true
}

// existingInputMatches 流式重算已存在输入的 SHA-256；文件缺失时返回 false 以触发下载。
func existingInputMatches(batchDir string, input ExecutionInput) (bool, error) {
	if !filepath.IsLocal(input.TargetPath) {
		return false, fmt.Errorf("execution input path %q is invalid", input.TargetPath)
	}
	path := filepath.Join(batchDir, filepath.Clean(input.TargetPath))
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("open shared batch input: %w", err)
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return false, fmt.Errorf("hash shared batch input: %w", err)
	}
	return hex.EncodeToString(digest.Sum(nil)) == input.SHA256, nil
}

// ensureBatchJDK 把批次级 JDK archive 只解压一次到共享目录的 runtime/jdk；
// 上次已完成解压（bin/java 存在）时直接复用，中断留下的半成品会先清理再重试。
func ensureBatchJDK(batchDir string, inputs []ExecutionInput, limits ResourceLimits) error {
	var jdkArchive *ExecutionInput
	var inputBytes int64
	for index := range inputs {
		inputBytes += inputs[index].SizeBytes
		if inputs[index].Kind == "jdk-archive" {
			jdkArchive = &inputs[index]
		}
	}
	if jdkArchive == nil {
		return nil
	}
	target := filepath.Join(batchDir, "runtime", "jdk")
	if info, err := os.Stat(filepath.Join(target, "bin", "java")); err == nil && info.Mode().IsRegular() {
		return nil
	}
	// 解压预算沿用 attempt 资源上限，与逐 attempt 解压路径保持同一安全边界。
	budget := &archiveBudget{
		remainingBytes: limits.DiskBytes - inputBytes,
		remainingFiles: limits.FileCount - int64(len(inputs)),
	}
	if budget.remainingBytes < 0 || budget.remainingFiles < 0 {
		return errors.New("execution inputs leave no capacity for JDK extraction")
	}
	unpacked := filepath.Join(batchDir, "runtime", "jdk-unpacked")
	if err := os.RemoveAll(unpacked); err != nil {
		return fmt.Errorf("reset incomplete JDK extraction: %w", err)
	}
	if err := extractArchive(
		filepath.Join(batchDir, filepath.Clean(jdkArchive.TargetPath)),
		unpacked,
		budget,
	); err != nil {
		return fmt.Errorf("extract shared JDK: %w", err)
	}
	javaHome, err := locateJavaHome(unpacked)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(target); err != nil {
		return fmt.Errorf("reset shared JDK target: %w", err)
	}
	if err := os.Rename(javaHome, target); err != nil {
		return fmt.Errorf("publish shared JDK: %w", err)
	}
	if err := os.Chmod(filepath.Join(target, "bin", "java"), 0o700); err != nil {
		return fmt.Errorf("make shared Java executable: %w", err)
	}
	return os.RemoveAll(unpacked)
}

// linkBatchInputsIntoWorkspace 把批次共享输入硬链接到 attempt 工作目录原有的
// TargetPath；跨文件系统等不支持硬链接的场景回退为完整复制。
func linkBatchInputsIntoWorkspace(batchDir, workspace string, inputs []ExecutionInput) error {
	for _, input := range inputs {
		if !filepath.IsLocal(input.TargetPath) {
			return fmt.Errorf("execution input path %q is invalid", input.TargetPath)
		}
		source := filepath.Join(batchDir, filepath.Clean(input.TargetPath))
		destination := filepath.Join(workspace, filepath.Clean(input.TargetPath))
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return fmt.Errorf("prepare input directory: %w", err)
		}
		if err := os.Link(source, destination); err == nil {
			continue
		}
		if err := copyRegularFile(source, destination); err != nil {
			return fmt.Errorf("materialize shared batch input %s: %w", input.InputID, err)
		}
	}
	return nil
}

// linkSharedCotestRuntime 把批次共享 test-jars 与可选 JDK 挂到 attempt 工作目录。
// Adapter 使用不跟随符号链接的 Files.walkFileTree，因此 test-jars 根目录必须是真实
// 目录；目录内文件以硬链接复用，跨文件系统时才回退复制。JDK 由已知路径直接执行，
// 可以安全地以目录符号链接复用。
func linkSharedCotestRuntime(batchDir, workspace string, inputs []ExecutionInput) error {
	sharedRuntime := filepath.Join(batchDir, "runtime", "cotest")
	if err := linkSharedRegularTree(
		filepath.Join(sharedRuntime, "test-jars"),
		filepath.Join(workspace, "test-jars"),
	); err != nil {
		return fmt.Errorf("link shared CoTest JAR tree: %w", err)
	}
	hasJDKArchive := false
	for _, input := range inputs {
		if input.Kind == "jdk-archive" {
			hasJDKArchive = true
			break
		}
	}
	if !hasJDKArchive {
		return nil
	}
	target := filepath.Join(workspace, "runtime", "jdk")
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return fmt.Errorf("prepare runtime directory: %w", err)
	}
	if err := os.Symlink(filepath.Join(sharedRuntime, "jdk"), target); err != nil {
		return fmt.Errorf("link shared JDK: %w", err)
	}
	return nil
}

// linkSharedRegularTree 保留目录结构并让目标树中的每个文件共享源 inode。
// 批次运行时在调用前已经完成安全解压并原子发布；这里仍拒绝符号链接和特殊文件，
// 避免未来物化规则变化时把越界路径带入 attempt 工作目录。
func linkSharedRegularTree(sourceRoot, destinationRoot string) error {
	return filepath.WalkDir(sourceRoot, func(sourcePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relativePath, err := filepath.Rel(sourceRoot, sourcePath)
		if err != nil {
			return err
		}
		destinationPath := filepath.Join(destinationRoot, relativePath)
		if entry.IsDir() {
			if err := os.MkdirAll(destinationPath, 0o700); err != nil {
				return fmt.Errorf("create shared JAR directory %q: %w", relativePath, err)
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("shared JAR entry %q is not a regular file", relativePath)
		}
		if err := os.Link(sourcePath, destinationPath); err == nil {
			return nil
		}
		if err := copyRegularFile(sourcePath, destinationPath); err != nil {
			return fmt.Errorf("materialize shared JAR entry %q: %w", relativePath, err)
		}
		return nil
	})
}

// cleanOrphanedWorkspaces 在启动恢复阶段清理不属于本地 attempt 的独立工作
// 目录，并恢复安全的批次共享目录。该扫描可在 reconcile 前后重复执行：前者清理
// 既有孤儿，后者清理本轮刚删除状态的目录。批次目录不能在重启时直接删除：同一
// 批次可能仍有待派发用例；恢复为 idle 后再由控制面确认是否可回收。
func (supervisor *attemptSupervisor) cleanOrphanedWorkspaces() error {
	known, err := supervisor.store.identifiers()
	if err != nil {
		return fmt.Errorf("load local attempts for workspace cleanup: %w", err)
	}
	workRoot := filepath.Join(supervisor.configuration.DataDirectory, "work")
	entries, err := os.ReadDir(workRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read work root for cleanup: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if entry.Name() == batchesDirectoryName {
			if err := supervisor.restoreBatchWorkspaces(filepath.Join(workRoot, entry.Name())); err != nil {
				return err
			}
			continue
		}
		if isOrphanAttemptWorkspace(entry.Name(), known) {
			if err := os.RemoveAll(filepath.Join(workRoot, entry.Name())); err != nil {
				return fmt.Errorf("remove orphaned attempt workspace %s: %w", entry.Name(), err)
			}
		}
	}
	return nil
}

// restoreBatchWorkspaces 注册所有安全的批次目录供后续终态核对；非目录或非法
// 标识属于本地损坏/非产品内容，只删除 batches 根下的该条目且不跟随符号链接。
func (supervisor *attemptSupervisor) restoreBatchWorkspaces(batchesRoot string) error {
	entries, err := os.ReadDir(batchesRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read batch workspaces for cleanup: %w", err)
	}
	for _, entry := range entries {
		path := filepath.Join(batchesRoot, entry.Name())
		if !entry.IsDir() || !validBatchID(entry.Name()) {
			if err := os.RemoveAll(path); err != nil {
				return fmt.Errorf("remove invalid batch workspace %s: %w", entry.Name(), err)
			}
			continue
		}
		if err := supervisor.batches.restoreIdle(entry.Name()); err != nil {
			return fmt.Errorf("restore batch workspace %s: %w", entry.Name(), err)
		}
	}
	return nil
}

// isOrphanAttemptWorkspace 判断 work/ 下的目录是否是没有本地状态引用的崩溃残留。
// 工作目录由 os.MkdirTemp(workRoot, attemptID+"-") 创建，随机后缀不含 "-"，
// 因此最后一个 "-" 之前即 attempt ID。
func isOrphanAttemptWorkspace(name string, known map[string]struct{}) bool {
	separator := strings.LastIndexByte(name, '-')
	if separator < 1 {
		return false
	}
	_, exists := known[name[:separator]]
	return !exists
}
