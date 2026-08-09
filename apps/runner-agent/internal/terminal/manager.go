package terminal

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

const outputChunkBytes = 16 * 1024

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

type Configuration struct {
	Shell           string
	WorkDirectory   string
	MaxSessions     int
	MaximumDuration time.Duration
}

type Exit struct {
	Code   *int
	Signal string
}

type Events struct {
	Output func([]byte) error
	Exited func(Exit)
}

type Manager struct {
	configuration Configuration
	rootContext   context.Context
	mu            sync.Mutex
	sessions      map[string]*session
}

type session struct {
	id         string
	workDir    string
	command    *exec.Cmd
	pty        *os.File
	cancel     context.CancelFunc
	completed  chan struct{}
	outputDone chan struct{}
	stopOnce   sync.Once
}

func NewManager(rootContext context.Context, configuration Configuration) *Manager {
	return &Manager{
		configuration: configuration,
		rootContext:   rootContext,
		sessions:      make(map[string]*session),
	}
}

func (manager *Manager) Open(sessionID string, columns, rows uint16, events Events) error {
	if !sessionIDPattern.MatchString(sessionID) {
		return errors.New("terminal session ID is invalid")
	}
	if columns < 20 || columns > 500 || rows < 5 || rows > 200 {
		return errors.New("terminal dimensions are outside the allowed range")
	}
	if events.Output == nil || events.Exited == nil {
		return errors.New("terminal event handlers are required")
	}

	manager.mu.Lock()
	if len(manager.sessions) >= manager.configuration.MaxSessions {
		manager.mu.Unlock()
		return errors.New("terminal session limit reached")
	}
	if _, exists := manager.sessions[sessionID]; exists {
		manager.mu.Unlock()
		return errors.New("terminal session already exists")
	}
	workDirectory := filepath.Join(manager.configuration.WorkDirectory, sessionID)
	if err := os.Mkdir(workDirectory, 0o700); err != nil {
		manager.mu.Unlock()
		return fmt.Errorf("create terminal work directory: %w", err)
	}

	sessionContext, cancel := context.WithTimeout(manager.rootContext, manager.configuration.MaximumDuration)
	command := exec.Command(manager.configuration.Shell, "-i")
	command.Dir = workDirectory
	command.Env = safeEnvironment(os.Environ())
	pseudoterminal, err := pty.StartWithSize(command, &pty.Winsize{Cols: columns, Rows: rows})
	if err != nil {
		cancel()
		manager.mu.Unlock()
		_ = os.Remove(workDirectory)
		return fmt.Errorf("start terminal shell: %w", err)
	}
	active := &session{
		id:         sessionID,
		workDir:    workDirectory,
		command:    command,
		pty:        pseudoterminal,
		cancel:     cancel,
		completed:  make(chan struct{}),
		outputDone: make(chan struct{}),
	}
	manager.sessions[sessionID] = active
	manager.mu.Unlock()

	go manager.stopOnContext(sessionContext, active)
	go manager.streamOutput(active, events.Output)
	go manager.wait(active, events.Exited)
	return nil
}

func (manager *Manager) Input(sessionID string, input []byte) error {
	if len(input) == 0 || len(input) > 32*1024 {
		return errors.New("terminal input size is invalid")
	}
	active, err := manager.session(sessionID)
	if err != nil {
		return err
	}
	if _, err := active.pty.Write(input); err != nil {
		return fmt.Errorf("write terminal input: %w", err)
	}
	return nil
}

func (manager *Manager) Resize(sessionID string, columns, rows uint16) error {
	if columns < 20 || columns > 500 || rows < 5 || rows > 200 {
		return errors.New("terminal dimensions are outside the allowed range")
	}
	active, err := manager.session(sessionID)
	if err != nil {
		return err
	}
	if err := pty.Setsize(active.pty, &pty.Winsize{Cols: columns, Rows: rows}); err != nil {
		return fmt.Errorf("resize terminal: %w", err)
	}
	return nil
}

func (manager *Manager) Close(sessionID string) {
	manager.mu.Lock()
	active := manager.sessions[sessionID]
	manager.mu.Unlock()
	if active != nil {
		active.stop()
	}
}

func (manager *Manager) CloseAll() {
	manager.mu.Lock()
	activeSessions := make([]*session, 0, len(manager.sessions))
	for _, active := range manager.sessions {
		activeSessions = append(activeSessions, active)
	}
	manager.mu.Unlock()
	for _, active := range activeSessions {
		active.stop()
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for _, active := range activeSessions {
		select {
		case <-active.completed:
		case <-deadline.C:
			return
		}
	}
}

func (manager *Manager) session(sessionID string) (*session, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	active := manager.sessions[sessionID]
	if active == nil {
		return nil, errors.New("terminal session does not exist")
	}
	return active, nil
}

func (manager *Manager) stopOnContext(ctx context.Context, active *session) {
	select {
	case <-ctx.Done():
		active.stop()
	case <-active.completed:
	}
}

func (manager *Manager) streamOutput(active *session, send func([]byte) error) {
	defer close(active.outputDone)
	buffer := make([]byte, outputChunkBytes)
	for {
		readBytes, err := active.pty.Read(buffer)
		if readBytes > 0 {
			chunk := append([]byte(nil), buffer[:readBytes]...)
			if sendErr := send(chunk); sendErr != nil {
				active.stop()
				return
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed) {
				active.stop()
			}
			return
		}
	}
}

func (manager *Manager) wait(active *session, exited func(Exit)) {
	err := active.command.Wait()
	select {
	case <-active.outputDone:
	case <-time.After(500 * time.Millisecond):
	}
	close(active.completed)
	active.cancel()
	_ = active.pty.Close()

	manager.mu.Lock()
	delete(manager.sessions, active.id)
	manager.mu.Unlock()
	_ = os.RemoveAll(active.workDir)

	result := Exit{}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		code := exitError.ExitCode()
		result.Code = &code
		if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			result.Signal = status.Signal().String()
		}
	} else if err == nil {
		code := 0
		result.Code = &code
	}
	exited(result)
}

func (active *session) stop() {
	active.stopOnce.Do(func() {
		active.cancel()
		_ = active.pty.Close()
		if active.command.Process == nil {
			return
		}
		processGroupID := -active.command.Process.Pid
		_ = syscall.Kill(processGroupID, syscall.SIGTERM)
		timer := time.AfterFunc(2*time.Second, func() {
			_ = syscall.Kill(processGroupID, syscall.SIGKILL)
		})
		go func() {
			<-active.completed
			timer.Stop()
		}()
	})
}

func safeEnvironment(environment []string) []string {
	allowed := map[string]struct{}{
		"HOME": {}, "LANG": {}, "LOGNAME": {}, "PATH": {}, "SHELL": {}, "TMPDIR": {}, "USER": {},
	}
	filtered := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		key, _, exists := strings.Cut(entry, "=")
		_, explicitlyAllowed := allowed[key]
		if exists && (explicitlyAllowed || strings.HasPrefix(key, "LC_")) {
			filtered = append(filtered, entry)
		}
	}
	return append(filtered, "TERM=xterm-256color")
}
