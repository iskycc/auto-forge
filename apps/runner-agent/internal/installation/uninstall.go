package installation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/iskycc/auto-forge/apps/runner-agent/internal/control"
)

const serviceName = "autoforge-agent.service"
const previousSuffix = ".autoforge-previous"
const stateFileName = "uninstall-state.json"

type installedConfiguration struct {
	SchemaVersion int    `json:"schemaVersion"`
	DataDirectory string `json:"dataDirectory"`
}

type Layout struct {
	ConfigurationDirectory string
	BinaryPath             string
	AdapterPath            string
	ServicePath            string
}

func SystemLayout() Layout {
	return Layout{
		ConfigurationDirectory: "/etc/autoforge-agent",
		BinaryPath:             "/opt/autoforge/bin/autoforge-agent",
		AdapterPath:            "/opt/autoforge/lib/cotest-testng-adapter.jar",
		ServicePath:            "/etc/systemd/system/autoforge-agent.service",
	}
}

type Plan struct {
	SchemaVersion        int    `json:"schemaVersion"`
	RunnerID             string `json:"runnerId"`
	DataDirectory        string `json:"dataDirectory"`
	AlreadyRemoved       bool   `json:"alreadyRemoved"`
	RemoveServiceAccount bool   `json:"removeServiceAccount"`
	ServiceStopped       bool   `json:"serviceStopped"`
}

type Result struct {
	Uninstalled           bool   `json:"uninstalled"`
	DataDirectory         string `json:"dataDirectory"`
	DataDirectoryRetained bool   `json:"dataDirectoryRetained"`
}

type Uninstaller struct {
	Layout     Layout
	RunCommand func(context.Context, string, ...string) ([]byte, error)
}

// Inspect is read-only. The control plane uses it to verify the installed
// identity before revoking the Runner or changing its scheduling state.
func (uninstaller Uninstaller) Inspect(expectedRunnerID string) (Plan, error) {
	layout := uninstaller.Layout
	configurationPath := filepath.Join(layout.ConfigurationDirectory, "config.json")
	var plan Plan
	stateErr := readPrivateJSON(filepath.Join(layout.ConfigurationDirectory, stateFileName), &plan)
	if stateErr == nil {
		if plan.SchemaVersion != 1 {
			return Plan{}, errors.New("unsupported uninstall recovery state")
		}
		if err := uninstaller.validateRecoveryInstallation(plan); err != nil {
			return Plan{}, err
		}
	} else if !errors.Is(stateErr, os.ErrNotExist) {
		return Plan{}, fmt.Errorf("read uninstall recovery state: %w", stateErr)
	} else {
		var configuration installedConfiguration
		if err := readPrivateJSON(configurationPath, &configuration); err != nil {
			if errors.Is(err, os.ErrNotExist) && !uninstaller.hasInstalledFiles() {
				return Plan{AlreadyRemoved: true}, nil
			}
			return Plan{}, fmt.Errorf("read installed Agent configuration: %w", err)
		}
		if configuration.SchemaVersion != 1 {
			return Plan{}, errors.New("unsupported installed Agent configuration")
		}
		plan = Plan{SchemaVersion: 1, DataDirectory: configuration.DataDirectory}
		if err := validateDataDirectory(plan.DataDirectory, layout); err != nil {
			return Plan{}, err
		}
		identity, found, err := control.NewIdentityStore(plan.DataDirectory).Load()
		if err != nil {
			return Plan{}, fmt.Errorf("verify installed Agent identity: %w", err)
		}
		if found {
			plan.RunnerID = identity.RunnerID
		}
		account, lookupErr := user.Lookup("autoforge-agent")
		if lookupErr == nil {
			plan.RemoveServiceAccount = account.Uid != "0" && account.Name == "AutoForge Runner Agent"
		} else if _, missing := lookupErr.(user.UnknownUserError); !missing {
			return Plan{}, fmt.Errorf("inspect Agent service account: %w", lookupErr)
		}
	}
	if expectedRunnerID != "" && plan.RunnerID != expectedRunnerID {
		return Plan{}, errors.New("installed Agent identity does not match the selected Runner; no files were removed")
	}
	if err := validateDataDirectory(plan.DataDirectory, layout); err != nil {
		return Plan{}, err
	}
	if err := rejectNestedMounts(plan.DataDirectory); err != nil {
		return Plan{}, err
	}
	return plan, nil
}

func (uninstaller Uninstaller) validateRecoveryInstallation(plan Plan) error {
	var configuration installedConfiguration
	err := readPrivateJSON(filepath.Join(uninstaller.Layout.ConfigurationDirectory, "config.json"), &configuration)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("verify uninstall recovery configuration: %w", err)
	}
	if err == nil && (configuration.SchemaVersion != 1 || configuration.DataDirectory != plan.DataDirectory) {
		return errors.New("Agent installation changed since uninstall began; refusing to use stale recovery state")
	}
	identity, found, err := control.NewIdentityStore(plan.DataDirectory).Load()
	if err != nil {
		return fmt.Errorf("verify uninstall recovery identity: %w", err)
	}
	if found && identity.RunnerID != plan.RunnerID {
		return errors.New("a different Agent was installed after the interrupted uninstall; no replacement data will be removed")
	}
	return nil
}

func (uninstaller Uninstaller) Execute(ctx context.Context, expectedRunnerID string) (Result, error) {
	plan, err := uninstaller.Inspect(expectedRunnerID)
	if err != nil {
		return Result{}, err
	}
	if plan.AlreadyRemoved {
		return Result{Uninstalled: true}, nil
	}
	if uninstaller.RunCommand == nil {
		return Result{}, errors.New("system service command runner is required")
	}
	// Keep a private recovery record until the final step, so a failure after
	// credential deletion can still validate and finish the same uninstall.
	if err := uninstaller.persistRecoveryState(plan); err != nil {
		return Result{}, err
	}
	if _, err := os.Lstat(uninstaller.Layout.ServicePath); err == nil {
		if err := uninstaller.systemctl(ctx, "stop", serviceName); err != nil {
			return Result{}, err
		}
		if err := uninstaller.systemctl(ctx, "disable", serviceName); err != nil {
			return Result{}, err
		}
		plan.ServiceStopped = true
		if err := uninstaller.persistRecoveryState(plan); err != nil {
			return Result{}, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, fmt.Errorf("inspect Agent service: %w", err)
	} else if !plan.ServiceStopped {
		return Result{}, errors.New("Agent service unit is missing and a prior successful stop cannot be verified; stop the Agent and restore its unit before retrying")
	}
	for _, path := range []string{uninstaller.Layout.ServicePath, uninstaller.Layout.BinaryPath, uninstaller.Layout.AdapterPath} {
		for _, candidate := range []string{path, path + previousSuffix} {
			if err := os.Remove(candidate); err != nil && !errors.Is(err, os.ErrNotExist) {
				return Result{}, fmt.Errorf("remove installed Agent file %s: %w", candidate, err)
			}
		}
	}
	if err := os.RemoveAll(uninstaller.Layout.ServicePath + ".d"); err != nil {
		return Result{}, fmt.Errorf("remove Agent service overrides: %w", err)
	}
	if err := uninstaller.systemctl(ctx, "daemon-reload"); err != nil {
		return Result{}, err
	}
	retained, err := removeAgentData(plan.DataDirectory)
	if err != nil {
		return Result{}, err
	}
	if plan.RemoveServiceAccount {
		if err := uninstaller.removeServiceAccount(ctx); err != nil {
			return Result{}, err
		}
	}
	for _, name := range []string{"config.json", "config.json" + previousSuffix, "control-plane-ca.pem", "control-plane-ca.pem" + previousSuffix, stateFileName} {
		if err := os.Remove(filepath.Join(uninstaller.Layout.ConfigurationDirectory, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return Result{}, fmt.Errorf("remove Agent configuration %s: %w", name, err)
		}
	}
	if err := removeEmptyDirectory(uninstaller.Layout.ConfigurationDirectory); err != nil {
		return Result{}, err
	}
	for _, directory := range []string{filepath.Dir(uninstaller.Layout.BinaryPath), filepath.Dir(uninstaller.Layout.AdapterPath), filepath.Dir(filepath.Dir(uninstaller.Layout.BinaryPath))} {
		if err := removeEmptyDirectory(directory); err != nil {
			return Result{}, err
		}
	}
	return Result{Uninstalled: true, DataDirectory: plan.DataDirectory, DataDirectoryRetained: retained}, nil
}

func (uninstaller Uninstaller) persistRecoveryState(plan Plan) error {
	state, err := json.Marshal(plan)
	if err != nil {
		return fmt.Errorf("encode uninstall recovery state: %w", err)
	}
	if err := os.WriteFile(filepath.Join(uninstaller.Layout.ConfigurationDirectory, stateFileName), state, 0o600); err != nil {
		return fmt.Errorf("persist uninstall recovery state: %w", err)
	}
	return nil
}

func (uninstaller Uninstaller) systemctl(ctx context.Context, arguments ...string) error {
	output, err := uninstaller.RunCommand(ctx, "systemctl", arguments...)
	if err != nil {
		return fmt.Errorf("systemctl %s failed: %w (%s)", strings.Join(arguments, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (uninstaller Uninstaller) hasInstalledFiles() bool {
	for _, path := range []string{uninstaller.Layout.BinaryPath, uninstaller.Layout.AdapterPath, uninstaller.Layout.ServicePath} {
		for _, candidate := range []string{path, path + previousSuffix} {
			if _, err := os.Lstat(candidate); !errors.Is(err, os.ErrNotExist) {
				return true
			}
		}
	}
	return false
}

func readPrivateJSON(path string, target any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > 1<<20 {
		return fmt.Errorf("%s must be a private regular file no larger than 1 MiB", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("expected a single JSON document")
	}
	return nil
}

func validateDataDirectory(directory string, layout Layout) error {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return errors.New("Agent data directory must be a clean absolute path")
	}
	if len(strings.Split(strings.Trim(directory, string(os.PathSeparator)), string(os.PathSeparator))) < 2 {
		return fmt.Errorf("refuse to remove top-level system directory %s", directory)
	}
	for _, protected := range []string{"/", "/var", "/var/lib", "/etc", "/home", "/root", "/tmp", "/opt", "/usr", "/run", "/mnt", "/data", "/srv", "/opt/autoforge"} {
		if directory == protected {
			return fmt.Errorf("refuse to remove protected data directory %s", directory)
		}
	}
	for _, path := range []string{layout.ConfigurationDirectory, layout.BinaryPath, layout.AdapterPath, layout.ServicePath} {
		if path == directory || strings.HasPrefix(path, directory+string(os.PathSeparator)) {
			return errors.New("Agent data directory overlaps installation or system configuration")
		}
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("resolve Agent data directory: %w", err)
	}
	if err == nil && resolved != directory {
		return errors.New("Agent data directory must not contain symlink components")
	}
	return nil
}

func removeAgentData(directory string) (bool, error) {
	root, err := os.OpenRoot(directory)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("open Agent data directory: %w", err)
	}
	defer root.Close()
	// Only these namespaces belong to the Agent. os.Root confines traversal;
	// RemoveAll unlinks workspace symlinks without following their targets.
	for _, name := range []string{"identity", "spool", "work", "cache"} {
		if err := root.RemoveAll(name); err != nil {
			return false, fmt.Errorf("remove Agent %s: %w", name, err)
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return false, fmt.Errorf("inspect remaining Agent data: %w", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".write-probe-") {
			if err := root.RemoveAll(entry.Name()); err != nil {
				return false, err
			}
		}
	}
	entries, err = os.ReadDir(directory)
	if err != nil {
		return false, err
	}
	if len(entries) > 0 {
		return true, nil
	}
	if err := os.Remove(directory); err != nil {
		if errors.Is(err, syscall.EBUSY) {
			return true, nil
		}
		return true, fmt.Errorf("remove empty Agent data directory: %w", err)
	}
	return false, nil
}

func (uninstaller Uninstaller) removeServiceAccount(ctx context.Context) error {
	if account, err := user.Lookup("autoforge-agent"); err == nil {
		if account.Uid == "0" || account.Name != "AutoForge Runner Agent" {
			return errors.New("Agent service account changed during uninstall; refusing to remove it")
		}
		if output, err := uninstaller.RunCommand(ctx, "userdel", "autoforge-agent"); err != nil {
			return fmt.Errorf("remove Agent service account: %w (%s)", err, strings.TrimSpace(string(output)))
		}
	} else if _, missing := err.(user.UnknownUserError); !missing {
		return fmt.Errorf("inspect Agent service account: %w", err)
	}
	if _, err := user.LookupGroup("autoforge-agent"); err == nil {
		if output, err := uninstaller.RunCommand(ctx, "groupdel", "autoforge-agent"); err != nil {
			return fmt.Errorf("remove Agent service group: %w (%s)", err, strings.TrimSpace(string(output)))
		}
	} else if _, missing := err.(user.UnknownGroupError); !missing {
		return fmt.Errorf("inspect Agent service group: %w", err)
	}
	return nil
}

func removeEmptyDirectory(path string) error {
	entries, err := os.ReadDir(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect empty installation directory %s: %w", path, err)
	}
	if len(entries) > 0 {
		return nil
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("remove empty installation directory %s: %w", path, err)
	}
	return nil
}

func rejectNestedMounts(directory string) error {
	content, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return fmt.Errorf("inspect mounted filesystems before uninstall: %w", err)
	}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		mount := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`).Replace(fields[4])
		if strings.HasPrefix(mount, directory+"/") {
			return fmt.Errorf("nested mount %s must be unmounted before deleting Agent data", mount)
		}
	}
	return nil
}
