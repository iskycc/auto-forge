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
)

const attemptStateSchemaVersion = 1

var localIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type attemptState struct {
	SchemaVersion int               `json:"schemaVersion"`
	Claimed       ClaimedAssignment `json:"claimed"`
	LocalState    string            `json:"localState"`
	CompletionID  string            `json:"completionId,omitempty"`
	Result        *completionResult `json:"result,omitempty"`
}

type attemptStore struct {
	directory string
}

func newAttemptStore(dataDirectory string) attemptStore {
	return attemptStore{directory: filepath.Join(dataDirectory, "spool", "attempts")}
}

func (store attemptStore) save(state attemptState) error {
	if state.SchemaVersion != attemptStateSchemaVersion || !validLocalAttemptState(state.LocalState) || !localIdentifierPattern.MatchString(state.Claimed.Assignment.AttemptID) {
		return errors.New("refuse to save invalid attempt state")
	}
	if err := os.MkdirAll(store.directory, 0o700); err != nil {
		return fmt.Errorf("create attempt spool: %w", err)
	}
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
	if err := json.NewEncoder(temporary).Encode(state); err != nil {
		temporary.Close()
		return fmt.Errorf("encode attempt state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync attempt state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close attempt state: %w", err)
	}
	path := store.path(state.Claimed.Assignment.AttemptID)
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish attempt state: %w", err)
	}
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
	entries, err := os.ReadDir(store.directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read attempt spool: %w", err)
	}
	if len(entries) > 256 {
		return nil, errors.New("attempt spool exceeds 256 entries")
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Name() < entries[right].Name() })
	states := make([]attemptState, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(store.directory, entry.Name())
		info, statErr := os.Lstat(path)
		if statErr != nil {
			return nil, fmt.Errorf("inspect attempt state %s: %w", entry.Name(), statErr)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 2<<20 {
			return nil, fmt.Errorf("attempt state %s is unsafe", entry.Name())
		}
		file, openErr := os.Open(path)
		if openErr != nil {
			return nil, fmt.Errorf("open attempt state %s: %w", entry.Name(), openErr)
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
			return nil, fmt.Errorf("decode attempt state %s: %w", entry.Name(), decodeErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close attempt state %s: %w", entry.Name(), closeErr)
		}
		if state.SchemaVersion != attemptStateSchemaVersion || !validLocalAttemptState(state.LocalState) || store.path(state.Claimed.Assignment.AttemptID) != path {
			return nil, fmt.Errorf("attempt state %s has an invalid identity", entry.Name())
		}
		states = append(states, state)
	}
	return states, nil
}

func validLocalAttemptState(state string) bool {
	switch state {
	case "claimed", "running", "finishing", "completed":
		return true
	default:
		return false
	}
}

func (store attemptStore) remove(attemptID string) error {
	if !localIdentifierPattern.MatchString(attemptID) {
		return errors.New("invalid attempt identifier")
	}
	if err := os.Remove(store.path(attemptID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove attempt state: %w", err)
	}
	return nil
}

func (store attemptStore) path(attemptID string) string {
	return filepath.Join(store.directory, attemptID+".json")
}
