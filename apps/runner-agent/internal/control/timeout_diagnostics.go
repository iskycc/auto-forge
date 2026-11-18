package control

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/executor"
)

const (
	maximumThreadDumpBytes = 64 << 10
	threadDumpTimeout      = 2 * time.Second
	maximumThreadSlotWait  = 4 * time.Second
)

type attemptTimeoutDiagnostics struct {
	mutex           sync.Mutex
	startedAt       time.Time
	lastOutputAt    time.Time
	lastUploadAt    time.Time
	outputBytes     int64
	uploads         int
	limitedUploads  int
	lastUploadError string
	threadSummary   string
	stop            context.CancelFunc
	done            chan struct{}
}

func (diagnostics *attemptTimeoutDiagnostics) observeOutput(chunk executor.LogChunk) {
	if chunk.Stream != "stdout" && chunk.Stream != "stderr" {
		return
	}
	diagnostics.mutex.Lock()
	defer diagnostics.mutex.Unlock()
	diagnostics.lastOutputAt = chunk.RecordedAt
	diagnostics.outputBytes += int64(len(chunk.Content))
}

func (diagnostics *attemptTimeoutDiagnostics) observeUpload(err error) {
	diagnostics.mutex.Lock()
	defer diagnostics.mutex.Unlock()
	diagnostics.uploads++
	if err == nil {
		diagnostics.lastUploadAt = time.Now().UTC()
		return
	}
	var problem *APIError
	if errors.As(err, &problem) {
		diagnostics.lastUploadError = boundedSummary(fmt.Sprintf("HTTP %d / %s：%s", problem.StatusCode, problem.Code, problem.Message))
		if problem.StatusCode == 429 {
			diagnostics.limitedUploads++
		}
	} else {
		diagnostics.lastUploadError = "网络或日志传输错误"
	}
}

// A single snapshot near the control-plane deadline captures evidence before
// either watchdog kills Java. It never delays the executor's termination path.
func (supervisor *attemptSupervisor) startTimeoutDiagnostics(
	diagnostics *attemptTimeoutDiagnostics,
	identity executor.ProcessIdentity,
	claimed ClaimedAssignment,
	collector *attemptLogCollector,
	startupStartedAt time.Time,
) {
	diagnostics.startedAt = time.Now().UTC()
	ctx, stop := context.WithCancel(context.Background())
	diagnostics.stop = stop
	diagnostics.done = make(chan struct{})
	timeout := time.Duration(claimed.Assignment.ExecutionSpec.TimeoutMs) * time.Millisecond
	lead := min(15*time.Second, max(100*time.Millisecond, timeout/10))
	at := startupStartedAt.Add(timeout - lead)
	go func() {
		defer close(diagnostics.done)
		timer := time.NewTimer(max(0, time.Until(at)))
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		processSummary := describeTimeoutProcess(identity)
		threadSummary := "未采集线程栈：节点正在采集其他用例的诊断。"
		dump := ""
		// Preserve time for the probe and its upload even when several cases
		// reach the diagnostic window on the same node.
		slotWait := min(maximumThreadSlotWait, lead-threadDumpTimeout-time.Second)
		if waitForThreadDiagnosticSlot(ctx, supervisor.threadDiagnosticSlot, slotWait) {
			probeCtx, cancel := context.WithTimeout(ctx, threadDumpTimeout)
			dump, threadSummary = captureJavaThreadDump(probeCtx, identity, claimed.Assignment.ExecutionSpec.ClassName)
			cancel()
			<-supervisor.threadDiagnosticSlot
		}
		if ctx.Err() != nil {
			return
		}
		diagnostics.mutex.Lock()
		diagnostics.threadSummary = threadSummary
		diagnostics.mutex.Unlock()
		recordedAt := time.Now().UTC()
		content := "[AutoForge 超时前诊断]\n" + diagnostics.describe(claimed.Assignment.ExecutionSpec.TimeoutMs, recordedAt) + "\n" + processSummary + "\n"
		if adapter := claimed.Assignment.ExecutionSpec.Adapter; adapter != nil {
			if address, err := netip.ParseAddr(adapter.EnvironmentAddress); err == nil && address.Zone() == "" {
				content += "本次用例的环境 IP：" + address.String() + "。\n"
			}
		}
		if dump != "" {
			content += "\n[JVM 线程快照]\n" + dump + "\n"
		}
		if err := collector.WriteDiagnostic(content, recordedAt); err != nil {
			diagnostics.mutex.Lock()
			diagnostics.threadSummary += "\n超时诊断日志未能保存，请检查节点暂存空间和 Agent 后台日志；原始用例结果不因此改判。"
			diagnostics.mutex.Unlock()
			fmt.Fprintf(supervisor.diagnostics, "persist timeout diagnostics for %s: %v\n", claimed.Assignment.AttemptID, err)
		}
	}()
}

func waitForThreadDiagnosticSlot(ctx context.Context, slot chan struct{}, maximumWait time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	select {
	case slot <- struct{}{}:
		return true
	default:
	}
	if maximumWait <= 0 {
		return false
	}
	timer := time.NewTimer(maximumWait)
	defer timer.Stop()
	select {
	case slot <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	case <-timer.C:
		return false
	}
}

func describeTimeoutProcess(identity executor.ProcessIdentity) string {
	snapshot, err := executor.ReadProcessSnapshot(identity)
	if err != nil {
		return "节点进程快照不可用：" + err.Error() + "。"
	}
	return fmt.Sprintf("节点进程快照：PID %d；Linux 状态 %s；%d 个线程；常驻内存 %.1f MiB。",
		identity.ProcessID, snapshot.State, snapshot.ThreadCount, float64(snapshot.ResidentBytes)/(1<<20))
}

func (diagnostics *attemptTimeoutDiagnostics) close() {
	if diagnostics.stop == nil {
		return
	}
	diagnostics.stop()
	<-diagnostics.done
}

func (diagnostics *attemptTimeoutDiagnostics) describe(timeoutMs int64, observedAt time.Time) string {
	diagnostics.mutex.Lock()
	defer diagnostics.mutex.Unlock()
	lines := []string{fmt.Sprintf("执行机诊断：配置期限 %.1f 秒；Java 启动 %s。", float64(timeoutMs)/1000, diagnosticTime(diagnostics.startedAt)),
		fmt.Sprintf("最后 stdout/stderr：%s；已采集 %d 字节。", diagnosticTime(diagnostics.lastOutputAt), diagnostics.outputBytes),
		fmt.Sprintf("日志上传：%d 次，429 限流 %d 次；最近成功 %s。", diagnostics.uploads, diagnostics.limitedUploads, diagnosticTime(diagnostics.lastUploadAt))}
	if !diagnostics.lastOutputAt.IsZero() {
		if silence := observedAt.Sub(diagnostics.lastOutputAt); silence >= 0 {
			lines = append(lines, fmt.Sprintf("记录时距最后输出 %.1f 秒。", silence.Seconds()))
		}
	}
	if diagnostics.lastUploadError != "" {
		lines = append(lines, "最近上传错误："+diagnostics.lastUploadError+"。")
	}
	if diagnostics.limitedUploads > 0 {
		lines = append(lines, "上传限流会造成页面日志断更，不能据此认定 Java 没有继续输出。")
	}
	if diagnostics.threadSummary != "" {
		lines = append(lines, diagnostics.threadSummary)
	} else {
		lines = append(lines, "尚无线程快照，无法确认业务阻塞点。")
	}
	return strings.Join(lines, "\n")
}

func diagnosticTime(value time.Time) string {
	if value.IsZero() {
		return "未记录"
	}
	return value.UTC().Format(time.RFC3339Nano)
}

// /proc resolves the actual JVM, including an uploaded JDK and any rlimit shim.
func captureJavaThreadDump(ctx context.Context, identity executor.ProcessIdentity, className string) (string, string) {
	current, inspectErr := executor.ReadProcessIdentity(identity.ProcessID)
	if inspectErr != nil || identity.StartTimeTicks == 0 || current.StartTimeTicks != identity.StartTimeTicks {
		return "", "线程快照不可用：原进程已退出或进程身份发生变化，不采集其他进程。"
	}
	pid := identity.ProcessID
	executable, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe"))
	if err != nil {
		return "", "线程快照不可用：进程已结束或无权读取进程。"
	}
	if filepath.Base(executable) != "java" {
		return "", "线程快照不可用：当前进程不是可直接诊断的 Java（例如容器执行）。"
	}
	stackLauncher := filepath.Join(filepath.Dir(executable), "jstack")
	if info, err := os.Stat(stackLauncher); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
		dump, err := runJavaThreadDump(ctx, stackLauncher, []string{"-J-Xms16m", "-J-Xmx64m", "-l", strconv.Itoa(pid)})
		if err == nil || (!errors.Is(err, os.ErrPermission) && !errors.Is(err, os.ErrNotExist)) {
			return dump, reportJavaThreadDump(dump, err, className, "jstack")
		}
	}
	// Runtime extraction deliberately keeps all files except bin/java non-executable.
	// Invoke the same JDK's JStack entry point through its Java launcher. This also
	// works with previously extracted workspaces without changing their permissions.
	dump, fallbackErr := runJavaThreadDump(ctx, executable, javaThreadDumpArguments(executable, pid))
	return dump, reportJavaThreadDump(dump, fallbackErr, className, "JDK Java 入口")
}

func javaThreadDumpArguments(executable string, pid int) []string {
	const jstackClass = "sun.tools.jstack.JStack"
	javaHome := filepath.Dir(filepath.Dir(executable))
	if filepath.Base(javaHome) == "jre" {
		javaHome = filepath.Dir(javaHome) // JDK 8 may launch its embedded JRE.
	}
	toolsJar := filepath.Join(javaHome, "lib", "tools.jar")
	toolArguments := []string{"-m", "jdk.jcmd/" + jstackClass}
	if info, err := os.Stat(toolsJar); err == nil && info.Mode().IsRegular() {
		toolArguments = []string{"-cp", toolsJar, jstackClass}
	}
	args := append([]string{"-Xms16m", "-Xmx64m"}, toolArguments...)
	return append(args, "-l", strconv.Itoa(pid))
}

func runJavaThreadDump(ctx context.Context, executable string, arguments []string) (string, error) {
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Env = []string{"LANG=C.UTF-8", "LC_ALL=C.UTF-8", "PATH=/usr/bin:/bin"}
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	command.Cancel = func() error {
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	command.WaitDelay = 200 * time.Millisecond
	output := &boundedDiagnosticOutput{}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	text, truncated := output.content()
	dump := redactAgentLog(strings.ToValidUTF8(text, "�"), nil)
	if truncated {
		dump += "\n[线程快照达到 64 KiB 上限，后续内容省略]"
	}
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	return dump, err
}

func reportJavaThreadDump(dump string, err error, className, tool string) string {
	if err != nil {
		reason := boundedSummary(err.Error())
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			reason = fmt.Sprintf("在 %.0f 秒内未完成 JVM Attach 或线程快照采集", threadDumpTimeout.Seconds())
		case errors.Is(err, os.ErrPermission):
			reason = "操作系统拒绝启动诊断程序，请检查执行权限、挂载和服务限制"
		case strings.Contains(dump, "Module jdk.jcmd not found"), strings.Contains(dump, "Could not find or load main class sun.tools.jstack.JStack"), strings.Contains(dump, "Unrecognized option: -m"):
			reason = "运行时缺少 JDK 线程诊断组件，请检查项目绑定的 JDK 压缩包"
		case strings.Contains(dump, "AttachNotSupportedException"), strings.Contains(dump, "attach mechanism is disabled"):
			reason = "未能连接目标 JVM，请检查 Attach 设置和执行机权限"
		}
		return "线程快照采集失败（" + tool + "）：" + reason + "。工具输出见执行机诊断日志。"
	}
	return summarizeJavaThreadDump(dump, className) + "\n采集方式：" + tool + "。"
}

type boundedDiagnosticOutput struct {
	mutex     sync.Mutex
	text      strings.Builder
	truncated bool
}

func (output *boundedDiagnosticOutput) content() (string, bool) {
	output.mutex.Lock()
	defer output.mutex.Unlock()
	return output.text.String(), output.truncated
}

func (output *boundedDiagnosticOutput) Write(value []byte) (int, error) {
	output.mutex.Lock()
	defer output.mutex.Unlock()
	accepted := min(len(value), maximumThreadDumpBytes-output.text.Len())
	_, _ = output.text.Write(value[:accepted])
	output.truncated = output.truncated || accepted < len(value)
	return len(value), nil
}

func summarizeJavaThreadDump(dump, className string) string {
	if strings.Contains(dump, "Found one Java-level deadlock") || strings.Contains(dump, "Found 1 deadlock") {
		return "线程快照发现 Java 死锁；完整锁持有关系见执行机诊断日志。"
	}
	selected := ""
	score := 0
	for _, block := range strings.Split(dump, "\n\n") {
		if !strings.HasPrefix(strings.TrimSpace(block), "\"") {
			continue
		}
		candidate := 0
		if strings.HasPrefix(block, "\"main\"") {
			candidate = 1
		}
		if strings.Contains(block, "\"adapter-case-execution\"") {
			candidate = 5
		}
		if className != "" && strings.Contains(block, className+".") {
			candidate = 10
		}
		if candidate > score {
			selected = block
			score = candidate
		}
	}
	if selected == "" {
		return "已采集 JVM 线程快照，未自动识别业务线程；请查看执行机诊断日志。"
	}
	reason := "线程快照不足以确认具体阻塞原因"
	switch {
	case strings.Contains(selected, "java.lang.Thread.State: BLOCKED"):
		reason = "业务线程正在等待 Java 锁"
	case strings.Contains(selected, "socketRead") || strings.Contains(selected, "SocketDispatcher.read") || strings.Contains(selected, "NioSocketImpl") || strings.Contains(selected, "SocketInputStream"):
		reason = "业务线程快照位于网络读取／等待，需核对被测接口或外部服务响应"
	case strings.Contains(selected, "FileOutputStream.writeBytes") || strings.Contains(selected, "FileDispatcherImpl.write"):
		reason = "业务线程快照位于文件或管道写入，请结合日志和节点磁盘状态检查"
	case strings.Contains(selected, "java.lang.Thread.State: WAITING") || strings.Contains(selected, "java.lang.Thread.State: TIMED_WAITING"):
		reason = "业务线程正在等待线程、任务、信号或定时条件"
	case strings.Contains(selected, "java.lang.Thread.State: RUNNABLE"):
		reason = "业务线程快照处于 RUNNABLE，不能仅凭一次快照认定 CPU 忙等"
	}
	frames := []string{}
	businessFrame := ""
	for _, line := range strings.Split(selected, "\n") {
		frame := strings.TrimSpace(line)
		if !strings.HasPrefix(frame, "at ") {
			continue
		}
		if len(frames) < 4 {
			frames = append(frames, frame)
		} else if className != "" && strings.Contains(frame, className+".") {
			businessFrame = frame
			break
		}
	}
	if businessFrame != "" && !strings.Contains(strings.Join(frames, "\n"), className+".") {
		frames = append(frames, businessFrame)
	}
	if score == 1 {
		reason = strings.Replace(reason, "业务线程", "JVM 主线程", 1)
	}
	return "线程证据：" + reason + "。\n" + strings.Join(frames, "\n") + "\n完整快照见执行机诊断日志；这是现场证据，不代表已确认根因。"
}
