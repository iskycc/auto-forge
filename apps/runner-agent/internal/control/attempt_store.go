package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	legacyAttemptStateSchemaVersion = 1
	attemptStateSchemaVersion       = 2
)

var localIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type attemptState struct {
	SchemaVersion   int                   `json:"schemaVersion"`
	Claimed         ClaimedAssignment     `json:"claimed"`
	LocalState      string                `json:"localState"`
	Process         *attemptProcess       `json:"process,omitempty"`
	CompletionID    string                `json:"completionId,omitempty"`
	Result          *completionResult     `json:"result,omitempty"`
	ArtifactUploads []artifactUploadState `json:"artifactUploads,omitempty"`
}

type attemptProcess struct {
	ProcessID      int    `json:"processId"`
	StartTimeTicks uint64 `json:"startTimeTicks"`
}

type artifactUploadState struct {
	Artifact artifactDeclaration `json:"artifact"`
	Uploaded bool                `json:"uploaded"`
}

type attemptStore struct {
	directory string
	budget    *spoolBudget
}

func newAttemptStore(dataDirectory string) attemptStore {
	return attemptStore{directory: filepath.Join(dataDirectory, "spool", "attempts")}
}

func (store attemptStore) save(state attemptState) error {
	if state.SchemaVersion != attemptStateSchemaVersion || !validLocalAttemptState(state.LocalState) || !localIdentifierPattern.MatchString(state.Claimed.Assignment.AttemptID) {
		return errors.New("refuse to save invalid attempt state")
	}
	if !validAttemptProcess(state.Process) {
		return errors.New("refuse to save invalid attempt process identity")
	}
	if err := os.MkdirAll(store.directory, 0o700); err != nil {
		return fmt.Errorf("create attempt spool: %w", err)
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode attempt state: %w", err)
	}
	if len(payload) > 2<<20 {
		return errors.New("attempt state exceeds 2 MiB")
	}
	path := store.path(state.Claimed.Assignment.AttemptID)
	var previousSize int64
	if info, statErr := os.Stat(path); statErr == nil {
		previousSize = info.Size()
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("inspect previous attempt state: %w", statErr)
	}
	newSize := int64(len(payload))
	if err := store.budget.reserve(newSize); err != nil {
		return err
	}
	reserved := newSize > 0
	defer func() {
		if reserved {
			store.budget.release(newSize)
		}
	}()
	temporary, err := os.CreateTemp(store.directory, ".attempt-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary attempt state: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure attempt state: %w", err)
	}
	if _, err := temporary.Write(payload); err != nil {
		temporary.Close()
		return fmt.Errorf("write attempt state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync attempt state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close attempt state: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish attempt state: %w", err)
	}
	reserved = false
	store.budget.release(previousSize)
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("secure attempt state: %w", err)
	}
	directory, err := os.Open(store.directory)
	if err != nil {
		return fmt.Errorf("open attempt spool: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync attempt spool: %w", err)
	}
	return nil
}

func (store attemptStore) list() ([]attemptState, error) {
	states := make([]attemptState, 0)
	if err := store.visitPages(maximumReconcileAttempts, func(page []attemptState) error {
		states = append(states, page...)
		return nil
	}); err != nil {
		return nil, err
	}
	return states, nil
}

// visitPages snapshots only directory entries, then decodes attempt payloads in
// bounded pages. A Runner can accumulate more than one protocol request worth
// of recoverable states when completion uploads are unavailable; startup must
// reconcile those pages instead of refusing to start after an arbitrary count.
func (store attemptStore) visitPages(pageSize int, visit func([]attemptState) error) error {
	if pageSize < 1 {
		return errors.New("attempt spool page size must be positive")
	}
	entries, err := os.ReadDir(store.directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read attempt spool: %w", err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	for offset := 0; offset < len(entries); {
		states := make([]attemptState, 0, pageSize)
		for offset < len(entries) && len(states) < pageSize {
			entry := entries[offset]
			offset++
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			state, loadErr := store.load(entry)
			if loadErr != nil {
				return loadErr
			}
			states = append(states, state)
		}
		if len(states) > 0 {
			if err := visit(states); err != nil {
				return err
			}
		}
	}
	return nil
}

func (store attemptStore) load(entry os.DirEntry) (attemptState, error) {
	path := filepath.Join(store.directory, entry.Name())
	info, statErr := os.Lstat(path)
	if statErr != nil {
		return attemptState{}, fmt.Errorf("inspect attempt state %s: %w", entry.Name(), statErr)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 2<<20 {
		return attemptState{}, fmt.Errorf("attempt state %s is unsafe", entry.Name())
	}
	file, openErr := os.Open(path)
	if openErr != nil {
		return attemptState{}, fmt.Errorf("open attempt state %s: %w", entry.Name(), openErr)
	}
	var state attemptState
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&state)
	if decodeErr == nil {
		var trailing struct{}
		if trailingErr := decoder.Decode(&trailing); !errors.Is(trailingErr, io.EOF) {
			decodeErr = errors.New("attempt state contains trailing JSON data")
		}
	}
	closeErr := file.Close()
	if decodeErr != nil {
		return attemptState{}, fmt.Errorf("decode attempt state %s: %w", entry.Name(), decodeErr)
	}
	if closeErr != nil {
		return attemptState{}, fmt.Errorf("close attempt state %s: %w", entry.Name(), closeErr)
	}
	if !supportedAttemptStateSchemaVersion(state.SchemaVersion) || !validLocalAttemptState(state.LocalState) || store.path(state.Claimed.Assignment.AttemptID) != path {
		return attemptState{}, fmt.Errorf("attempt state %s has an invalid identity", entry.Name())
	}
	if !validAttemptProcess(state.Process) {
		return attemptState{}, fmt.Errorf("attempt state %s has an invalid process identity", entry.Name())
	}
	// Version 1 did not persist process identity. Normalize it in memory so
	// the next state write atomically upgrades the record.
	state.SchemaVersion = attemptStateSchemaVersion
	return state, nil
}

func (store attemptStore) identifiers() (map[string]struct{}, error) {
	entries, err := os.ReadDir(store.directory)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]struct{}{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read attempt spool identities: %w", err)
	}
	identifiers := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		attemptID := strings.TrimSuffix(entry.Name(), ".json")
		if !localIdentifierPattern.MatchString(attemptID) {
			return nil, fmt.Errorf("attempt state %s has an invalid file name", entry.Name())
		}
		identifiers[attemptID] = struct{}{}
	}
	return identifiers, nil
}

func supportedAttemptStateSchemaVersion(version int) bool {
	return version == legacyAttemptStateSchemaVersion || version == attemptStateSchemaVersion
}

func validAttemptProcess(process *attemptProcess) bool {
	return process == nil || (process.ProcessID > 0 && process.StartTimeTicks > 0)
}

func validLocalAttemptState(state string) bool {
	switch state {
	case "claimed", "running", "uploading", "finishing", "completed":
		return true
	default:
		return false
	}
}

func (store attemptStore) remove(attemptID string) error {
	if !localIdentifierPattern.MatchString(attemptID) {
		return errors.New("invalid attempt identifier")
	}
	path := store.path(attemptID)
	info, statErr := os.Stat(path)
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return fmt.Errorf("inspect attempt state: %w", statErr)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove attempt state: %w", err)
	}
	if info != nil {
		store.budget.release(info.Size())
	}
	return nil
}

func (store attemptStore) removeTemporaryFiles() error {
	entries, err := os.ReadDir(store.directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read attempt spool for cleanup: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) == ".json" {
			continue
		}
		path := filepath.Join(store.directory, entry.Name())
		info, statErr := os.Lstat(path)
		if statErr != nil {
			return statErr
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove incomplete attempt state: %w", err)
		}
		store.budget.release(info.Size())
	}
	return nil
}

func (store attemptStore) path(attemptID string) string {
	return filepath.Join(store.directory, attemptID+".json")
}
