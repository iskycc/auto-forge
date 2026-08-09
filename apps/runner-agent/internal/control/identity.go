package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const identitySchemaVersion = 1

type Identity struct {
	SchemaVersion int    `json:"schemaVersion"`
	RunnerID      string `json:"runnerId"`
	Credential    string `json:"credential"`
	ServerURL     string `json:"serverUrl"`
}

type IdentityStore struct {
	path string
}

func NewIdentityStore(dataDirectory string) IdentityStore {
	return IdentityStore{path: filepath.Join(dataDirectory, "identity", "credentials.json")}
}

func (store IdentityStore) Load() (Identity, bool, error) {
	info, err := os.Lstat(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return Identity{}, false, nil
	}
	if err != nil {
		return Identity{}, false, fmt.Errorf("inspect runner identity: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Identity{}, false, errors.New("runner identity is not a regular file")
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Identity{}, false, errors.New("runner identity permissions must not grant group or other access")
	}
	if info.Size() > 16*1024 {
		return Identity{}, false, errors.New("runner identity exceeds 16 KiB")
	}
	file, err := os.Open(store.path)
	if err != nil {
		return Identity{}, false, fmt.Errorf("open runner identity: %w", err)
	}
	defer file.Close()

	var identity Identity
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&identity); err != nil {
		return Identity{}, false, fmt.Errorf("decode runner identity: %w", err)
	}
	if identity.SchemaVersion != identitySchemaVersion || identity.RunnerID == "" || identity.Credential == "" || identity.ServerURL == "" {
		return Identity{}, false, errors.New("runner identity is incomplete or incompatible")
	}
	return identity, true, nil
}

func (store IdentityStore) Save(identity Identity) error {
	if identity.SchemaVersion != identitySchemaVersion || identity.RunnerID == "" || identity.Credential == "" || identity.ServerURL == "" {
		return errors.New("refuse to save incomplete runner identity")
	}
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create identity directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return fmt.Errorf("secure identity directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".credentials-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary identity: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("secure temporary identity: %w", err)
	}
	encoder := json.NewEncoder(temporary)
	if err := encoder.Encode(identity); err != nil {
		temporary.Close()
		return fmt.Errorf("encode runner identity: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync runner identity: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close runner identity: %w", err)
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("publish runner identity: %w", err)
	}
	if err := os.Chmod(store.path, 0o600); err != nil {
		return fmt.Errorf("secure runner identity: %w", err)
	}
	identityDirectory, err := os.Open(directory)
	if err != nil {
		return fmt.Errorf("open identity directory: %w", err)
	}
	defer identityDirectory.Close()
	if err := identityDirectory.Sync(); err != nil {
		return fmt.Errorf("sync identity directory: %w", err)
	}
	return nil
}
