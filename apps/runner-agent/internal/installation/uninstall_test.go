package installation

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUninstallRemovesManagedFilesAndDataAfterStoppingService(t *testing.T) {
	manager, plan, commands := uninstallFixture(t)
	outside := filepath.Join(t.TempDir(), "keep.txt")
	writeFixture(t, outside, []byte("unrelated"))
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(plan.DataDirectory, "work", "external")); err != nil {
		t.Fatal(err)
	}
	result, err := manager.Execute(context.Background(), "runner-one")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Uninstalled || result.DataDirectoryRetained {
		t.Fatalf("unexpected result: %+v", result)
	}
	for _, path := range []string{plan.DataDirectory, manager.Layout.ConfigurationDirectory, manager.Layout.BinaryPath, manager.Layout.BinaryPath + previousSuffix, manager.Layout.AdapterPath, manager.Layout.ServicePath} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("managed path remains: %s (%v)", path, err)
		}
	}
	if content, err := os.ReadFile(outside); err != nil || string(content) != "unrelated" {
		t.Fatalf("outside data changed: %v", err)
	}
	if len(*commands) < 3 || (*commands)[0] != "stop autoforge-agent.service" {
		t.Fatalf("commands: %v", *commands)
	}
	if _, err := manager.Execute(context.Background(), "runner-one"); err != nil {
		t.Fatalf("repeat uninstall: %v", err)
	}
}

func TestUninstallRejectsWrongIdentityWithoutStoppingService(t *testing.T) {
	manager, _, commands := uninstallFixture(t)
	if _, err := manager.Execute(context.Background(), "other-runner"); err == nil {
		t.Fatal("wrong runner accepted")
	}
	if len(*commands) != 0 {
		t.Fatalf("service was touched: %v", *commands)
	}
}

func TestUninstallFailureRetainsConfigurationAndCanBeRetried(t *testing.T) {
	manager, plan, _ := uninstallFixture(t)
	manager.RunCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("stop failed") }
	if _, err := manager.Execute(context.Background(), "runner-one"); err == nil {
		t.Fatal("stop failure hidden")
	}
	if _, err := os.Stat(plan.DataDirectory); err != nil {
		t.Fatalf("data removed after stop failure: %v", err)
	}
	manager.RunCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	if _, err := manager.Execute(context.Background(), "runner-one"); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
}

func TestUninstallPreservesUnrelatedFilesInSharedDirectories(t *testing.T) {
	manager, plan, _ := uninstallFixture(t)
	unrelated := filepath.Join(plan.DataDirectory, "my-backup.txt")
	writeFixture(t, unrelated, []byte("keep"))
	result, err := manager.Execute(context.Background(), "runner-one")
	if err != nil {
		t.Fatal(err)
	}
	if !result.DataDirectoryRetained {
		t.Fatal("shared directory retention not reported")
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("unrelated file removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(plan.DataDirectory, "identity")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("credentials remain: %v", err)
	}
}

func TestUninstallResumesAfterAStoppedServiceUnitWasAlreadyRemoved(t *testing.T) {
	manager, plan, _ := uninstallFixture(t)
	manager.RunCommand = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "daemon-reload" {
			return nil, errors.New("reload failed")
		}
		return nil, nil
	}
	if _, err := manager.Execute(context.Background(), "runner-one"); err == nil {
		t.Fatal("reload failure hidden")
	}
	if _, err := os.Stat(plan.DataDirectory); err != nil {
		t.Fatalf("data removed before reload succeeded: %v", err)
	}
	manager.RunCommand = func(context.Context, string, ...string) ([]byte, error) { return nil, nil }
	if _, err := manager.Execute(context.Background(), "runner-one"); err != nil {
		t.Fatalf("retry after removed service unit: %v", err)
	}
}

func TestUninstallDoesNotDeleteDataWhenTheServiceUnitIsMissingWithoutAConfirmedStop(t *testing.T) {
	manager, plan, _ := uninstallFixture(t)
	if err := os.Remove(manager.Layout.ServicePath); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Execute(context.Background(), "runner-one"); err == nil {
		t.Fatal("unverified service stop accepted")
	}
	if _, err := os.Stat(plan.DataDirectory); err != nil {
		t.Fatalf("data removed before service stop was verified: %v", err)
	}
}

func TestUninstallRejectsStaleRecoveryStateAfterAnotherAgentWasInstalled(t *testing.T) {
	manager, plan, _ := uninstallFixture(t)
	manager.RunCommand = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "daemon-reload" {
			return nil, errors.New("reload failed")
		}
		return nil, nil
	}
	if _, err := manager.Execute(context.Background(), "runner-one"); err == nil {
		t.Fatal("reload failure hidden")
	}
	identity, err := json.Marshal(map[string]any{"schemaVersion": 1, "runnerId": "replacement-runner", "credential": "replacement-token", "serverUrl": "http://platform.local:3000"})
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(plan.DataDirectory, "identity", "credentials.json"), identity)
	manager.RunCommand = func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("stale uninstall must not change the replacement service")
		return nil, nil
	}
	if _, err := manager.Execute(context.Background(), "runner-one"); err == nil {
		t.Fatal("stale recovery identity accepted")
	}
	if _, err := os.Stat(plan.DataDirectory); err != nil {
		t.Fatalf("replacement data removed: %v", err)
	}
}

func TestUninstallRejectsDangerousAndSymlinkDataRoots(t *testing.T) {
	for _, directory := range []string{"/", "/boot", "/dev", "/sys", "/proc", "/var", "/etc", "/home", "/opt/autoforge", "/var/lib", "relative"} {
		t.Run(directory, func(t *testing.T) {
			if err := validateDataDirectory(directory, SystemLayout()); err == nil {
				t.Fatalf("unsafe directory accepted: %s", directory)
			}
		})
	}
	manager, plan, _ := uninstallFixture(t)
	link := filepath.Join(t.TempDir(), "linked-data")
	if err := os.Symlink(plan.DataDirectory, link); err != nil {
		t.Fatal(err)
	}
	if err := validateDataDirectory(link, manager.Layout); err == nil {
		t.Fatal("symlink root accepted")
	}
}

func uninstallFixture(t *testing.T) (Uninstaller, Plan, *[]string) {
	t.Helper()
	root := t.TempDir()
	layout := Layout{
		ConfigurationDirectory: filepath.Join(root, "etc", "autoforge-agent"),
		BinaryPath:             filepath.Join(root, "opt", "autoforge", "bin", "autoforge-agent"),
		AdapterPath:            filepath.Join(root, "opt", "autoforge", "lib", "cotest-testng-adapter.jar"),
		ServicePath:            filepath.Join(root, "etc", "systemd", "system", "autoforge-agent.service"),
	}
	dataDirectory := filepath.Join(root, "var", "lib", "autoforge-agent")
	configuration, _ := json.Marshal(map[string]any{"schemaVersion": 1, "serverUrl": "http://platform.local:3000", "dataDirectory": dataDirectory})
	writeFixture(t, filepath.Join(layout.ConfigurationDirectory, "config.json"), configuration)
	identity, _ := json.Marshal(map[string]any{"schemaVersion": 1, "runnerId": "runner-one", "credential": "private-token", "serverUrl": "http://platform.local:3000"})
	writeFixture(t, filepath.Join(dataDirectory, "identity", "credentials.json"), identity)
	for _, directory := range []string{"work", "cache", "spool"} {
		writeFixture(t, filepath.Join(dataDirectory, directory, "payload"), []byte("owned"))
	}
	for _, path := range []string{layout.BinaryPath, layout.AdapterPath, layout.ServicePath, layout.BinaryPath + previousSuffix, filepath.Join(layout.ConfigurationDirectory, "control-plane-ca.pem")} {
		writeFixture(t, path, []byte("owned"))
	}
	commands := []string{}
	manager := Uninstaller{Layout: layout, RunCommand: func(_ context.Context, name string, arguments ...string) ([]byte, error) {
		commands = append(commands, strings.Join(arguments, " "))
		return nil, nil
	}}
	plan, err := manager.Inspect("runner-one")
	if err != nil {
		t.Fatal(err)
	}
	return manager, plan, &commands
}

func writeFixture(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}
