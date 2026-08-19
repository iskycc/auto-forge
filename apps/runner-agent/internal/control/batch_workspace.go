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
	"strings"
	"sync"
)

// batchesDirectoryName 是 work/ 下批次共享目录的固定子目录名。
const batchesDirectoryName = "batches"

// batchRegistry 跟踪本机正在执行的批次共享目录：同一批次（batchId）的
// test-jar / dependency-jar / jar-bundle / jdk-archive 输入只下载解压一次，
// 同批次并发 attempt 通过硬链接或符号链接共享；批次进入终态且本机没有在途
// attempt 后删除共享目录。
type batchRegistry struct {
	mutex   sync.Mutex
	entries map[string]*batchEntry
	root    string // <数据目录>/work/batches
}

// batchEntry 串行化同一批次的输入下载与 JDK 解压，并记录本机在途 attempt 数。
type batchEntry struct {
	mutex          sync.Mutex
	activeAttempts int
}

func newBatchRegistry(dataDirectory string) *batchRegistry {
	return &batchRegistry{
		entries: make(map[string]*batchEntry),
		root:    filepath.Join(dataDirectory, "work", batchesDirectoryName),
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
	remove := batchClosed && entry.activeAttempts == 0
	if remove {
		delete(registry.entries, batchID)
	}
	registry.mutex.Unlock()
	if !remove {
		return
	}
	// 删除发生在注册表锁之外：批次已终态，控制面不会再为该批次派发新 attempt；
	// 即使极端竞争下新 attempt 恰好注册，重新下载也只是退化为未共享的旧行为。
	if err := os.RemoveAll(registry.directory(batchID)); err != nil && diagnostics != nil {
		fmt.Fprintf(diagnostics, "remove closed batch workspace %s: %v\n", batchID, err)
	}
}

// directory 返回批次共享目录；调用方必须已通过 acquire 校验 batchID。
func (registry *batchRegistry) directory(batchID string) string {
	return filepath.Join(registry.root, batchID)
}

// ensureBatchInputs 持批次锁确保共享目录中的输入齐备：已存在的输入流式重算
// SHA-256，匹配则跳过下载，不匹配或缺失则重新下载；JDK archive 只解压一次到
// batches/<batchId>/runtime/jdk。调用前必须已 acquire 该批次。
func (registry *batchRegistry) ensureBatchInputs(
	ctx context.Context,
	client *Client,
	identity Identity,
	claimed ClaimedAssignment,
	inputs []ExecutionInput,
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
	if err := ensureBatchJDK(batchDir, inputs, claimed.Assignment.ExecutionSpec.ResourceLimits); err != nil {
		return "", err
	}
	return batchDir, nil
}

// prepareSharedBatchWorkspace 持批次锁确保共享目录输入齐备，再把输入硬链接到
// attempt 工作目录原有的 TargetPath；adapter 模式的 JDK 以符号链接指向共享目录。
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
	)
	if err != nil {
		return err
	}
	if err := linkBatchInputsIntoWorkspace(batchDir, workspace, inputs); err != nil {
		return err
	}
	if useAdapter {
		return linkSharedJDK(batchDir, workspace, inputs)
	}
	return nil
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

// linkSharedJDK 把批次共享 JDK 以符号链接挂到 attempt 工作目录的 runtime/jdk，
// 使 adapter 的相对可执行路径 runtime/jdk/bin/java 无需改动即可解析到共享目录。
func linkSharedJDK(batchDir, workspace string, inputs []ExecutionInput) error {
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
	if err := os.Symlink(filepath.Join(batchDir, "runtime", "jdk"), target); err != nil {
		return fmt.Errorf("link shared JDK: %w", err)
	}
	return nil
}

// cleanOrphanedWorkspaces 在启动 reconcile 前清理崩溃残留：work/ 下不属于任何
// 已知本地 attempt 的 <attemptId>-* 工作目录，以及没有任何活跃 attempt 引用的
// 批次共享目录（启动时注册表为空，所有批次目录均视为无主残留）。
func (supervisor *attemptSupervisor) cleanOrphanedWorkspaces() error {
	states, err := supervisor.store.list()
	if err != nil {
		return fmt.Errorf("load local attempts for workspace cleanup: %w", err)
	}
	known := make(map[string]struct{}, len(states))
	for _, state := range states {
		known[state.Claimed.Assignment.AttemptID] = struct{}{}
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
			if err := removeOrphanedBatchWorkspaces(filepath.Join(workRoot, entry.Name())); err != nil {
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

// removeOrphanedBatchWorkspaces 删除 batches/ 下所有批次共享目录。
func removeOrphanedBatchWorkspaces(batchesRoot string) error {
	entries, err := os.ReadDir(batchesRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read batch workspaces for cleanup: %w", err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if err := os.RemoveAll(filepath.Join(batchesRoot, entry.Name())); err != nil {
			return fmt.Errorf("remove orphaned batch workspace %s: %w", entry.Name(), err)
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
